/**
 * Filesystem BlobStore adapter.
 *
 * Zero-config default — ideal for self-host and local dev. Stores each blob as
 * a file under DATA_DIR. Writes are atomic (write temp + rename) so a crash
 * mid-write can't leave a half-written manifest.
 *
 * `private` mode creates directories 0700 and files 0600, the same custody
 * `~/.openrecall/config.json` gets (src/cli/settings.ts), for the client's
 * on-disk ciphertext mirror under the user's own home. The server's data dir
 * keeps the process umask: it is the operator's directory to permission.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { BlobStore } from './blobstore.ts'

/**
 * Makes every temp name this process writes distinct. The old name was
 * `.tmp-<pid>-<byteLength>-<pathLength>`, which two concurrent puts of
 * equal-length blobs to equal-length paths shared: one rename then moved the
 * other's half-written file into place. The server never hit it because
 * `upsert` writes blobs one at a time, but a mirror filling itself with
 * `Promise.all` does.
 */
let tempCounter = 0

export class FsBlobStore implements BlobStore {
  readonly erasure = 'erases' as const

  private readonly root: string
  private readonly dirMode: number | undefined
  private readonly fileMode: number | undefined

  constructor(dataDir: string, opts: { private?: boolean } = {}) {
    this.root = resolve(dataDir)
    this.dirMode = opts.private ? 0o700 : undefined
    this.fileMode = opts.private ? 0o600 : undefined
  }

  private full(path: string): string {
    const p = resolve(this.root, path)
    // Defense in depth: the storage path is derived from already-validated
    // inputs, but make absolutely sure nothing escapes the data dir.
    if (p !== this.root && !p.startsWith(this.root + sep)) {
      throw new Error(`path escapes data dir: ${path}`)
    }
    return p
  }

  async get(path: string): Promise<Uint8Array | null> {
    try {
      const buf = await readFile(this.full(path))
      return new Uint8Array(buf)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async put(path: string, bytes: Uint8Array): Promise<void> {
    const dest = this.full(path)
    await mkdir(dirname(dest), { recursive: true, mode: this.dirMode })
    const tmp = join(dirname(dest), `.tmp-${process.pid}-${tempCounter++}`)
    await writeFile(tmp, bytes, { mode: this.fileMode })
    await rename(tmp, dest)
  }

  async delete(path: string): Promise<void> {
    await rm(this.full(path), { force: true })
  }

  async list(prefix: string): Promise<string[]> {
    const dir = this.full(prefix)
    try {
      const names = await readdir(dir)
      return names.filter(n => !n.startsWith('.tmp-')).map(n => `${prefix}${n}`)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }

  describe(): string {
    return `fs:${this.root}`
  }
}
