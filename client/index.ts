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
}

export type PullResult = {
  namespace: string
  version: number
  /** entryKey -> decrypted plaintext */
  entries: Record<string, string>
}

export type PushResult = {
  namespace: string
  version: number
  uploaded: string[]
  unchanged: string[]
  deleted: string[]
}

export class OpenRecallClient {
  private readonly url: string
  private readonly apiKey?: string
  private readonly passphrase: string
  private readonly scanMode: ScanMode
  private readonly onScanWarning?: (findings: Finding[]) => void
  private readonly keyCache = new Map<string, Buffer>()

  constructor(opts: OpenRecallClientOptions) {
    this.url = opts.url.replace(/\/$/, '')
    this.apiKey = opts.apiKey
    this.passphrase = opts.passphrase
    this.scanMode = opts.scanMode ?? 'block'
    this.onScanWarning = opts.onScanWarning
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
    const res = await fetch(`${this.endpoint(namespace)}?view=hashes`, { headers: this.headers() })
    if (res.status === 404) return {}
    if (!res.ok) throw await httpError(res)
    const data = (await res.json()) as { entryChecksums?: Record<string, string> }
    return data.entryChecksums ?? {}
  }

  /** Pull and decrypt all entries for a namespace. */
  async pull(namespace: string): Promise<PullResult> {
    const res = await fetch(this.endpoint(namespace), { headers: this.headers() })
    if (res.status === 404) return { namespace, version: 0, entries: {} }
    if (!res.ok) throw await httpError(res)
    const data = (await res.json()) as {
      version: number
      content: { entries: Record<string, string> }
    }
    const key = this.key(namespace)
    const entries: Record<string, string> = {}
    for (const [entryKey, b64] of Object.entries(data.content.entries)) {
      entries[entryKey] = decryptEntry(key, entryKey, b64)
    }
    return { namespace, version: data.version, entries }
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

    const res = await fetch(this.endpoint(namespace), {
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
    const res = await fetch(`${this.endpoint(namespace)}?key=${encodeURIComponent(entryKey)}`, {
      method: 'DELETE',
      headers: this.headers(),
    })
    if (!res.ok) throw await httpError(res)
  }

  private async version(namespace: string): Promise<number> {
    const res = await fetch(`${this.endpoint(namespace)}?view=hashes`, { headers: this.headers() })
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
