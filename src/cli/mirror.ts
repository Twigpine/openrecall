/**
 * The on-disk ciphertext mirror for remote mode: `$OPENRECALL_HOME/cache`.
 *
 * What it holds, per namespace, under `ns/<namespaceSlug>/`:
 *   mirror.json      keys, ciphertext hashes, sizes, timestamps, the version
 *                    and when it was fetched (the MirrorManifest the client
 *                    writes after every pull that reached the server)
 *   blobs/<hex>      one ciphertext blob per distinct hash, named by the hash
 *
 * Never plaintext and never an index. It is the same thing the server's data
 * directory is, held on the client's side, which is why the layout reuses the
 * server's own path helpers and store: `FsBlobStore` in private mode (dirs
 * 0700, files 0600, the custody `config.json` has) with temp-then-rename
 * writes. The server still sees only ciphertext; this is a copy of what it
 * already serves, so a recall against an unchanged namespace costs one
 * bodyless round trip, and a recall while the server is unreachable can be
 * answered at all (`pull(ns, { allowStale: true })`).
 *
 * Failure policy: a cache may miss, it may not fail a read. A manifest that
 * does not parse, or names another namespace, is ignored and rebuilt by the
 * next pull. A write that fails (disk full, a permission someone changed) is
 * reported once on stderr, never stdout (stdout is the MCP channel), and the
 * mirror goes quiet for the rest of the process: reads answer null and writes
 * are dropped, so the client runs as if it had no mirror. Blob verification
 * (sha256 of the bytes against the name) is the client's, so every MirrorStore
 * gets it, not only this one.
 *
 * Local mode does not use this: its data directory already is a ciphertext
 * store on this machine, and a second copy of it buys nothing.
 */

import { join } from 'node:path'
import type { MirrorManifest, MirrorStore } from '../../client/index.ts'
import { namespaceSlug } from '../namespace.ts'
import { blobPrefix, contentPath } from '../store/blobstore.ts'
import { FsBlobStore } from '../store/fs.ts'

/** Where the mirror lives under an OpenRecall home. */
export function cacheDir(home: string): string {
  return join(home, 'cache')
}

function manifestPath(nsSlug: string): string {
  return `ns/${nsSlug}/mirror.json`
}

export class FsMirror implements MirrorStore {
  private readonly store: FsBlobStore
  private disabled = false

  constructor(readonly root: string) {
    this.store = new FsBlobStore(root, { private: true })
  }

  async readManifest(namespace: string): Promise<MirrorManifest | null> {
    if (this.disabled) return null
    const raw = await this.store.get(manifestPath(namespaceSlug(namespace))).catch(() => null)
    if (!raw) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw))
    } catch {
      return null
    }
    return isManifestFor(parsed, namespace) ? parsed : null
  }

  async writeManifest(namespace: string, manifest: MirrorManifest): Promise<void> {
    await this.write(
      manifestPath(namespaceSlug(namespace)),
      new TextEncoder().encode(JSON.stringify(manifest)),
    )
  }

  async getBlob(namespace: string, hash: string): Promise<Uint8Array | null> {
    if (this.disabled) return null
    // contentPath refuses a hash that is not a bare digest, so a manifest row
    // can never name a path outside the namespace's blob directory.
    return this.store.get(contentPath(namespaceSlug(namespace), hash)).catch(() => null)
  }

  async putBlob(namespace: string, hash: string, bytes: Uint8Array): Promise<void> {
    await this.write(contentPath(namespaceSlug(namespace), hash), bytes)
  }

  async deleteBlob(namespace: string, hash: string): Promise<void> {
    if (this.disabled) return
    await this.store.delete(contentPath(namespaceSlug(namespace), hash)).catch(() => {})
  }

  async listBlobs(namespace: string): Promise<string[]> {
    if (this.disabled) return []
    const prefix = blobPrefix(namespaceSlug(namespace))
    const paths = await this.store.list(prefix).catch(() => [] as string[])
    return paths.map(p => `sha256:${p.slice(prefix.length)}`)
  }

  private async write(path: string, bytes: Uint8Array): Promise<void> {
    if (this.disabled) return
    try {
      await this.store.put(path, bytes)
    } catch (err) {
      this.disabled = true
      // The class and the code only. The message would carry the path, and
      // the path carries a namespace slug, which stderr need not learn.
      const e = err as NodeJS.ErrnoException
      console.error(
        `[openrecall] the local cache at ${this.root} could not be written (${e.code ?? e.constructor?.name ?? 'error'}); continuing without it for this process`,
      )
    }
  }
}

function isManifestFor(v: unknown, namespace: string): v is MirrorManifest {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const m = v as Record<string, unknown>
  return (
    m.namespace === namespace &&
    typeof m.version === 'number' &&
    typeof m.fetchedAt === 'string' &&
    !!m.entries &&
    typeof m.entries === 'object' &&
    !Array.isArray(m.entries)
  )
}

/**
 * What `openrecall status` prints about the mirror: where it is and how much
 * it holds for a namespace, or null when there is nothing on disk for it.
 */
export async function describeMirror(
  home: string,
  namespace: string,
): Promise<{ path: string; entries: number; bytes: number } | null> {
  const mirror = new FsMirror(cacheDir(home))
  const m = await mirror.readManifest(namespace)
  if (!m) return null
  let bytes = 0
  for (const row of Object.values(m.entries)) bytes += typeof row.size === 'number' ? row.size : 0
  return {
    path: join(cacheDir(home), 'ns', namespaceSlug(namespace)),
    entries: Object.keys(m.entries).length,
    bytes,
  }
}
