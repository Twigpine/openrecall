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

import type { Frame, FramesHeader } from './frames.ts'
import type { Erasure } from './store/blobstore.ts'

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
  /** Whether this deployment's store actually erases on delete. */
  erasure: Erasure
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
  /**
   * entryKey -> ISO 8601 from the manifest, the same rows `entryChecksums`
   * comes from. Here so an incremental pull, which fetches bodies only for the
   * keys whose hash moved, can still report a timestamp for the ones it did
   * not fetch. A client predating the field ignores it.
   */
  entryUpdatedAt: Record<string, string>
  /** Whether this deployment's store actually erases on delete. */
  erasure: Erasure
  /**
   * Server capabilities a client can rely on. Without this a client cannot tell
   * a server that enforces the write precondition from one that ignores an
   * unknown body field, so it would report a guarantee it is not getting.
   */
  supports: string[]
}

/**
 * GET ?view=entry response — ONE entry's ciphertext.
 *
 * The value is byte-for-byte what the full read puts in
 * `content.entries[key]`, and `entryChecksum` is that key's
 * `content.entryChecksums[key]`, so a client hashes and decrypts it with the
 * code it already has. It exists because proving a passphrase decrypts what is
 * stored used to cost the whole namespace (2000 entries / 10 MB capped, ~13 MB
 * of base64) when one entry answers the question.
 *
 * `entryChecksum` rather than `checksum`: at this level `checksum` already
 * means the whole-namespace digest on both other read shapes, and a client that
 * mistook one for the other would compare an entry against a namespace.
 */
export type MemoryEntry = {
  namespace: string
  version: number
  lastModified: string
  /** Whether this deployment's store actually erases on delete. */
  erasure: Erasure
  key: string
  /** ciphertext (base64) */
  entry: string
  /** sha256:<hex> of that ciphertext */
  entryChecksum: string
}

/**
 * What a single-entry read found. A tagged result rather than a null or a
 * throw, because the three refusals must reach the caller as three different
 * codes: a namespace with nothing in it, a namespace missing this one key, and
 * a key the manifest names whose body the store cannot produce. Collapsing any
 * pair of them is the denial-rendered-as-success defect this repo keeps
 * shipping.
 */
export type EntryRead =
  | { status: 'ok'; entry: MemoryEntry }
  | { status: 'no_namespace' }
  | { status: 'no_entry' }
  | { status: 'unreadable' }

/**
 * What a bulk entries read found: either no namespace at all (the same `empty`
 * the other reads answer) or one frame per requested key, each carrying its
 * own status, ready for `encodeFrames`. Per-key outcomes live in the frames
 * rather than in a second result shape because one lost body must not fail a
 * read of everything else, and a client must still hear about it.
 */
export type EntriesRead =
  | { status: 'no_namespace' }
  | { status: 'ok'; header: FramesHeader; frames: Frame[] }

/**
 * Validate and narrow the body of `POST ?view=entries`: `{ keys: string[] }`.
 * Shape only. Each key's own validity is judged per key by `getEntries`, so a
 * caller that mistyped one of two thousand keys gets one `invalid_key` frame
 * rather than a refused request, and the count cap is the handler's, since it
 * comes from config.
 */
export function parseEntriesRequest(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('body must be a JSON object')
  }
  const keys = (raw as Record<string, unknown>).keys
  if (!Array.isArray(keys) || keys.some(k => typeof k !== 'string')) {
    throw new Error('`keys` must be an array of entry keys')
  }
  return keys as string[]
}

/** PUT request body. */
export type UpsertRequest = {
  /** entryKey -> ciphertext (base64). Upsert semantics. */
  entries: Record<string, string>
  /** entryKeys to remove (optional). */
  deletions?: string[]
  /**
   * entryKey -> the ciphertext hash the caller believes that key holds, or null
   * for "I believe this key does not exist". Optional: a request without it is
   * accepted unconditionally so existing clients keep working.
   */
  base?: Record<string, string | null>
}

/**
 * Thrown when a write's base disagrees with the manifest it would mutate.
 * Surfaces as HTTP 409; `details.conflicts` maps each disagreeing key to the
 * hash the manifest actually holds, or null when the key is absent, so a caller
 * can tell what changed under it without a second round trip.
 */
export class StaleBaseError extends Error {
  readonly code = 'stale_base_version'
  readonly details: { conflicts: Record<string, string | null> }
  constructor(conflicts: Record<string, string | null>) {
    super('write base is out of date')
    this.name = 'StaleBaseError'
    this.details = { conflicts }
  }
}

export type UpsertResponse = {
  namespace: string
  version: number
  checksum: string
  /** Whether this deployment's store actually erases on delete. */
  erasure: Erasure
  accepted: string[]
  deleted: string[]
  skipped: { key: string; reason: string }[]
}

/**
 * The shape a base hash must take, in one place because both write verbs check
 * it. When only DELETE checked, the same malformed value produced 400 there and
 * 409 on PUT: the garbage reached the manifest comparison, never matched, and
 * reported a conflict. A caller reading "someone wrote under you" retries the
 * same bad value forever.
 */
export function isBaseHash(v: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(v)
}

/** Thrown when a namespace's manifest cannot be parsed. Surfaces as HTTP 503. */
export class UnreadableManifestError extends Error {
  readonly code = 'manifest_unreadable'
  constructor() {
    super('namespace index cannot be read')
    this.name = 'UnreadableManifestError'
  }
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
  let base: Record<string, string | null> | undefined
  if (obj.base !== undefined) {
    if (typeof obj.base !== 'object' || obj.base === null || Array.isArray(obj.base)) {
      throw new Error('`base` must be an object map of key -> hash or null')
    }
    for (const [k, v] of Object.entries(obj.base)) {
      if (v !== null && (typeof v !== 'string' || !isBaseHash(v))) {
        throw new Error(`base ${JSON.stringify(k)} must be a sha256:<hex> hash or null`)
      }
    }
    base = obj.base as Record<string, string | null>
  }
  let deletions: string[] | undefined
  if (obj.deletions !== undefined) {
    if (!Array.isArray(obj.deletions) || obj.deletions.some(d => typeof d !== 'string')) {
      throw new Error('`deletions` must be an array of strings')
    }
    deletions = obj.deletions as string[]
  }
  return { entries: entries as Record<string, string>, deletions, base }
}
