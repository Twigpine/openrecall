/**
 * BlobStore — the pluggable persistence interface.
 *
 * openrecall stores two things per namespace:
 *   - a `manifest` blob: JSON map of entryKey -> { hash, size, updatedAt }
 *   - one `entry` blob per entryKey: the CIPHERTEXT of that memory entry
 *
 * The store only ever sees opaque bytes. It has no idea what an "entry" means
 * and could not decrypt one if it wanted to. Adapters: fs (self-host default),
 * s3 (Tigris/R2/AWS for hosted), and later ipfs / git-backed.
 *
 * Keys passed in here are already validated (see namespace.ts), so adapters
 * may use them to build paths without re-checking for traversal.
 */

export interface BlobStore {
  /** Read raw bytes. Returns null if the object does not exist. */
  get(path: string): Promise<Uint8Array | null>
  /** Write raw bytes, overwriting any existing object. */
  put(path: string, bytes: Uint8Array): Promise<void>
  /** Delete an object. No-op if it does not exist. */
  delete(path: string): Promise<void>
  /** A short label for logs/health (e.g. "fs:/data", "s3:openrecall"). */
  describe(): string
  /**
   * Whether `delete` actually removes the bytes. A store that keeps history
   * (a git-backed one, say) retains them, and a client that knows can refuse a
   * scan mode that would let a secret land somewhere it can never be removed
   * from. Constant per store, so reporting it costs nothing per request.
   */
  readonly erasure: Erasure
}

/** Whether a store's delete is destructive. */
export type Erasure = 'erases' | 'retains'

/** Build the storage path for a namespace's manifest. */
export function manifestPath(nsSlug: string): string {
  return `ns/${nsSlug}/manifest.json`
}

/**
 * Build the storage path for one entry. We hash the entry key so weird-but-
 * valid keys map to a flat, fixed-width filename, and the original key is only
 * recorded inside the (encrypted-at-the-edges) manifest.
 */
export function entryPath(nsSlug: string, entryKeyHash: string): string {
  return `ns/${nsSlug}/entries/${entryKeyHash}`
}

/**
 * Build the storage path for one entry's ciphertext, named by that ciphertext's
 * own hash. Writing to a content-addressed path means an overwrite never mutates
 * a blob the currently-visible manifest still points at, which is what makes a
 * crash mid-commit leave the previous state readable and self-consistent.
 *
 * Encryption is deterministic, so two entries holding identical ciphertext share
 * one path. Cleanup must therefore check the live hash set before removing a
 * blob, never assume one entry owns it.
 */
export function contentPath(nsSlug: string, ciphertextHash: string): string {
  return `ns/${nsSlug}/blobs/${ciphertextHash.replace(/^sha256:/, '')}`
}
