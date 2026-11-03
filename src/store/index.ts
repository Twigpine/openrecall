/**
 * Storage driver factory — picks the BlobStore from config.
 */

import { config } from '../config.ts'
import type { BlobStore } from './blobstore.ts'
import { FsBlobStore } from './fs.ts'
import { NodeBlobStore } from './node.ts'
import { S3BlobStore } from './s3.ts'

let cached: BlobStore | null = null

/**
 * Build the driver one name selects. Unknown names refuse rather than falling
 * through to the filesystem: `config.store` is an unvalidated cast of the STORE
 * variable, so a typo such as `s3x` would serve local disk silently while every
 * gate, including the startup probe, reported a healthy store.
 */
export function createStore(driver: string = config.store): BlobStore {
  switch (driver) {
    case 'fs':
      return new FsBlobStore(config.dataDir)
    case 's3':
      return new S3BlobStore(config.s3)
    case 'node':
      return new NodeBlobStore(config.node)
    default:
      throw new Error(`unknown store driver "${driver}"; STORE must be fs, s3 or node`)
  }
}

export function getStore(): BlobStore {
  if (cached) return cached
  cached = createStore()
  return cached
}

/**
 * Install a store for the rest of the process. Tests only: the cache above is
 * process-lifetime by design, so a fault-injecting store or a second driver has
 * no other way in. Nothing the server imports may call this, and
 * tests/store-seam.test.ts walks the production import graph to prove it.
 */
export function setStore(store: BlobStore): void {
  cached = store
}

/** Drop any installed or memoized store so the next getStore() rebuilds from config. */
export function resetStore(): void {
  cached = null
}

export type { BlobStore } from './blobstore.ts'
export { blobPrefix, contentPath, entryPath, manifestPath } from './blobstore.ts'
