/**
 * BlobStore — the pluggable persistence interface.
 *
 * openrecall stores two things per namespace:
 *   - a `manifest` blob: JSON map of entryKey -> { hash, size, updatedAt }
 *   - one ciphertext blob per distinct entry ciphertext, named by its own hash
 *     (see `contentPath`); the manifest maps each entryKey to that hash, and two
 *     entries holding identical ciphertext share one blob
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
  /**
   * Every object path under `prefix`. Needed because reclaim has to find blobs
   * no manifest names: a write that dies before publishing leaves ciphertext
   * that no later request can reach by key, so a reclaim driven only from the
   * previous manifest can never see it. Without this the store accumulates
   * ciphertext that quota cannot count and `erasure: 'erases'` is a false
   * promise.
   */
  list(prefix: string): Promise<string[]>
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
 * Build the pre-content-addressing storage path for one entry, hashing the entry
 * key so weird-but-valid keys map to a flat, fixed-width filename.
 *
 * Retained only so entries written under the old layout stay readable and get
 * reclaimed when they are next touched. New writes go through `contentPath`.
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
  return `ns/${nsSlug}/blobs/${bareHash(ciphertextHash)}`
}

/** The directory every content-addressed blob for a namespace lives under. */
export function blobPrefix(nsSlug: string): string {
  return `ns/${nsSlug}/blobs/`
}

/**
 * Strip the `sha256:` prefix and prove what remains is a bare hex digest.
 *
 * A manifest hash reaches a storage path here, and a manifest is parsed JSON
 * rather than validated input, so this is the boundary the repo's rule about
 * validating names before they touch a path applies to. Without the check a
 * hash carrying path separators escapes the namespace directory.
 */
function bareHash(ciphertextHash: string): string {
  const bare = ciphertextHash.startsWith('sha256:') ? ciphertextHash.slice(7) : ciphertextHash
  if (!/^[0-9a-f]{64}$/.test(bare)) throw new Error('ciphertext hash is not a sha256 digest')
  return bare
}
