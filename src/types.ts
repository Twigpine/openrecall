/**
 * Wire + storage types for the memory sync API.
 *
 * IMPORTANT: every `entries` value is CIPHERTEXT (base64). The server treats
 * it as an opaque string. Checksums are computed over the ciphertext, so the
 * server can do delta sync without ever seeing plaintext.
 *
 * The shape mirrors openclaude's team-memory contract closely enough that the
 * client shim is a thin adapter rather than a rewrite.
 */

/** Per-namespace manifest, persisted as its own blob. */
export type Manifest = {
  version: number
  /** ISO 8601 */
  lastModified: string
  /** entryKey -> metadata about its (ciphertext) blob */
  entries: Record<string, EntryMeta>
}

export type EntryMeta = {
  /** sha256:<hex> of the ciphertext bytes */
  hash: string
  /** ciphertext byte length */
  size: number
  /** ISO 8601 */
  updatedAt: string
}

export function emptyManifest(): Manifest {
  return { version: 0, lastModified: new Date(0).toISOString(), entries: {} }
}

/** Full GET response. */
export type MemoryData = {
  namespace: string
  version: number
  lastModified: string
  /** sha256:<hex> over the whole namespace (sorted key+hash) */
  checksum: string
  content: {
    entries: Record<string, string> // entryKey -> ciphertext (base64)
    entryChecksums: Record<string, string> // entryKey -> sha256:<hex>
    entryUpdatedAt: Record<string, string> // entryKey -> ISO 8601, from the manifest
  }
}

/** GET ?view=hashes response — metadata only, no ciphertext bodies. */
export type MemoryHashes = {
  namespace: string
  version: number
  lastModified: string
  checksum: string
  entryChecksums: Record<string, string>
}

/** PUT request body. */
export type UpsertRequest = {
  /** entryKey -> ciphertext (base64). Upsert semantics. */
  entries: Record<string, string>
  /** entryKeys to remove (optional). */
  deletions?: string[]
}

export type UpsertResponse = {
  namespace: string
  version: number
  checksum: string
  accepted: string[]
  deleted: string[]
  skipped: { key: string; reason: string }[]
}

/** Structured error body. */
export type ApiError = {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

/**
 * Validate and narrow an UpsertRequest parsed from JSON. Throws on malformed
 * input. Entry-key validation (path traversal) happens separately at the
 * handler so we can report per-key skips rather than failing the whole batch.
 */
export function parseUpsertRequest(raw: unknown): UpsertRequest {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('body must be a JSON object')
  }
  const obj = raw as Record<string, unknown>
  const entries = obj.entries
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    throw new Error('`entries` must be an object map of key -> ciphertext')
  }
  for (const [k, v] of Object.entries(entries)) {
    if (typeof v !== 'string') throw new Error(`entry ${JSON.stringify(k)} must be a base64 string`)
  }
  let deletions: string[] | undefined
  if (obj.deletions !== undefined) {
    if (!Array.isArray(obj.deletions) || obj.deletions.some(d => typeof d !== 'string')) {
      throw new Error('`deletions` must be an array of strings')
    }
    deletions = obj.deletions as string[]
  }
  return { entries: entries as Record<string, string>, deletions }
}
