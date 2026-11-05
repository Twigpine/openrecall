/**
 * Reserved entry keys and key normalization for organized memory.
 *
 * The server stores opaque ciphertext under caller-chosen keys and knows
 * nothing about what a key means, so every convention that separates a note
 * somebody wrote from a bookkeeping entry the client maintains has to live on
 * the client side, in one place, as a rule over the key string. This module is
 * that place. Nothing here reads or writes anything; it only answers questions
 * about keys and derives one key from another.
 *
 * Rules:
 *
 * - Bookkeeping entries (version history, the trash, the access-date sidecar,
 *   the copy of a hand-written index) live under `sys.openrecall/`. A
 *   dot-prefix such as `.history/` would read more naturally but is not a
 *   valid key: `validateEntryKey` in `src/namespace.ts` requires the first
 *   character to be alphanumeric. The prefix is a path segment, not a bare
 *   prefix, so `sys.openrecall-notes.md` is an ordinary note and `isSystemKey`
 *   says so.
 * - The index is `MEMORY.md`, at the namespace root or at the root of any
 *   subtree (`project/MEMORY.md`). Both are generated-or-curated tables of
 *   contents, not facts, and neither is ranked, listed in the index, or
 *   compared by the save gate.
 * - A key is hidden when it is either of the above. Hidden keys exist and are
 *   fetchable by name; they are left out of anything that enumerates notes as
 *   notes.
 * - Two keys are twins when they normalize to the same string: NFKC, lowercase,
 *   a trailing `.md` removed, runs of `_` and whitespace folded to `-`, runs of
 *   `-` collapsed, and a leading or trailing `-` stripped from every path
 *   segment. The normalized form is for comparison only and is never saved.
 * - Derived keys (`trashKey`, `historyKey`) must themselves be valid keys, so
 *   each returns null when the derivation would exceed the 255-character key
 *   limit rather than returning something the server will refuse.
 */

/** Path prefix under which every bookkeeping entry lives. */
export const SYSTEM_PREFIX = 'sys.openrecall/'

/** Where a soft-deleted note goes: `sys.openrecall/trash/<key>`. */
export const TRASH_PREFIX = `${SYSTEM_PREFIX}trash/`

/** Where a note's version history goes: `sys.openrecall/history/<key>.json`. */
export const HISTORY_PREFIX = `${SYSTEM_PREFIX}history/`

/** The one sidecar: last-accessed dates for every key, kept out of the notes. */
export const ACCESSED_KEY = `${SYSTEM_PREFIX}accessed.json`

/** The index filename, at the namespace root or the root of a subtree. */
export const INDEX_BASENAME = 'MEMORY.md'

/** The root index: the one `MEMORY.md` the client regenerates on every write. */
export const INDEX_KEY = INDEX_BASENAME

/**
 * Where a hand-maintained root index is copied, whole, the first time the
 * client regenerates it, so nothing an agent wrote there is lost. Written
 * once: a later markerless index is adopted but does not overwrite this.
 */
export const LEGACY_INDEX_KEY = `${SYSTEM_PREFIX}MEMORY.before-generated.md`

/**
 * Longest key the server accepts. `ENTRY_KEY_RE` in `src/namespace.ts` is one
 * leading alphanumeric plus up to 254 more characters; `tests/keys.test.ts`
 * pins this constant against `validateEntryKey` so the two cannot drift apart
 * silently.
 */
export const MAX_KEY_LENGTH = 255

/** True for a bookkeeping entry under `sys.openrecall/`. */
export function isSystemKey(key: string): boolean {
  return key.startsWith(SYSTEM_PREFIX)
}

/** True for the root `MEMORY.md` or any `<dir>/MEMORY.md`. Case-sensitive, like keys. */
export function isIndexKey(key: string): boolean {
  return key === INDEX_BASENAME || key.endsWith(`/${INDEX_BASENAME}`)
}

/** True for a key that enumerations of notes leave out: a system key or an index. */
export function isHiddenKey(key: string): boolean {
  return isSystemKey(key) || isIndexKey(key)
}

/**
 * Comparison form of a key. Two keys with the same normalized form are the
 * same note filed twice (`feedback/Testing.md` and `feedback/testing`); the
 * save gate reports the pair rather than letting the second one in.
 */
export function normalizeKey(key: string): string {
  const folded = key.normalize('NFKC').toLowerCase().replace(/\.md$/, '')
  return folded
    .split('/')
    .map(segment =>
      segment
        .replace(/[_\s]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, ''),
    )
    .join('/')
}

/** `key` with `prefix` and `suffix` attached, or null when that would not be a valid length. */
function derive(prefix: string, key: string, suffix: string): string | null {
  const out = `${prefix}${key}${suffix}`
  return out.length > MAX_KEY_LENGTH ? null : out
}

/**
 * Where a soft-deleted note is parked. Null when the key is too long to park,
 * in which case the caller must either refuse or hard-delete and say so.
 */
export function trashKey(key: string): string | null {
  return derive(TRASH_PREFIX, key, '')
}

/**
 * Where a note's prior versions are kept. Null when the key is too long, in
 * which case history is skipped for that note (the plan already skips it for
 * keys over 232 characters, which this bound makes mechanical).
 */
export function historyKey(key: string): string | null {
  return derive(HISTORY_PREFIX, key, '.json')
}

/** The access-date sidecar. A constant, so it can never overflow. */
export function accessedKey(): string {
  return ACCESSED_KEY
}
