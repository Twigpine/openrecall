/**
 * Storage driver factory — picks the BlobStore from config.
 */

import { config } from '../config.ts'
import type { BlobStore } from './blobstore.ts'
import { FsBlobStore } from './fs.ts'
import { S3BlobStore } from './s3.ts'

let cached: BlobStore | null = null

export function getStore(): BlobStore {
  if (cached) return cached
  cached = config.store === 's3' ? new S3BlobStore(config.s3) : new FsBlobStore(config.dataDir)
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
