/**
 * OpenRecallClient — the zero-knowledge sync client.
 *
 * Wraps the crypto + the HTTP sync contract so callers (the openclaude shim,
 * the MCP server, the CLI) work in plaintext and never touch ciphertext or the
 * wire format. Encryption/decryption happen in-process with a key derived from
 * the passphrase, which never leaves the machine.
 *
 * Every request is bounded: no call waits longer than `timeoutMs`
 * (default {@link DEFAULT_TIMEOUT_MS}, 120s) for the server to answer.
 *
 *   const client = new OpenRecallClient({ url, apiKey, passphrase })
 *   await client.push('user:me', { 'MEMORY.md': '# index...' })
 *   const { entries } = await client.pull('user:me')
 */

import { ciphertextHash, decryptEntry, deriveKey, encryptEntry } from './crypto.ts'
import { enforce, type Finding, type ScanMode } from './secretscan.ts'

export type OpenRecallClientOptions = {
  /** Base URL, e.g. https://memory.twigpine.com (no trailing slash needed). */
  url: string
  /** API key (Bearer). Omit only against an ALLOW_UNAUTHENTICATED self-host. */
  apiKey?: string
  /** Passphrase the encryption key is derived from. Never sent to the server. */
  passphrase: string
  /**
   * Secret-scan policy applied to plaintext before encryption. Default `block`
   * (refuse to upload entries that look like they contain live credentials).
   */
  scanMode?: ScanMode
  /** Called with findings in `warn` mode (default logs to console.warn). */
  onScanWarning?: (findings: Finding[]) => void
  /**
   * How long any single request may take, in milliseconds. Default
   * {@link DEFAULT_TIMEOUT_MS} (120s).
   */
  timeoutMs?: number
  /**
   * Transport override (default: global `fetch`). Local mode uses this to
   * serve requests in-process from an encrypted store on disk, with no server.
   */
  fetch?: FetchLike
}

/** The subset of `fetch` the client needs. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type PullResult = {
  namespace: string
  version: number
  /** entryKey -> decrypted plaintext */
  entries: Record<string, string>
  /**
   * entryKey -> ISO 8601 timestamp of the entry's last write, as recorded by
   * the server's own manifest. Empty when the server does not send the field,
   * which is what an older server looks like.
   *
   * Required rather than optional on purpose: it makes the compiler find every
   * stand-in for this client, so a test double cannot quietly omit the field
   * and diverge from what the real client returns.
   *
   * This is the one value here the crypto does not vouch for. Ciphertext is
   * bound to its entry key by the GCM AAD and checksums are recomputed
   * locally, but a timestamp is whatever the server says it is, so `pull`
   * sanitizes it rather than trusting the shape. Note it is not covered by
   * `namespaceChecksum` either, which is computed over entry checksums alone:
   * a server can rewrite every timestamp and nothing here detects it.
   *
   * Values are `string | undefined` deliberately. A key can be absent (an
   * older server, a partial map, an entry whose blob drifted), and typing it
   * as bare `string` would let a consumer index a missing key, get `undefined`
   * at runtime, and see `string` at the type level. `noUncheckedIndexedAccess`
   * is off in this project, so the union is what forces the absent case to be
   * handled.
   */
  updatedAt: Record<string, string | undefined>
}

export type PushResult = {
  namespace: string
  version: number
  /** Keys the server actually stored. A key it refused is not in here. */
  uploaded: string[]
  unchanged: string[]
  deleted: string[]
  /**
   * What the server refused, verbatim from its response: an invalid key, bad
   * base64, an oversized entry. This client always sets it (empty when nothing
   * was refused); it is optional only so a test double or a server predating
   * the field does not have to carry one. A caller reporting a push as saved
   * has to consult it, or it reports a refusal as success.
   */
  skipped?: { key: string; reason: string }[]
}

/**
 * A body that would not decrypt with this client's key.
 *
 * Without a type for it, a caller sees one Error for a wrong passphrase, a
 * truncated response and a dropped socket alike, so a preflight check has no
 * honest way to say which happened and defaults to blaming the passphrase.
 */
export class OpenRecallDecryptError extends Error {
  constructor(
    readonly entryKey: string,
    readonly namespace: string,
    readonly reason: string,
  ) {
    super(`openrecall: could not decrypt "${entryKey}" in ${namespace}: ${reason}`)
    this.name = 'OpenRecallDecryptError'
  }
}

/**
 * What one namespace's reads and writes have taught this client.
 *
 * `hashes` is entryKey -> the ciphertext hash this client last saw it hold.
 * `enumerated` says whether the source listed the namespace authoritatively,
 * which decides what a key's ABSENCE from the map is allowed to mean.
 */
type Observed = {
  hashes: Record<string, string>
  enumerated: boolean
}

/** One answered request: the status line plus the body, already read. */
type Answer = { ok: boolean; status: number; statusText: string; raw: string }

/**
 * A refusal from the server, carrying what it actually said.
 *
 * `code` is the server's own error code and `details` its payload, so a caller
 * can tell a stale write from a bad key from a quota breach, and a stale write
 * names the keys that moved.
 */
export class OpenRecallHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'OpenRecallHttpError'
  }
}

/**
 * The server accepted the connection and then did not answer in time.
 *
 * Its own class for the same reason the two above have one: a caller that
 * cannot tell a silent server from a refusal or a dropped socket has to guess,
 * and the MCP preflight guesses wrong in the most confusing direction. This one
 * says the connection was made and the answer never came.
 */
export class OpenRecallTimeoutError extends Error {
  constructor(
    readonly operation: string,
    readonly namespace: string,
    readonly timeoutMs: number,
  ) {
    super(`openrecall: ${operation} for ${namespace} got no answer within ${timeoutMs}ms`)
    this.name = 'OpenRecallTimeoutError'
  }
}

/**
 * The server answered 2xx with a body that is not the view that was asked for.
 *
 * A broken or misrouted server, or an older one that ignores a `view` it does
 * not know and answers with the full namespace instead. Its own class so a
 * caller can fall back to the older read it does understand, and so it is never
 * confused with a decryption failure, which is the one error a caller is
 * entitled to blame on the passphrase.
 */
export class OpenRecallProtocolError extends Error {
  constructor(
    readonly operation: string,
    readonly namespace: string,
    detail: string,
  ) {
    super(`openrecall: ${operation} for ${namespace}: ${detail}`)
    this.name = 'OpenRecallProtocolError'
  }
}

/**
 * Default per-request budget, in milliseconds.
 *
 * Sized off the largest legitimate transfer rather than off a typical one: a
 * namespace caps at 2000 entries and 10 MB, which is roughly 13 MB of base64 on
 * the wire, so 120s leaves a working-but-slow link about 110 KB/s before this
 * cuts it. The tradeoff to know about: `AbortSignal.timeout` measures TOTAL
 * elapsed time, not idle time, so a genuinely slow big transfer is aborted even
 * while it is still making progress. That is the price of not having to track
 * per-chunk arrival; a caller on a link that slow should raise `timeoutMs`.
 */
export const DEFAULT_TIMEOUT_MS = 120_000

/**
 * How many namespaces the per-namespace caches keep.
 *
 * Both maps key on a namespace the caller names, and every MCP tool takes that
 * as a model-supplied argument in a process that lives as long as the agent
 * session, so an unbounded map grows on model whim. 64 is far beyond what a
 * real session touches (a handful: `user:me`, a repo, maybe an agent) while
 * bounding resident key material to 64 keys. Eviction costs nothing but work:
 * a dropped `keyCache` entry is re-derived, and a dropped `observed` entry
 * sends the namespace's next write down the unconditional path a namespace
 * this client has never read already takes.
 */
export const MAX_TRACKED_NAMESPACES = 64

/**
 * Write through an LRU map, evicting the least recently used past the cap.
 *
 * Insertion order is the recency order, and the delete before the set is what
 * makes a re-touched key young again. There is deliberately no read-side
 * counterpart: every path that reads either map goes on to write it back
 * through here, so a plain `get` cannot leave a live entry looking stale.
 */
function lruSet<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_TRACKED_NAMESPACES) {
    const oldest = map.keys().next()
    if (oldest.done) break
    map.delete(oldest.value)
  }
}

/**
 * Keep only the timestamps that are safe to act on: an own string property
 * whose key is an entry we actually decrypted.
 *
 * Iterating the DECRYPTED keys rather than the server's map is what does the
 * work. A hostile or broken server can send extra keys, a prototype-polluting
 * key, a bare string, an array, or numbers instead of dates, and none of it
 * survives, because the only keys ever looked up are ones the caller already
 * holds plaintext for. That also bounds the result: the map cannot be larger
 * than the namespace, however large the response was.
 *
 * `Object.hasOwn` rather than an index test, matching the entry lookup in
 * src/mcp/tools.ts: a key like `__proto__` or `toString` must miss, never
 * resolve to something off the prototype.
 *
 * The VALUE is bounded here too, not just the key space. An earlier version
 * accepted any string and documented that callers should treat an unparseable
 * one as absent, which is the wrong place to put the rule: this function is
 * the only trust boundary the datum crosses, so every future caller would have
 * had to re-implement the same check or silently act on junk. Measured, a
 * 20,000,000-character "timestamp" passed through unaltered. A length cap plus
 * a parse check closes that by construction and costs nothing.
 *
 * Still NOT validated, and not knowable client-side: whether the server is
 * telling the TRUTH. A well-formed timestamp is accepted whatever it claims,
 * and nothing in the response authenticates it, so a hostile server can order
 * a caller's results at will within the shapes this function admits.
 */
const MAX_TIMESTAMP_CHARS = 32

function sanitizeUpdatedAt(raw: unknown, entries: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object') return out
  const src = raw as Record<string, unknown>
  for (const entryKey of Object.keys(entries)) {
    if (!Object.hasOwn(src, entryKey)) continue
    const value = src[entryKey]
    if (typeof value !== 'string' || value.length > MAX_TIMESTAMP_CHARS) continue
    if (!Number.isFinite(Date.parse(value))) continue
    out[entryKey] = value
  }
  return out
}

export class OpenRecallClient {
  /**
   * What this client has learned about each namespace, from reads the caller
   * asked for and from its own successful writes. No entry at all means this
   * client has never touched the namespace, and a first write into one is
   * deliberately unconditional.
   *
   * The `enumerated` flag is the part that matters. A `hashes` read returns the
   * manifest's checksums entire, so a key missing from it provably does not
   * exist and a later write may assert that absence with a null base. A `pull`
   * cannot make that claim: the server skips an entry whose blob has gone from
   * both `content.entries` and `content.entryChecksums`, so a key can be in the
   * manifest and invisible to the read. A pull therefore records only what it
   * decrypted, and a key it did not see is unknown rather than absent. Asserting
   * absence from a pull locked a drifted key out of every future write, since
   * the server refused the null base and re-pulling could never clear it.
   *
   * Deliberately not filled by `push`'s internal pre-flight read: that happens
   * milliseconds before the PUT, so a base taken from it would guard a window
   * that barely exists while the real one, the caller's turn between reading an
   * entry and writing it back, stayed open.
   *
   * LRU-bounded at MAX_TRACKED_NAMESPACES. Losing an entry costs the guarantee
   * for that namespace, never correctness: the code below reads this map in
   * exactly two places, `baseFor` and `delete`, and both already have a
   * no-entry branch, because a namespace this client has never touched has none
   * either. So an evicted namespace's next write is unconditional, which is
   * what a first write already is, and the write after that is armed again.
   */
  private readonly observed = new Map<string, Observed>()

  private readonly url: string
  private readonly apiKey?: string
  private readonly passphrase: string
  private readonly scanMode: ScanMode
  private readonly onScanWarning?: (findings: Finding[]) => void
  private readonly timeoutMs: number
  /** Derived keys, LRU-bounded: see MAX_TRACKED_NAMESPACES. */
  private readonly keyCache = new Map<string, Buffer>()
  private readonly fetch: FetchLike

  constructor(opts: OpenRecallClientOptions) {
    this.url = opts.url.replace(/\/$/, '')
    this.apiKey = opts.apiKey
    this.passphrase = opts.passphrase
    this.scanMode = opts.scanMode ?? 'block'
    this.onScanWarning = opts.onScanWarning
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetch = opts.fetch ?? ((input, init) => fetch(input, init))
  }

  private key(namespace: string): Buffer {
    let k = this.keyCache.get(namespace)
    if (!k) {
      k = deriveKey(this.passphrase, namespace)
    }
    lruSet(this.keyCache, namespace, k)
    return k
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...extra,
    }
  }

  private endpoint(namespace: string): string {
    return `${this.url}/api/memory/${encodeURIComponent(namespace)}`
  }

  /**
   * Every request this client makes, on a clock.
   *
   * The body is read HERE, inside the timed region, rather than handed back as
   * a stream: `AbortSignal.timeout` covers the body as well as the headers, so
   * a server that sends a status and then stalls mid-body would otherwise
   * reject out of a `res.json()` at the call site, past the point where the
   * abort could still be recognised and typed. Reading it once also matches
   * what `httpError` needs, which is why it takes the text rather than the
   * Response.
   */
  private async request(
    operation: string,
    namespace: string,
    url: string,
    init?: RequestInit,
  ): Promise<Answer> {
    try {
      const res = await this.fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) })
      // A body that fails to read for any other reason still yields an Answer,
      // so a refusal whose body is unreadable stays an OpenRecallHttpError with
      // an empty text rather than becoming a bare transport throw. Only the
      // timeout is allowed past, because typing it is the point.
      const raw = await res.text().catch((err: unknown) => {
        if ((err as Error)?.name === 'TimeoutError') throw err
        return ''
      })
      return { ok: res.ok, status: res.status, statusText: res.statusText, raw }
    } catch (err) {
      // What `AbortSignal.timeout` rejects with. A caller-supplied abort or a
      // dropped socket is a different name and stays untouched, so the class
      // means exactly one thing.
      if ((err as Error)?.name === 'TimeoutError')
        throw new OpenRecallTimeoutError(operation, namespace, this.timeoutMs)
      throw err
    }
  }

  /**
   * Fetch per-key ciphertext checksums (no bodies). Empty if namespace is new.
   *
   * By default the checksums become this client's base for later writes: they
   * ARE the manifest's checksums, and a base is a ciphertext hash, so the read
   * is exact for the precondition even though it carries no bodies. A caller
   * that only wants the key names (a listing shown to a model) passes
   * `observe: false`. Rebasing there would let a save computed from an older
   * read pass the precondition against whatever landed since, which is the lost
   * update the precondition exists to refuse.
   */
  async hashes(
    namespace: string,
    opts: { observe?: boolean } = {},
  ): Promise<Record<string, string>> {
    return (await this.hashesAndSupports(namespace, opts)).checksums
  }

  /**
   * `hashes`, plus the capabilities the server advertised on the same read, so
   * a caller that wants both (the MCP startup check) does not ask twice.
   */
  async hashesAndSupports(
    namespace: string,
    opts: { observe?: boolean } = {},
  ): Promise<{ checksums: Record<string, string>; supports: string[] }> {
    const { entryChecksums: checksums, supports } = await this.hashesView(namespace)
    if (opts.observe !== false) {
      lruSet(this.observed, namespace, { hashes: { ...checksums }, enumerated: true })
    }
    return { checksums, supports }
  }

  /**
   * The raw hashes view, without recording what it saw. `push` uses this for
   * its delta computation, which must not count as the caller having read the
   * namespace; see `observed`.
   */
  private async hashesView(
    namespace: string,
  ): Promise<{ version: number; entryChecksums: Record<string, string>; supports: string[] }> {
    const res = await this.request('hashes', namespace, `${this.endpoint(namespace)}?view=hashes`, {
      headers: this.headers(),
    })
    if (res.status === 404) {
      const err = httpError(res)
      // Only the server's own "this namespace has nothing yet" is emptiness.
      // Any other 404 is a wrong URL or something in front of the server, and
      // reporting it as an empty namespace is a denial rendered as success.
      if (err.code !== 'empty') throw err
      return { version: 0, entryChecksums: {}, supports: [] }
    }
    if (!res.ok) throw httpError(res)
    const data = JSON.parse(res.raw) as {
      version?: number
      entryChecksums?: Record<string, string>
      supports?: string[]
    }
    return {
      version: data.version ?? 0,
      entryChecksums: data.entryChecksums ?? {},
      supports: data.supports ?? [],
    }
  }

  /** Pull and decrypt all entries for a namespace. */
  async pull(namespace: string): Promise<PullResult> {
    const res = await this.request('pull', namespace, this.endpoint(namespace), {
      headers: this.headers(),
    })
    if (res.status === 404) {
      const err = httpError(res)
      // See hashesView: only the server's own `empty` is an empty namespace.
      if (err.code !== 'empty') throw err
      // Enumerated, unlike every other pull: `empty` means no manifest exists,
      // so there is no entry a drifted blob could have hidden. A create after
      // this can therefore assert absence rather than overwrite blindly.
      lruSet(this.observed, namespace, { hashes: {}, enumerated: true })
      return { namespace, version: 0, entries: {}, updatedAt: {} }
    }
    if (!res.ok) throw httpError(res)
    const data = JSON.parse(res.raw) as {
      version: number
      content?: { entries?: Record<string, string>; entryUpdatedAt?: unknown }
    }
    // Pre-existing gap, closed here because this method now hardens the sibling
    // field against exactly this class and leaving the container unchecked
    // would be inconsistent. A 200 whose body is missing `content.entries`
    // used to throw a raw TypeError out of Object.entries; it fails closed
    // either way, but a protocol error names what went wrong.
    const entriesRaw = data.content?.entries
    if (!entriesRaw || typeof entriesRaw !== 'object') {
      throw new OpenRecallProtocolError(
        'pull',
        namespace,
        `${res.status} ${res.statusText}: malformed body (no content.entries)`,
      )
    }
    const key = this.key(namespace)
    const entries: Record<string, string> = {}
    // The base is derived from the bodies rather than the response's checksum
    // map, so it reflects what was actually decrypted here. This is a read the
    // caller asked for, so it is what a later write's base is measured
    // against, but positive knowledge only, hence `enumerated: false`; see
    // `observed`.
    const seen: Record<string, string> = {}
    for (const [entryKey, b64] of Object.entries(entriesRaw)) {
      try {
        entries[entryKey] = decryptEntry(key, entryKey, b64)
      } catch (err) {
        throw new OpenRecallDecryptError(entryKey, namespace, (err as Error).message)
      }
      seen[entryKey] = ciphertextHash(b64)
    }
    lruSet(this.observed, namespace, { hashes: seen, enumerated: false })
    return {
      namespace,
      version: data.version,
      entries,
      updatedAt: sanitizeUpdatedAt(data.content?.entryUpdatedAt, entries),
    }
  }

  /**
   * Pull and decrypt ONE entry.
   *
   * The bounded counterpart to `pull`, for a caller that needs one thing about
   * a namespace and should not have to ship up to 10 MB (roughly 13 MB of
   * base64) to learn it. The MCP startup preflight is the caller that needs
   * this, so an agent session does not pay a full namespace read before its
   * first tool call.
   *
   * Every refusal reaches the caller as an `OpenRecallHttpError`, including both
   * 404s. `pull` translates the server's `empty` into an empty result because a
   * namespace with nothing in it is a legitimate answer to "give me everything";
   * there is no such answer to "give me this key", and returning an empty
   * string for a namespace or a key that does not exist is a denial rendered as
   * success. The caller separates them on `code`: `empty` (no namespace),
   * `entry_not_found` (namespace yes, key no), `entry_unreadable` (the manifest
   * names it, the store cannot produce it).
   *
   * What it records, which is the part worth reading: exactly one key's
   * ciphertext hash, merged into whatever this client already knew, with
   * `enumerated` left alone. Reading one entry is positive knowledge about that
   * key and nothing at all about any other, so it may arm the write
   * precondition for that key and must never let a write assert some other
   * key's ABSENCE. See `observed`, where the same distinction cost a drifted
   * key every future write.
   */
  async entry(namespace: string, entryKey: string): Promise<string> {
    const res = await this.request(
      'entry',
      namespace,
      `${this.endpoint(namespace)}?view=entry&key=${encodeURIComponent(entryKey)}`,
      { headers: this.headers() },
    )
    if (!res.ok) throw httpError(res)
    const data = JSON.parse(res.raw) as { entry?: unknown }
    // A 200 whose body is not this view's is a broken or misrouted server, and
    // it must not be handed to decryptEntry: that would raise a
    // OpenRecallDecryptError, which is the one failure a caller is entitled to
    // blame on the passphrase.
    if (typeof data.entry !== 'string')
      throw new OpenRecallProtocolError(
        'entry',
        namespace,
        `no entry in the response for "${entryKey}"`,
      )
    let plaintext: string
    try {
      plaintext = decryptEntry(this.key(namespace), entryKey, data.entry)
    } catch (err) {
      throw new OpenRecallDecryptError(entryKey, namespace, (err as Error).message)
    }
    this.record(namespace, { [entryKey]: data.entry }, [])
    return plaintext
  }

  /**
   * Encrypt + delta-push entries. Only entries whose ciphertext differs from
   * the server's are uploaded (deterministic encryption makes this stable).
   */
  async push(
    namespace: string,
    entries: Record<string, string>,
    opts?: { deletions?: string[] },
  ): Promise<PushResult> {
    // Defense in depth: scan plaintext for secrets BEFORE it is encrypted and
    // leaves the machine. `block` throws; `warn` reports and proceeds.
    const findings = enforce(entries, this.scanMode)
    if (findings.length) {
      if (this.onScanWarning) this.onScanWarning(findings)
      else
        console.warn(
          `[openrecall] ${findings.length} potential secret(s) in pushed memory (scan=warn)`,
        )
    }

    const key = this.key(namespace)
    const view = await this.hashesView(namespace)
    const serverHashes = view.entryChecksums

    const toUpload: Record<string, string> = {}
    const uploaded: string[] = []
    const unchanged: string[] = []
    for (const [entryKey, plaintext] of Object.entries(entries)) {
      const b64 = encryptEntry(key, entryKey, plaintext)
      if (serverHashes[entryKey] === ciphertextHash(b64)) {
        unchanged.push(entryKey)
        continue
      }
      toUpload[entryKey] = b64
      uploaded.push(entryKey)
    }

    const deletions = opts?.deletions ?? []
    if (uploaded.length === 0 && deletions.length === 0) {
      // Nothing to do. The version comes from the read above rather than a
      // second request: asking again cost a round trip on the commonest write
      // an agent makes, and that second read had its own 404 rule.
      return { namespace, version: view.version, uploaded, unchanged, deleted: [], skipped: [] }
    }

    const sent = this.baseFor(namespace, [...uploaded, ...deletions])
    const res = await this.request('push', namespace, this.endpoint(namespace), {
      method: 'PUT',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ entries: toUpload, deletions, ...(sent ?? {}) }),
    })
    if (!res.ok) throw httpError(res, sent?.base)
    const result = JSON.parse(res.raw) as {
      version: number
      deleted: string[]
      skipped?: { key: string; reason: string }[]
    }
    // A key the server refused was never stored, so folding its hash into
    // `observed` would make the next write send a base for content that does
    // not exist and take a 409 for a race nobody ran. Filtering on `skipped`
    // rather than intersecting `accepted` keeps this right against a server
    // that does not report `accepted` at all.
    const skipped = result.skipped ?? []
    const refused = new Set(skipped.map(s => s.key))
    const stored: Record<string, string> = {}
    for (const [k, b64] of Object.entries(toUpload)) if (!refused.has(k)) stored[k] = b64
    this.record(
      namespace,
      stored,
      deletions.filter(k => !refused.has(k)),
    )
    return {
      namespace,
      version: result.version,
      uploaded: uploaded.filter(k => !refused.has(k)),
      unchanged,
      deleted: result.deleted ?? [],
      skipped,
    }
  }

  /** Delete one entry. */
  async delete(namespace: string, entryKey: string): Promise<void> {
    const observed = this.observed.get(namespace)
    const seen =
      observed && Object.hasOwn(observed.hashes, entryKey) ? observed.hashes[entryKey] : undefined
    if (!seen && observed?.enumerated) {
      // This client has enumerated the namespace and the key was not in it, so
      // the delete must assert that absence exactly as a push would. DELETE
      // cannot carry it: the server reads `base` off the query string and
      // accepts only a sha256:<hex> there, with no spelling for null. The PUT
      // body already takes a JSON null, so route it through that instead of
      // sending an unconditional delete that would destroy a competing write.
      const sent = { [entryKey]: null }
      const res = await this.request('delete', namespace, this.endpoint(namespace), {
        method: 'PUT',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ entries: {}, deletions: [entryKey], base: sent }),
      })
      if (!res.ok) throw httpError(res, sent)
      // The PUT route answers 200 and lists a key it refused in `skipped`, where
      // the DELETE route answers with an error. Report it the same way.
      const refused = (
        JSON.parse(res.raw) as { skipped?: { key: string; reason: string }[] }
      ).skipped?.find(s => s.key === entryKey)
      if (refused) {
        throw new OpenRecallHttpError(
          `openrecall 400: ${flattenServerText(refused.reason, 80)}`,
          400,
          'invalid_key',
          { sentBase: sent },
        )
      }
      this.record(namespace, {}, [entryKey])
      return
    }
    const q = seen ? `&base=${encodeURIComponent(seen)}` : ''
    const res = await this.request(
      'delete',
      namespace,
      `${this.endpoint(namespace)}?key=${encodeURIComponent(entryKey)}${q}`,
      { method: 'DELETE', headers: this.headers() },
    )
    if (!res.ok) throw httpError(res, seen ? { [entryKey]: seen } : undefined)
    this.record(namespace, {}, [entryKey])
  }

  /**
   * The base to send for the keys a write touches, or nothing when this client
   * has not touched the namespace. Sending no base is unconditional, which is
   * what a first write into a namespace nobody has read should be.
   *
   * A key the map holds sends its hash. A key it does not hold sends `null`,
   * asserting the key does not exist, ONLY when the map came from an
   * enumeration; otherwise the key is omitted, because this client cannot
   * honestly claim something it never enumerated is absent. Omitting every key
   * leaves an empty base, which is the same claim as no base at all.
   */
  private baseFor(
    namespace: string,
    keys: string[],
  ): { base: Record<string, string | null> } | null {
    const observed = this.observed.get(namespace)
    if (!observed || keys.length === 0) return null
    const base: Record<string, string | null> = {}
    for (const k of keys) {
      const hash = Object.hasOwn(observed.hashes, k) ? observed.hashes[k] : undefined
      if (hash !== undefined) base[k] = hash
      else if (observed.enumerated) base[k] = null
    }
    if (Object.keys(base).length === 0) return null
    return { base }
  }

  /**
   * Fold a successful write into what this client has observed.
   *
   * Creates the map when there is none: a write is itself knowledge of what the
   * namespace holds. Without it a client that only ever wrote would never arm
   * the precondition, and its SECOND push would silently clobber whatever had
   * landed in between. The new map is not enumerated, since a write says
   * nothing about the keys it did not touch.
   */
  private record(namespace: string, written: Record<string, string>, deleted: string[]): void {
    let observed = this.observed.get(namespace)
    if (!observed) observed = { hashes: {}, enumerated: false }
    lruSet(this.observed, namespace, observed)
    for (const [k, b64] of Object.entries(written)) observed.hashes[k] = ciphertextHash(b64)
    for (const k of deleted) delete observed.hashes[k]
  }
}

/**
 * `sentBase` is what THIS client wrote against, which the server's payload
 * cannot supply: a refusal reports only what each key holds now. Without it a
 * caller can say what changed but not what it was working from, and the tool
 * text needs both.
 */
function httpError(res: Answer, sentBase?: Record<string, string | null>): OpenRecallHttpError {
  let code = 'unknown'
  let details: Record<string, unknown> | undefined
  // The body was read ONCE, in `request`. Reading a Response twice (json(), then
  // text() for the non-JSON fallback) hits an already-consumed body and renders
  // every non-JSON refusal as a bare status with no detail.
  const raw = res.raw
  try {
    const body = JSON.parse(raw) as {
      error?: { code?: string; details?: Record<string, unknown> }
    }
    if (body.error?.code) code = body.error.code
    details = body.error?.details
  } catch {
    // Not JSON. The raw text is the only thing there is to report.
  }
  return new OpenRecallHttpError(
    `openrecall ${res.status} ${flattenServerText(res.statusText)}: ${flattenServerText(raw)}`,
    res.status,
    code,
    sentBase ? { ...details, sentBase } : details,
  )
}

/**
 * Bound and de-fang text the server chose, before it lands in `Error.message`.
 *
 * That message is rendered into a model's context by the MCP tools, so a
 * hostile or merely broken server could otherwise plant an escape sequence, a
 * fake instruction, or a megabyte of anything there. Only the human-readable
 * message is treated this way: `code` and `details` stay verbatim, because they
 * are the machine-readable half and a caller matches on them.
 */
export function flattenServerText(text: string, max = 200): string {
  const clean = text
    // ANSI sequences whole, so stripping ESC does not leave `[31m` behind.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > max ? `${clean.slice(0, max)}...` : clean
}

export { ciphertextHash, decryptEntry, deriveKey, encryptEntry } from './crypto.ts'
export {
  type Finding,
  type ScanMode,
  SecretFoundError,
  scanEntries,
  scanEntry,
} from './secretscan.ts'
