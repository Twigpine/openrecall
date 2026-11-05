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

import { createHash } from 'node:crypto'
import {
  ciphertextHash,
  ciphertextHashBytes,
  decryptEntry,
  decryptEntryBytes,
  deriveKey,
  encryptEntry,
} from './crypto.ts'
import { decodeFrames, FRAMES_HEADER, type Frame } from './frames.ts'
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
  /**
   * Keep decrypted entries in memory between pulls, keyed by entry key and
   * ciphertext hash, so a pull decrypts only what changed since the last one.
   * Off by default for the library, since a long-lived process that pulls many
   * namespaces would otherwise hold their plaintext resident without asking;
   * the CLI and the MCP server turn it on. Bounded at MAX_TRACKED_NAMESPACES
   * namespaces, each holding exactly its live entries.
   */
  cache?: boolean
  /**
   * An on-disk store of ciphertext blobs plus a manifest of keys, hashes,
   * sizes and timestamps, never plaintext and never an index. With one, a
   * pull fetches only the entries whose ciphertext is not already on disk,
   * and `pull(ns, { allowStale: true })` can answer from it when the server
   * cannot be reached. See {@link MirrorStore}.
   */
  mirror?: MirrorStore
}

/** The subset of `fetch` the client needs. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * One namespace's mirror manifest: what the mirror held after the last pull
 * that reached the server. Keys, hashes, sizes and timestamps only, the same
 * metadata the server itself sees; the bodies are the blobs, by hash.
 */
export type MirrorManifest = {
  namespace: string
  version: number
  /** The namespace checksum over `entries`, as the server computes it. */
  checksum: string
  /** ISO 8601 of the pull this manifest was written by; `staleMs` counts from it. */
  fetchedAt: string
  entries: Record<string, { hash: string; updatedAt?: string; size: number }>
}

/**
 * Where a client keeps ciphertext between processes.
 *
 * Content-addressed: a blob is named by its own `sha256:<hex>`, so a blob can
 * never be stale, only unreferenced, and the client verifies the digest on
 * every read before it trusts a body (a mismatch is deleted and refetched).
 * The interface is deliberately small and failure-tolerant in the client: a
 * store that throws or returns null is treated as a miss, never as an error,
 * because a cache that can fail a read is not a cache.
 */
export interface MirrorStore {
  readManifest(namespace: string): Promise<MirrorManifest | null>
  writeManifest(namespace: string, manifest: MirrorManifest): Promise<void>
  getBlob(namespace: string, hash: string): Promise<Uint8Array | null>
  putBlob(namespace: string, hash: string, bytes: Uint8Array): Promise<void>
  deleteBlob(namespace: string, hash: string): Promise<void>
  /** Every blob hash the mirror holds for the namespace, as `sha256:<hex>`. */
  listBlobs(namespace: string): Promise<string[]>
}

export type PullOptions = {
  /**
   * When the server cannot be reached (a timeout or a transport failure, never
   * an HTTP refusal: a 401, 403, 429 or 5xx is an answer and is reported as
   * one), answer from the mirror instead and say so in `served`. Off by
   * default: a caller that reads in order to write must not build on a
   * namespace the server may have moved on from.
   */
  allowStale?: boolean
}

/** What a bulk `entries` read returned, decrypted, with one status per key asked for. */
export type EntriesResult = {
  /** entryKey -> plaintext, for the keys that came back `ok`. */
  entries: Record<string, string>
  /** entryKey -> ciphertext hash, for the same keys. */
  hashes: Record<string, string>
  /** entryKey -> ISO 8601 per the server's manifest, where it gave one. */
  updatedAt: Record<string, string | undefined>
  /** entryKey -> `ok`, `not_found`, `unreadable` or `invalid_key`, for every key asked for. */
  statuses: Record<string, string>
}

/**
 * Where a pull's time went, in milliseconds, for the tool layer's per-stage
 * timings: the round trips (the hashes view, then whatever bodies had to be
 * fetched, plus any read from the on-disk mirror), the JSON or frame decode,
 * and the AES-GCM pass over the entries this call actually decrypted. `bytes`
 * is the size of every response body the call read. Optional on the result:
 * a test double need not produce it, and a caller that does not look is not
 * charged for it.
 */
export type ReadTimings = { fetchMs: number; parseMs: number; decryptMs: number; bytes: number }

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
  /**
   * entryKey -> the ciphertext hash each returned entry was decrypted from.
   * A fingerprint for a caller keeping an index over the entries: it changes
   * exactly when the content does. Optional, like every field added after
   * the first release, so a test double need not carry it.
   */
  hashes?: Record<string, string>
  /**
   * Where the answer came from. `server` is the normal case. `mirror` means
   * the server could not be reached, the caller allowed a stale answer, and
   * this is what the on-disk mirror held as of `staleMs` milliseconds ago;
   * see {@link PullOptions}.
   */
  served?: { source: 'server' | 'mirror'; staleMs: number }
  /** Stage timings of this read; see {@link ReadTimings}. */
  timings?: ReadTimings
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

export type DeleteResult = {
  namespace: string
  version: number
  /** False when the namespace had no such entry (the delete was a no-op). */
  deleted: boolean
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

/** The hashes view, parsed, plus whether it was the server's own `empty`. */
type HashesView = {
  version: number
  entryChecksums: Record<string, string>
  entryUpdatedAt: unknown
  supports: string[]
  empty: boolean
  bytes: number
}

/** A decrypted entry held in memory: its plaintext and its ciphertext size. */
type Cached = { plaintext: string; size: number }

/** What a pull holds for one key while it assembles its answer. */
type Held = {
  hash: string
  size: number
  plaintext?: string
  bytes?: Uint8Array
  /** Fetched from the server this call, so the mirror does not have it yet. */
  fresh?: boolean
}
type Fresh = Held & { bytes: Uint8Array }

/** The running stage totals of one read; becomes its `timings`. */
type Clock = { fetchMs: number; parseMs: number; decryptMs: number; bytes: number }

/** The in-memory cache's key: the entry key and the hash it was decrypted from. */
function cacheKey(entryKey: string, hash: string): string {
  return `${hash} ${entryKey}`
}

/**
 * How many keys one bulk read names. The server caps a request at the
 * namespace entry cap (2,000); half of that keeps a request body and its
 * answer a size a slow link finishes inside the per-request timeout.
 */
const MAX_ENTRIES_BATCH = 1000

/**
 * Up to how many changed keys are read one at a time against a server that
 * has the single-entry view and not the bulk one. Past this the full view is
 * cheaper than the round trips.
 */
const MAX_SINGLE_READS = 25

/** Mirror blob writes in flight at once; see FsBlobStore's temp-name note. */
const MIRROR_WRITE_CONCURRENCY = 16

/** Every this-many pulls, the mirror drops blobs no manifest references. */
const MIRROR_GC_EVERY = 32

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
   * exist and a later write may assert that absence with a null base. The
   * full-view `pull` cannot make that claim: the server skips an entry whose
   * blob has gone from both `content.entries` and `content.entryChecksums`, so
   * a key can be in the manifest and invisible to the read. That pull therefore
   * records only what it decrypted, and a key it did not see is unknown rather
   * than absent. Asserting absence from it locked a drifted key out of every
   * future write, since the server refused the null base and re-pulling could
   * never clear it.
   *
   * The incremental pull (every server that advertises `entry-view` or
   * `entries-view`) starts from the hashes view, so it DOES enumerate, and it
   * records the manifest's own checksums rather than what it decrypted. That
   * is a deliberate upgrade over the full view's `enumerated: false`, and the
   * old lockout cannot recur through it: a drifted key is still in the hashes
   * view with its manifest hash, so the base sent for it is that hash, which
   * the server accepts, and a null base is only ever sent for a key the
   * manifest does not name at all. Against a server advertising neither view
   * the pull is the full view and records exactly as before.
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
  /**
   * Decrypted entries by namespace, then by `cacheKey(entryKey, hash)`, so a
   * pull decrypts only the keys whose ciphertext hash moved. Keyed on the
   * entry key as well as the hash on purpose: the cipher binds a body to its
   * key through the GCM additional data, and a map keyed on the hash alone
   * would let a server that listed one key under another key's hash have the
   * wrong plaintext served without the cipher ever being asked. Rebuilt on
   * every pull to hold exactly the live entries, and LRU-bounded across
   * namespaces like the other two maps. Empty, and never written, unless
   * `cache: true` was given.
   */
  private readonly plaintext = new Map<string, Map<string, Cached>>()
  private readonly cacheEnabled: boolean
  private readonly mirror?: MirrorStore
  /** Pulls made through this client, for the mirror's collection cadence. */
  private pulls = 0

  constructor(opts: OpenRecallClientOptions) {
    this.url = opts.url.replace(/\/$/, '')
    this.apiKey = opts.apiKey
    this.passphrase = opts.passphrase
    this.scanMode = opts.scanMode ?? 'block'
    this.onScanWarning = opts.onScanWarning
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetch = opts.fetch ?? ((input, init) => fetch(input, init))
    this.cacheEnabled = opts.cache ?? false
    this.mirror = opts.mirror
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
   * `request`, for a body that is bytes rather than text: the frames view.
   * The same clock and the same timeout mapping. A refusal's body is read as
   * text so `httpError` can report what the server said, exactly as for the
   * JSON routes; a success's body is handed back untouched.
   */
  private async requestBytes(
    operation: string,
    namespace: string,
    url: string,
    init?: RequestInit,
  ): Promise<Answer & { bytes: Uint8Array; headers: Headers }> {
    try {
      const res = await this.fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) })
      const buf = await res.arrayBuffer().catch((err: unknown) => {
        if ((err as Error)?.name === 'TimeoutError') throw err
        return new ArrayBuffer(0)
      })
      const bytes = new Uint8Array(buf)
      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        raw: res.ok ? '' : new TextDecoder().decode(bytes),
        bytes,
        headers: res.headers,
      }
    } catch (err) {
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
  private async hashesView(namespace: string): Promise<HashesView> {
    const res = await this.request('hashes', namespace, `${this.endpoint(namespace)}?view=hashes`, {
      headers: this.headers(),
    })
    if (res.status === 404) {
      const err = httpError(res)
      // Only the server's own "this namespace has nothing yet" is emptiness.
      // Any other 404 is a wrong URL or something in front of the server, and
      // reporting it as an empty namespace is a denial rendered as success.
      if (err.code !== 'empty') throw err
      return {
        version: 0,
        entryChecksums: {},
        entryUpdatedAt: undefined,
        supports: [],
        empty: true,
        bytes: res.raw.length,
      }
    }
    if (!res.ok) throw httpError(res)
    const data = JSON.parse(res.raw) as {
      version?: number
      entryChecksums?: Record<string, string>
      entryUpdatedAt?: unknown
      supports?: string[]
    }
    // Rebuilt from own string properties, as `sanitizeUpdatedAt` does for the
    // timestamps: the map becomes this client's write base and the keys it
    // asks the server for, so a prototype-polluting key or a non-string
    // value must not survive the parse.
    const entryChecksums: Record<string, string> = {}
    const raw = data.entryChecksums
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const k of Object.keys(raw)) {
        const v = raw[k]
        if (typeof v === 'string') entryChecksums[k] = v
      }
    }
    return {
      version: data.version ?? 0,
      entryChecksums,
      entryUpdatedAt: data.entryUpdatedAt,
      supports: Array.isArray(data.supports)
        ? data.supports.filter(s => typeof s === 'string')
        : [],
      empty: false,
      bytes: res.raw.length,
    }
  }

  /**
   * Pull and decrypt all entries for a namespace.
   *
   * Incremental. The hashes view says what the namespace holds, by ciphertext
   * hash; everything whose hash this client already holds decrypted (the
   * in-memory cache) or holds as ciphertext (the mirror) is reused, and only
   * the rest is fetched, through the bulk entries view where the server has
   * it, the single-entry view for a handful of keys where it has only that,
   * and the full JSON view otherwise. So a warm pull of an unchanged namespace
   * costs one bodyless round trip and no decryption at all, and a changed one
   * costs that plus the changed entries. Against a server that advertises no
   * view at all the body read is the full view it has always been.
   *
   * With `allowStale` and a mirror, a server that cannot be reached is answered
   * from the mirror; see {@link PullOptions} for what "cannot be reached"
   * excludes.
   */
  async pull(namespace: string, opts: PullOptions = {}): Promise<PullResult> {
    const clock: Clock = { fetchMs: 0, parseMs: 0, decryptMs: 0, bytes: 0 }
    let view: HashesView
    const started = performance.now()
    try {
      view = await this.hashesView(namespace)
    } catch (err) {
      clock.fetchMs += performance.now() - started
      if (opts.allowStale && this.mirror && isUnreachable(err)) {
        const stale = await this.pullFromMirror(namespace, clock)
        if (stale) return stale
      }
      throw err
    }
    clock.fetchMs += performance.now() - started
    clock.bytes += view.bytes

    if (view.empty) {
      // Enumerated, unlike the full view: `empty` means no manifest exists, so
      // there is no entry a drifted blob could have hidden. A create after
      // this can therefore assert absence rather than overwrite blindly.
      lruSet(this.observed, namespace, { hashes: {}, enumerated: true })
      this.remember(namespace, new Map())
      await this.mirrorWrite(namespace, 0, [], {})
      return {
        namespace,
        version: 0,
        entries: {},
        updatedAt: {},
        hashes: {},
        served: { source: 'server', staleMs: 0 },
        timings: clock,
      }
    }

    const key = this.key(namespace)
    const cache = this.cacheFor(namespace)
    const legacy = !view.supports.includes('entries-view') && !view.supports.includes('entry-view')
    // What this call ends up holding, by key: the hash it was decrypted from
    // and, for a body fetched or read from disk this call, that body.
    const held = new Map<string, Held>()
    // The manifest's word on each key, adjusted by what the body reads said.
    const live: Record<string, string> = { ...view.entryChecksums }
    const stamps: Record<string, unknown>[] = []
    if (view.entryUpdatedAt !== undefined)
      stamps.push(view.entryUpdatedAt as Record<string, unknown>)

    let need: string[] = []
    for (const [entryKey, hash] of Object.entries(view.entryChecksums)) {
      const hit = cache?.get(cacheKey(entryKey, hash))
      if (hit) held.set(entryKey, { hash, size: hit.size, plaintext: hit.plaintext })
      else need.push(entryKey)
    }

    // Ciphertext already on disk, verified against its name before it is
    // trusted. Counted as fetch time: it is where the bytes came from.
    if (need.length > 0 && this.mirror) {
      const t = performance.now()
      const rest: string[] = []
      for (const entryKey of need) {
        const hash = view.entryChecksums[entryKey] as string
        const bytes = await this.mirrorRead(namespace, hash)
        if (bytes) held.set(entryKey, { hash, size: bytes.byteLength, bytes })
        else rest.push(entryKey)
      }
      need = rest
      clock.fetchMs += performance.now() - t
    }

    let enumerated = !legacy
    let version = view.version
    if (need.length > 0) {
      if (view.supports.includes('entries-view')) {
        const frames = await this.fetchFrames(namespace, need, clock)
        if (frames === null) {
          // The namespace vanished between the two reads. Nothing it listed
          // can be held, and nothing can be asserted about it either.
          for (const k of need) delete live[k]
        } else {
          // One map for every frame's timestamp, prototype-less because the
          // keys are the server's. Sanitized once below, with the view's.
          const fromFrames = Object.create(null) as Record<string, unknown>
          for (const f of frames) {
            const k = f.meta.key
            if (f.meta.status === 'ok' && f.meta.hash) {
              held.set(k, {
                hash: f.meta.hash,
                size: f.bytes.byteLength,
                bytes: f.bytes,
                fresh: true,
              })
              live[k] = f.meta.hash
              if (f.meta.updatedAt !== null) fromFrames[k] = f.meta.updatedAt
            } else if (f.meta.status === 'not_found') {
              delete live[k]
            }
            // `unreadable` and `invalid_key` keep the manifest's hash: the key
            // exists, this client just has no body for it.
          }
          stamps.push(fromFrames)
        }
      } else if (view.supports.includes('entry-view') && need.length <= MAX_SINGLE_READS) {
        let fallBack = false
        for (const k of need) {
          try {
            const one = await this.entryRaw(namespace, k, clock)
            if (one.status === 'ok') {
              held.set(k, {
                hash: one.hash,
                size: one.bytes.byteLength,
                bytes: one.bytes,
                fresh: true,
              })
              live[k] = one.hash
            } else if (one.status === 'gone') {
              delete live[k]
            }
          } catch (err) {
            // A server that advertised the view and answered something else:
            // fall back to the read every server understands.
            if (err instanceof OpenRecallProtocolError) {
              fallBack = true
              break
            }
            throw err
          }
        }
        if (fallBack) {
          const full = await this.pullFull(namespace, cache, held, live, clock)
          version = full.version
          stamps.push(full.stamps)
          enumerated = false
        }
      } else {
        const full = await this.pullFull(namespace, cache, held, live, clock)
        version = full.version
        stamps.push(full.stamps)
        enumerated = false
      }
    }

    // The one AES pass, over exactly the bodies that were not already
    // plaintext. A failure here is the one error a caller may blame on the
    // passphrase, so it is raised only out of a decryption and nowhere else.
    this.decryptHeld(namespace, key, held, clock)

    const entries: Record<string, string> = {}
    const hashes: Record<string, string> = {}
    const next = new Map<string, Cached>()
    for (const [entryKey, h] of held) {
      if (h.plaintext === undefined) continue
      entries[entryKey] = h.plaintext
      hashes[entryKey] = h.hash
      next.set(cacheKey(entryKey, h.hash), { plaintext: h.plaintext, size: h.size })
    }
    const updatedAt: Record<string, string> = {}
    for (const stamp of stamps) Object.assign(updatedAt, sanitizeUpdatedAt(stamp, entries))

    this.remember(namespace, next)
    // The legacy path records what it decrypted, exactly as the full view
    // always has; the incremental path records the manifest. See `observed`.
    lruSet(this.observed, namespace, {
      hashes: enumerated ? live : { ...hashes },
      enumerated,
    })
    await this.mirrorWrite(
      namespace,
      version,
      [...held.values()].filter(h => h.fresh && h.bytes) as Fresh[],
      manifestRows(held, updatedAt),
    )

    return {
      namespace,
      version,
      entries,
      updatedAt,
      hashes,
      served: { source: 'server', staleMs: 0 },
      timings: clock,
    }
  }

  /**
   * The full JSON view, as every server serves it. Bodies this client already
   * holds decrypted are matched by hash and not decrypted again; the rest are
   * handed back as bytes for the one decrypt pass in `pull`.
   */
  private async pullFull(
    namespace: string,
    cache: Map<string, Cached> | undefined,
    held: Map<string, Held>,
    live: Record<string, string>,
    clock: Clock,
  ): Promise<{ version: number; stamps: Record<string, unknown> }> {
    const t = performance.now()
    const res = await this.request('pull', namespace, this.endpoint(namespace), {
      headers: this.headers(),
    })
    clock.fetchMs += performance.now() - t
    clock.bytes += res.raw.length
    if (res.status === 404) {
      const err = httpError(res)
      // See hashesView: only the server's own `empty` is an empty namespace.
      if (err.code !== 'empty') throw err
      for (const k of Object.keys(live)) delete live[k]
      held.clear()
      return { version: 0, stamps: {} }
    }
    if (!res.ok) throw httpError(res)
    const parseStarted = performance.now()
    const data = JSON.parse(res.raw) as {
      version: number
      content?: { entries?: Record<string, string>; entryUpdatedAt?: unknown }
    }
    clock.parseMs += performance.now() - parseStarted
    // A 200 whose body is missing `content.entries` used to throw a raw
    // TypeError out of Object.entries; it fails closed either way, but a
    // protocol error names what went wrong.
    const entriesRaw = data.content?.entries
    if (!entriesRaw || typeof entriesRaw !== 'object') {
      throw new OpenRecallProtocolError(
        'pull',
        namespace,
        `${res.status} ${res.statusText}: malformed body (no content.entries)`,
      )
    }
    // The full view is the whole truth about what can be served: anything held
    // from an earlier step that it does not carry is not in this answer.
    held.clear()
    for (const [entryKey, b64] of Object.entries(entriesRaw)) {
      if (typeof b64 !== 'string') continue
      const bytes = new Uint8Array(Buffer.from(b64, 'base64'))
      const hash = ciphertextHashBytes(bytes)
      const hit = cache?.get(cacheKey(entryKey, hash))
      held.set(
        entryKey,
        hit
          ? { hash, size: hit.size, plaintext: hit.plaintext }
          : { hash, size: bytes.byteLength, bytes, fresh: true },
      )
      live[entryKey] = hash
    }
    const stamps = data.content?.entryUpdatedAt
    return {
      version: data.version,
      stamps: stamps && typeof stamps === 'object' ? (stamps as Record<string, unknown>) : {},
    }
  }

  /**
   * The bulk entries view, in batches of at most MAX_ENTRIES_BATCH keys,
   * every frame checked before it is believed: the body must be the frames
   * view (not a JSON answer from something that ignored the query), it must
   * decode, every frame must answer a key that was asked for, and an `ok`
   * frame's bytes must hash to the hash it claims. Each of those is a protocol
   * error, never a decryption failure. Null when the server says the namespace
   * no longer exists at all.
   */
  private async fetchFrames(
    namespace: string,
    keys: string[],
    clock: Clock,
  ): Promise<Frame[] | null> {
    const out: Frame[] = []
    for (let i = 0; i < keys.length; i += MAX_ENTRIES_BATCH) {
      const batch = keys.slice(i, i + MAX_ENTRIES_BATCH)
      const t = performance.now()
      const res = await this.requestBytes(
        'entries',
        namespace,
        `${this.endpoint(namespace)}?view=entries`,
        {
          method: 'POST',
          headers: this.headers({ 'content-type': 'application/json' }),
          body: JSON.stringify({ keys: batch }),
        },
      )
      clock.fetchMs += performance.now() - t
      clock.bytes += res.bytes.byteLength
      if (!res.ok) {
        const err = httpError(res)
        if (res.status === 404 && err.code === 'empty') return null
        throw err
      }
      if (res.headers.get(FRAMES_HEADER) !== '1') {
        throw new OpenRecallProtocolError('entries', namespace, 'the answer is not an entries view')
      }
      const parseStarted = performance.now()
      let decoded: ReturnType<typeof decodeFrames>
      try {
        decoded = decodeFrames(res.bytes)
      } catch (err) {
        throw new OpenRecallProtocolError('entries', namespace, (err as Error).message)
      }
      clock.parseMs += performance.now() - parseStarted
      const asked = new Set(batch)
      for (const f of decoded.frames) {
        if (!asked.has(f.meta.key)) {
          throw new OpenRecallProtocolError(
            'entries',
            namespace,
            `the answer names a key that was not asked for: "${flattenServerText(f.meta.key, 120)}"`,
          )
        }
        if (f.meta.status === 'ok') {
          if (f.meta.hash === null || ciphertextHashBytes(f.bytes) !== f.meta.hash) {
            throw new OpenRecallProtocolError(
              'entries',
              namespace,
              `the body served for "${flattenServerText(f.meta.key, 120)}" does not match its hash`,
            )
          }
        }
        out.push(f)
      }
    }
    return out
  }

  /**
   * Pull and decrypt the entries a caller names, through the bulk view.
   *
   * The bounded counterpart to `pull` for more than one key: a caller that
   * already knows which keys it wants (from a hashes read, say) gets exactly
   * those, with a status per key, and never the rest of the namespace. What
   * it records is what `entry` records, per key: positive knowledge about
   * the keys that came back `ok`, nothing about any other, and `enumerated`
   * untouched.
   */
  async entries(namespace: string, keys: string[]): Promise<EntriesResult> {
    const clock: Clock = { fetchMs: 0, parseMs: 0, decryptMs: 0, bytes: 0 }
    const frames = await this.fetchFrames(namespace, keys, clock)
    const result: EntriesResult = { entries: {}, hashes: {}, updatedAt: {}, statuses: {} }
    if (frames === null) {
      for (const k of keys) result.statuses[k] = 'not_found'
      return result
    }
    const key = this.key(namespace)
    const stamps: Record<string, unknown> = {}
    const seen: Record<string, string> = {}
    for (const f of frames) {
      const k = f.meta.key
      result.statuses[k] = f.meta.status
      if (f.meta.status !== 'ok' || f.meta.hash === null) continue
      try {
        result.entries[k] = decryptEntryBytes(key, k, f.bytes)
      } catch (err) {
        throw new OpenRecallDecryptError(k, namespace, (err as Error).message)
      }
      result.hashes[k] = f.meta.hash
      seen[k] = f.meta.hash
      if (f.meta.updatedAt !== null) stamps[k] = f.meta.updatedAt
    }
    result.updatedAt = sanitizeUpdatedAt(stamps, result.entries)
    this.record(namespace, seen, [])
    return result
  }

  /**
   * Answer a pull from the mirror alone. Null when there is nothing on disk
   * for the namespace, so the caller reports the server failure it got. What
   * it records is not enumerated: the manifest on disk is this client's
   * memory of the server, not the server.
   */
  private async pullFromMirror(namespace: string, clock: Clock): Promise<PullResult | null> {
    const mirror = this.mirror
    if (!mirror) return null
    const t = performance.now()
    const m = await this.mirrorTry(() => mirror.readManifest(namespace))
    if (!m || m.namespace !== namespace || !m.entries || typeof m.entries !== 'object') return null
    const key = this.key(namespace)
    const cache = this.cacheFor(namespace)
    const held = new Map<string, Held>()
    const stamps: Record<string, unknown> = {}
    for (const entryKey of Object.keys(m.entries)) {
      const row = m.entries[entryKey]
      if (!row || typeof row.hash !== 'string') continue
      if (typeof row.updatedAt === 'string') stamps[entryKey] = row.updatedAt
      const hit = cache?.get(cacheKey(entryKey, row.hash))
      if (hit) {
        held.set(entryKey, { hash: row.hash, size: hit.size, plaintext: hit.plaintext })
        continue
      }
      const bytes = await this.mirrorRead(namespace, row.hash)
      if (bytes) held.set(entryKey, { hash: row.hash, size: bytes.byteLength, bytes })
    }
    clock.fetchMs += performance.now() - t
    this.decryptHeld(namespace, key, held, clock)

    const entries: Record<string, string> = {}
    const hashes: Record<string, string> = {}
    const next = new Map<string, Cached>()
    for (const [entryKey, h] of held) {
      if (h.plaintext === undefined) continue
      entries[entryKey] = h.plaintext
      hashes[entryKey] = h.hash
      next.set(cacheKey(entryKey, h.hash), { plaintext: h.plaintext, size: h.size })
    }
    this.remember(namespace, next)
    lruSet(this.observed, namespace, { hashes: { ...hashes }, enumerated: false })
    const fetched = Date.parse(m.fetchedAt)
    const staleMs = Number.isFinite(fetched) ? Math.max(0, Date.now() - fetched) : 0
    return {
      namespace,
      version: typeof m.version === 'number' ? m.version : 0,
      entries,
      updatedAt: sanitizeUpdatedAt(stamps, entries),
      hashes,
      served: { source: 'mirror', staleMs },
      timings: clock,
    }
  }

  /**
   * Decrypt every held body that is not already plaintext, in place. Timed
   * only when there is something to decrypt, so a pull that reused everything
   * reports a decrypt stage of exactly zero rather than the cost of a loop
   * that did nothing.
   */
  private decryptHeld(namespace: string, key: Buffer, held: Map<string, Held>, clock: Clock): void {
    const t = performance.now()
    let decrypted = 0
    for (const [entryKey, h] of held) {
      if (h.plaintext !== undefined || !h.bytes) continue
      try {
        h.plaintext = decryptEntryBytes(key, entryKey, h.bytes)
      } catch (err) {
        throw new OpenRecallDecryptError(entryKey, namespace, (err as Error).message)
      }
      decrypted += 1
    }
    if (decrypted > 0) clock.decryptMs += performance.now() - t
  }

  /** The namespace's plaintext cache, when caching is on. */
  private cacheFor(namespace: string): Map<string, Cached> | undefined {
    return this.cacheEnabled ? this.plaintext.get(namespace) : undefined
  }

  /** Replace the namespace's plaintext cache with exactly what a pull holds. */
  private remember(namespace: string, next: Map<string, Cached>): void {
    if (this.cacheEnabled) lruSet(this.plaintext, namespace, next)
  }

  /** A mirror call that can only ever miss: a throw is a null. */
  private async mirrorTry<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn()
    } catch {
      return null
    }
  }

  /**
   * A blob from the mirror, verified against its name. A mismatch (a bit
   * flipped on disk, a partial write that somehow landed) is deleted so the
   * next pull refetches it, and reported as a miss.
   */
  private async mirrorRead(namespace: string, hash: string): Promise<Uint8Array | null> {
    const mirror = this.mirror
    if (!mirror) return null
    const bytes = await this.mirrorTry(() => mirror.getBlob(namespace, hash))
    if (!bytes) return null
    if (ciphertextHashBytes(bytes) !== hash) {
      await this.mirrorTry(() => mirror.deleteBlob(namespace, hash))
      return null
    }
    return bytes
  }

  /**
   * Record a server-backed pull on disk: the bodies fetched this call, then
   * the manifest that names everything held. Blobs before the manifest, as
   * the server commits, so a crash between the two leaves unreferenced blobs
   * rather than a manifest naming bodies that are not there. Every
   * MIRROR_GC_EVERY pulls the blobs no manifest references are deleted, so a
   * namespace that keeps changing does not keep every ciphertext it ever held.
   */
  private async mirrorWrite(
    namespace: string,
    version: number,
    fresh: Fresh[],
    rows: MirrorManifest['entries'],
  ): Promise<void> {
    const mirror = this.mirror
    if (!mirror) return
    await mapLimit(fresh, MIRROR_WRITE_CONCURRENCY, h =>
      this.mirrorTry(() => mirror.putBlob(namespace, h.hash, h.bytes)),
    )
    const hashes: Record<string, string> = {}
    for (const [k, row] of Object.entries(rows)) hashes[k] = row.hash
    const manifest: MirrorManifest = {
      namespace,
      version,
      checksum: namespaceChecksum(hashes),
      fetchedAt: new Date().toISOString(),
      entries: rows,
    }
    await this.mirrorTry(() => mirror.writeManifest(namespace, manifest))
    if (++this.pulls % MIRROR_GC_EVERY !== 0) return
    const referenced = new Set(Object.values(hashes))
    const onDisk = (await this.mirrorTry(() => mirror.listBlobs(namespace))) ?? []
    for (const hash of onDisk) {
      if (!referenced.has(hash)) await this.mirrorTry(() => mirror.deleteBlob(namespace, hash))
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
   *
   * `observe: false` reads without recording, as `hashes` offers. The MCP
   * save reads the stored note before it writes (to carry its stamps
   * forward), and that read must not rebase the write: a save computed from
   * what this session read earlier has to be refused when the note moved
   * since, and recording the fresh hash here would make the stale base match.
   */
  async entry(
    namespace: string,
    entryKey: string,
    opts: { observe?: boolean } = {},
  ): Promise<string> {
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
    if (opts.observe !== false)
      this.record(namespace, { [entryKey]: ciphertextHash(data.entry) }, [])
    return plaintext
  }

  /**
   * The single-entry view as `pull` uses it for a handful of changed keys
   * against a server that has that view and not the bulk one: ciphertext
   * bytes, not plaintext, so the one decrypt pass in `pull` covers it, and
   * the two 404s and the drift 503 are answers rather than throws, since a
   * key that went missing between the hashes view and this read is not a
   * failed pull.
   */
  private async entryRaw(
    namespace: string,
    entryKey: string,
    clock: Clock,
  ): Promise<
    | { status: 'ok'; hash: string; bytes: Uint8Array }
    | { status: 'gone' }
    | { status: 'unreadable' }
  > {
    const t = performance.now()
    const res = await this.request(
      'entry',
      namespace,
      `${this.endpoint(namespace)}?view=entry&key=${encodeURIComponent(entryKey)}`,
      { headers: this.headers() },
    )
    clock.fetchMs += performance.now() - t
    clock.bytes += res.raw.length
    if (!res.ok) {
      const err = httpError(res)
      if (res.status === 404 && (err.code === 'empty' || err.code === 'entry_not_found'))
        return { status: 'gone' }
      if (res.status === 503 && err.code === 'entry_unreadable') return { status: 'unreadable' }
      throw err
    }
    const parseStarted = performance.now()
    const data = JSON.parse(res.raw) as { entry?: unknown }
    clock.parseMs += performance.now() - parseStarted
    if (typeof data.entry !== 'string')
      throw new OpenRecallProtocolError(
        'entry',
        namespace,
        `no entry in the response for "${entryKey}"`,
      )
    const bytes = new Uint8Array(Buffer.from(data.entry, 'base64'))
    return { status: 'ok', hash: ciphertextHashBytes(bytes), bytes }
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

    // Prototype-less on purpose: a plain `{}` routes an entry key of
    // `__proto__` through the prototype setter, which stores nothing. The key
    // would then be missing from the PUT body while still appearing in
    // `uploaded`, so the store could never reject it. With a null prototype it
    // reaches the server like any other key and is reported in `skipped`.
    const toUpload = Object.create(null) as Record<string, string>
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
    for (const [k, b64] of Object.entries(toUpload))
      if (!refused.has(k)) stored[k] = ciphertextHash(b64)
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

  /** Delete one entry. Reports whether the store actually removed anything. */
  async delete(namespace: string, entryKey: string): Promise<DeleteResult> {
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
      const result = JSON.parse(res.raw) as {
        version: number
        deleted?: string[]
        skipped?: { key: string; reason: string }[]
      }
      // The PUT route answers 200 and lists a key it refused in `skipped`, where
      // the DELETE route answers with an error. Report it the same way.
      const refused = result.skipped?.find(s => s.key === entryKey)
      if (refused) {
        throw new OpenRecallHttpError(
          `openrecall 400: ${flattenServerText(refused.reason, 80)}`,
          400,
          'invalid_key',
          { sentBase: sent },
        )
      }
      this.record(namespace, {}, [entryKey])
      return {
        namespace,
        version: result.version,
        deleted: (result.deleted ?? []).includes(entryKey),
      }
    }
    const q = seen ? `&base=${encodeURIComponent(seen)}` : ''
    const res = await this.request(
      'delete',
      namespace,
      `${this.endpoint(namespace)}?key=${encodeURIComponent(entryKey)}${q}`,
      { method: 'DELETE', headers: this.headers() },
    )
    if (!res.ok) throw httpError(res, seen ? { [entryKey]: seen } : undefined)
    const result = JSON.parse(res.raw) as { version: number; deleted?: string[] }
    this.record(namespace, {}, [entryKey])
    return {
      namespace,
      version: result.version,
      deleted: (result.deleted ?? []).includes(entryKey),
    }
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
    for (const [k, hash] of Object.entries(written)) observed.hashes[k] = hash
    for (const k of deleted) delete observed.hashes[k]
  }
}

/**
 * A server that could not be reached, as opposed to one that answered. A
 * refusal (`OpenRecallHttpError`), a malformed answer (`OpenRecallProtocolError`)
 * and a body that would not decrypt are all answers; only a timeout and a
 * transport throw (a refused connection, a reset, a DNS failure) mean the
 * mirror is entitled to speak for the server.
 */
function isUnreachable(err: unknown): boolean {
  if (err instanceof OpenRecallTimeoutError) return true
  return !(
    err instanceof OpenRecallHttpError ||
    err instanceof OpenRecallProtocolError ||
    err instanceof OpenRecallDecryptError
  )
}

/** The namespace checksum as src/hash.ts computes it: sorted `key\thash` lines. */
function namespaceChecksum(entryChecksums: Record<string, string>): string {
  const lines = Object.keys(entryChecksums)
    .sort()
    .map(k => `${k}\t${entryChecksums[k]}`)
    .join('\n')
  return `sha256:${createHash('sha256').update(lines).digest('hex')}`
}

/** The mirror manifest rows for what a pull holds. */
function manifestRows(
  held: Map<string, Held>,
  updatedAt: Record<string, string>,
): MirrorManifest['entries'] {
  const rows: MirrorManifest['entries'] = {}
  for (const [k, h] of held) {
    if (h.plaintext === undefined) continue
    const stamp = Object.hasOwn(updatedAt, k) ? updatedAt[k] : undefined
    rows[k] =
      stamp === undefined
        ? { hash: h.hash, size: h.size }
        : { hash: h.hash, size: h.size, updatedAt: stamp }
  }
  return rows
}

/** `Promise.all` with at most `limit` calls in flight; see src/memory.ts for the shape. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i] as T)
    }
  }
  const workers: Promise<void>[] = []
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker())
  await Promise.all(workers)
  return out
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

export {
  ciphertextHash,
  ciphertextHashBytes,
  decryptEntry,
  decryptEntryBytes,
  deriveKey,
  encryptEntry,
} from './crypto.ts'
export {
  type Finding,
  type ScanMode,
  SecretFoundError,
  scanEntries,
  scanEntry,
} from './secretscan.ts'
