/**
 * Per-key version history: the prior bodies of a note, kept as ONE entry per
 * note under `historyKey(key)` (`sys.openrecall/history/<key>.json`).
 *
 * A note that is rewritten in place loses what it said before, and a merge
 * that went wrong or a supersede that was too eager has nothing to fall back
 * on. The history entry holds the last few stored versions so `memory_get`
 * can read `version: n` and an agent can see what changed. It is a bookkeeping
 * entry (hidden from ranking, the index and `memory_list`) and it costs one
 * entry per note against the namespace cap, which is why it is bounded on
 * every axis and switched off near the cap.
 *
 * This module is pure: it parses, appends to and serializes the history
 * document and decides whether history may be written at all. It never reads
 * a client, a store or the network; the caller (the tool layer, in a later
 * change) fetches the current history entry, calls `appendVersion` with the
 * body it is about to overwrite, and writes the result in the same PUT as the
 * note. Nothing is wired yet.
 *
 * Rules:
 *
 * - `HistoryFile` is `{ v: 1, key, versions }` with `versions` NEWEST FIRST,
 *   so `readVersion(file, 1)` is the body that was stored just before the
 *   current one. At most `HISTORY_CAP` versions are kept; appending a sixth
 *   drops the oldest.
 * - A version is recorded only when it differs from the newest stored one
 *   (`reason: 'unchanged'` otherwise), so a resave that changed only stamps
 *   does not spend a slot, and only when its content is at most
 *   `HISTORY_MAX_CONTENT` characters (`'too-large'`): five versions of that
 *   size plus JSON framing fit the 250 KB entry cap. As a second guard for
 *   bodies that are large in bytes but not in characters, the serialized file
 *   is kept under `HISTORY_MAX_BYTES` by dropping the oldest versions; a
 *   version that does not fit even alone is `'too-large'`.
 * - `parseHistory` is tolerant: null, empty text, malformed JSON, a wrong
 *   `v`, a document whose `key` names another note, or a `versions` that is
 *   not an array all yield an empty file for `key`; a malformed version entry
 *   is dropped and the rest kept; more than `HISTORY_CAP` entries are trimmed
 *   from the end (the oldest).
 * - `historyAllowed` is the write-time policy, in order: `OPENRECALL_HISTORY`
 *   set to `0`, `false`, `off` or `no` disables history entirely; a key whose
 *   history key would exceed the key length limit (`historyKey` returns null)
 *   is skipped; a body over `HISTORY_MAX_CONTENT` characters is skipped; a
 *   namespace at or above `HISTORY_STOP_ENTRIES` entries is skipped, so
 *   history never pushes a namespace into its entry cap. The doctor warns
 *   from `HISTORY_WARN_ENTRIES` up.
 */

import { historyKey } from './keys.ts'
import { utf8Length } from './memindex.ts'

/** Prior versions kept per note. */
export const HISTORY_CAP = 5

/** Longest body, in characters, that is recorded. Five of these fit the 250 KB entry cap. */
export const HISTORY_MAX_CONTENT = 45_000

/**
 * Largest serialized history entry, in UTF-8 bytes. The server's entry cap is
 * 250,000 bytes of ciphertext and the envelope adds 29 bytes; the rest is
 * margin for JSON escaping.
 */
export const HISTORY_MAX_BYTES = 240_000

/** Namespace entry count at or above which history is no longer written. */
export const HISTORY_STOP_ENTRIES = 1_600

/** Namespace entry count at or above which the doctor warns that history will stop. */
export const HISTORY_WARN_ENTRIES = 1_400

/** The environment variable that switches history off. */
export const HISTORY_ENV = 'OPENRECALL_HISTORY'

export type HistoryVersion = {
  /** ISO timestamp the version carried as `updated` when it was stored. */
  updated: string
  agent?: string
  session?: string
  /** The ciphertext hash the version was stored under, when known. */
  hash?: string
  /** The full note as stored, frontmatter included. */
  content: string
}

export type HistoryFile = {
  v: 1
  key: string
  versions: HistoryVersion[]
}

export type AppendReason = 'unchanged' | 'too-large'

export type AppendResult = {
  file: HistoryFile
  recorded: boolean
  reason?: AppendReason
}

export type AllowedReason = 'disabled' | 'key-too-long' | 'too-large' | 'namespace-near-cap'

export type AllowedResult = { ok: boolean; reason?: AllowedReason }

export type AllowedInput = {
  key: string
  /** Length in characters of the body about to be recorded. */
  contentLength: number
  /** Entries in the namespace right now, every key counted. */
  namespaceEntries: number
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>
}

/** Values of `OPENRECALL_HISTORY` that switch history off, case-insensitively. */
const OFF_VALUES = new Set(['0', 'false', 'off', 'no'])

/** An empty history for `key`. */
export function emptyHistory(key: string): HistoryFile {
  return { v: 1, key, versions: [] }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function optionalString(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined
}

/** A stored version entry, or undefined when it lacks its two required strings. */
function toVersion(x: unknown): HistoryVersion | undefined {
  if (!isRecord(x)) return undefined
  if (typeof x.updated !== 'string' || typeof x.content !== 'string') return undefined
  const v: HistoryVersion = { updated: x.updated, content: x.content }
  const agent = optionalString(x.agent)
  const session = optionalString(x.session)
  const hash = optionalString(x.hash)
  if (agent !== undefined) v.agent = agent
  if (session !== undefined) v.session = session
  if (hash !== undefined) v.hash = hash
  return v
}

/**
 * Read a history entry's text. Anything that is not a well-formed history
 * document for `key` is an empty file; a malformed version inside a
 * well-formed document is dropped on its own.
 */
export function parseHistory(text: string | null, key: string): HistoryFile {
  if (text === null || text === '') return emptyHistory(key)
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return emptyHistory(key)
  }
  if (!isRecord(doc) || doc.v !== 1 || doc.key !== key || !Array.isArray(doc.versions)) {
    return emptyHistory(key)
  }
  const versions: HistoryVersion[] = []
  for (const raw of doc.versions) {
    const v = toVersion(raw)
    if (v) versions.push(v)
    if (versions.length === HISTORY_CAP) break
  }
  return { v: 1, key, versions }
}

/** The history entry's text: compact JSON, the shape `parseHistory` reads. */
export function serializeHistory(file: HistoryFile): string {
  return JSON.stringify(file)
}

/**
 * Record `version` as the newest prior version, or say why not. Pure: the
 * input file is not mutated, and the returned file is the input itself when
 * nothing was recorded.
 */
export function appendVersion(file: HistoryFile, version: HistoryVersion): AppendResult {
  if (version.content.length > HISTORY_MAX_CONTENT)
    return { file, recorded: false, reason: 'too-large' }
  const newest = file.versions[0]
  if (newest !== undefined && newest.content === version.content) {
    return { file, recorded: false, reason: 'unchanged' }
  }
  const versions = [version, ...file.versions].slice(0, HISTORY_CAP)
  let next: HistoryFile = { v: 1, key: file.key, versions }
  // Bytes, not characters, are what the entry cap measures: shed the oldest
  // versions until the document fits, and refuse when the new one cannot.
  while (utf8Length(serializeHistory(next)) > HISTORY_MAX_BYTES) {
    if (next.versions.length === 1) return { file, recorded: false, reason: 'too-large' }
    next = { v: 1, key: file.key, versions: next.versions.slice(0, -1) }
  }
  return { file: next, recorded: true }
}

/**
 * The n-th prior version, 1 being the newest stored one. Undefined for a
 * number that is not a positive integer within the stored range.
 */
export function readVersion(file: HistoryFile, n: number): HistoryVersion | undefined {
  if (!Number.isInteger(n) || n < 1 || n > file.versions.length) return undefined
  return file.versions[n - 1]
}

/** Whether history may be recorded for this write, and the first rule that says no. */
export function historyAllowed(input: AllowedInput): AllowedResult {
  const env = input.env ?? process.env
  const flag = env[HISTORY_ENV]
  if (flag !== undefined && OFF_VALUES.has(flag.trim().toLowerCase())) {
    return { ok: false, reason: 'disabled' }
  }
  if (historyKey(input.key) === null) return { ok: false, reason: 'key-too-long' }
  if (input.contentLength > HISTORY_MAX_CONTENT) return { ok: false, reason: 'too-large' }
  if (input.namespaceEntries >= HISTORY_STOP_ENTRIES) {
    return { ok: false, reason: 'namespace-near-cap' }
  }
  return { ok: true }
}
