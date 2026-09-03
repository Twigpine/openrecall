/**
 * Filesystem BlobStore adapter.
 *
 * Zero-config default — ideal for self-host and local dev. Stores each blob as
 * a file under DATA_DIR. Writes are atomic (write temp + rename) so a crash
 * mid-write can't leave a half-written manifest.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { BlobStore } from './blobstore.ts'

export class FsBlobStore implements BlobStore {
  readonly erasure = 'erases' as const

  private readonly root: string

  constructor(dataDir: string) {
    this.root = resolve(dataDir)
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
    await mkdir(dirname(dest), { recursive: true })
    const tmp = join(dirname(dest), `.tmp-${process.pid}-${bytes.byteLength}-${path.length}`)
    await writeFile(tmp, bytes)
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
