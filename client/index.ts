/**
 * OpenRecallClient — the zero-knowledge sync client.
 *
 * Wraps the crypto + the HTTP sync contract so callers (the openclaude shim,
 * the MCP server, the CLI) work in plaintext and never touch ciphertext or the
 * wire format. Encryption/decryption happen in-process with a key derived from
 * the passphrase, which never leaves the machine.
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
  uploaded: string[]
  unchanged: string[]
  deleted: string[]
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
  private readonly url: string
  private readonly apiKey?: string
  private readonly passphrase: string
  private readonly scanMode: ScanMode
  private readonly onScanWarning?: (findings: Finding[]) => void
  private readonly keyCache = new Map<string, Buffer>()
  private readonly fetch: FetchLike

  constructor(opts: OpenRecallClientOptions) {
    this.url = opts.url.replace(/\/$/, '')
    this.apiKey = opts.apiKey
    this.passphrase = opts.passphrase
    this.scanMode = opts.scanMode ?? 'block'
    this.onScanWarning = opts.onScanWarning
    this.fetch = opts.fetch ?? ((input, init) => fetch(input, init))
  }

  private key(namespace: string): Buffer {
    let k = this.keyCache.get(namespace)
    if (!k) {
      k = deriveKey(this.passphrase, namespace)
      this.keyCache.set(namespace, k)
    }
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

  /** Fetch per-key ciphertext checksums (no bodies). Empty if namespace is new. */
  async hashes(namespace: string): Promise<Record<string, string>> {
    const res = await this.fetch(`${this.endpoint(namespace)}?view=hashes`, {
      headers: this.headers(),
    })
    if (res.status === 404) return {}
    if (!res.ok) throw await httpError(res)
    const data = (await res.json()) as { entryChecksums?: Record<string, string> }
    return data.entryChecksums ?? {}
  }

  /** Pull and decrypt all entries for a namespace. */
  async pull(namespace: string): Promise<PullResult> {
    const res = await this.fetch(this.endpoint(namespace), { headers: this.headers() })
    if (res.status === 404) return { namespace, version: 0, entries: {}, updatedAt: {} }
    if (!res.ok) throw await httpError(res)
    const data = (await res.json()) as {
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
      throw new Error(
        `openrecall ${res.status} ${res.statusText}: malformed body (no content.entries)`,
      )
    }
    const key = this.key(namespace)
    const entries: Record<string, string> = {}
    for (const [entryKey, b64] of Object.entries(entriesRaw)) {
      entries[entryKey] = decryptEntry(key, entryKey, b64)
    }
    return {
      namespace,
      version: data.version,
      entries,
      updatedAt: sanitizeUpdatedAt(data.content?.entryUpdatedAt, entries),
    }
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
    const serverHashes = await this.hashes(namespace)

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
      // Nothing to do; report current server version.
      const ver = await this.version(namespace)
      return { namespace, version: ver, uploaded, unchanged, deleted: [] }
    }

    const res = await this.fetch(this.endpoint(namespace), {
      method: 'PUT',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ entries: toUpload, deletions }),
    })
    if (!res.ok) throw await httpError(res)
    const result = (await res.json()) as { version: number; deleted: string[] }
    return {
      namespace,
      version: result.version,
      uploaded,
      unchanged,
      deleted: result.deleted ?? [],
    }
  }

  /** Delete one entry. */
  async delete(namespace: string, entryKey: string): Promise<void> {
    const res = await this.fetch(
      `${this.endpoint(namespace)}?key=${encodeURIComponent(entryKey)}`,
      {
        method: 'DELETE',
        headers: this.headers(),
      },
    )
    if (!res.ok) throw await httpError(res)
  }

  private async version(namespace: string): Promise<number> {
    const res = await this.fetch(`${this.endpoint(namespace)}?view=hashes`, {
      headers: this.headers(),
    })
    if (res.status === 404) return 0
    if (!res.ok) throw await httpError(res)
    return ((await res.json()) as { version: number }).version
  }
}

async function httpError(res: Response): Promise<Error> {
  let detail = ''
  try {
    detail = JSON.stringify(await res.json())
  } catch {
    detail = await res.text().catch(() => '')
  }
  return new Error(`openrecall ${res.status} ${res.statusText}: ${detail}`)
}

export { ciphertextHash, decryptEntry, deriveKey, encryptEntry } from './crypto.ts'
export {
  type Finding,
  type ScanMode,
  SecretFoundError,
  scanEntries,
  scanEntry,
} from './secretscan.ts'
