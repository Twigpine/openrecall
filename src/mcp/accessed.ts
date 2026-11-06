/**
 * The access-date sidecar: `sys.openrecall/accessed.json`, one per namespace,
 * `{ "v": 1, "keys": { "<entry key>": "YYYY-MM-DD" } }`, the day each note was
 * last returned by recall or read by get.
 *
 * Why this is a sidecar and not an `accessed:` line in each note's
 * frontmatter: a note is re-encrypted deterministically, so touching one
 * line changes its ciphertext hash. Writing the date into the note would
 * (1) churn every recalled note's hash on every read, turning a read-only
 * recall into a write of up to `limit` entries; (2) hand a 409 to every other
 * session that had read those notes, since their write base no longer
 * matches, for a change nobody made to the content; and (3) fill the version
 * history (a later PR) with revisions whose only diff is a date. One sidecar
 * takes all of that on itself: it is the only entry whose hash moves, no
 * session uses it as a write base for anything but itself, and it is never
 * a ranking candidate (`isHiddenKey`), so it cannot pollute recall either.
 *
 * Day granularity, because the dates exist to answer "is this note still in
 * use" for the doctor and the index, and nothing there needs the hour.
 *
 * When it is written: never on a plain recall or get. Those only add to
 * `session.pendingAccess`. The pending stamps ride along on the next
 * `memory_save` or `memory_delete` to the same namespace, as a second entry in
 * the same push, so a read-only session writes nothing and a session that
 * writes anyway pays one more entry in a request it was sending regardless.
 * The one exception is a namespace that accumulates fifty pending keys in a
 * process that never writes: that is flushed on its own, once per process per
 * namespace, so a long read-only session still leaves a trace.
 *
 * Merging is union with the later date per key, so two sessions flushing the
 * same sidecar lose nothing whichever lands second. A 409 on the sidecar is
 * resolved by re-reading it, merging again and retrying once; the tool layer
 * never shows that to the agent, because there is no decision for it to make.
 *
 * The sidecar's content is data that another session wrote: it is parsed
 * defensively (anything that is not a key -> date string pair is dropped) and
 * bounded, so a corrupt or hostile sidecar costs at most a lost date.
 */

import { type OpenRecallClient, OpenRecallHttpError } from '../../client/index.ts'
import { ACCESSED_KEY } from './keys.ts'

export type AccessedSidecar = { v: 1; keys: Record<string, string> }

/** Pending keys in one namespace at which a read-only process flushes on its own. */
export const ACCESS_FLUSH_THRESHOLD = 50

/** Most keys the sidecar keeps; the oldest dates are dropped past it. */
export const MAX_ACCESSED_KEYS = 5_000

/** The client surface this module needs: the single-entry read and the push. */
export type AccessedClient = Pick<OpenRecallClient, 'entry' | 'push'>

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** The UTC calendar day, `YYYY-MM-DD`. */
export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/** Record that `key` in `ns` was returned to the agent on `day`, keeping the later day. */
export function noteAccess(
  pendingAccess: Map<string, Map<string, string>>,
  ns: string,
  key: string,
  day: string,
): void {
  let pending = pendingAccess.get(ns)
  if (!pending) {
    pending = new Map()
    pendingAccess.set(ns, pending)
  }
  const prior = pending.get(key)
  if (prior === undefined || prior < day) pending.set(key, day)
}

/** Parse a stored sidecar. Anything unreadable is an empty sidecar, never a throw. */
export function parseAccessed(text: string | null | undefined): AccessedSidecar {
  const out: AccessedSidecar = { v: 1, keys: {} }
  if (!text) return out
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return out
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out
  const keys = (data as { keys?: unknown }).keys
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return out
  // Own string properties only, rebuilt into a fresh object: the sidecar is
  // another session's text, and a `__proto__` key must not survive the parse.
  for (const k of Object.keys(keys as Record<string, unknown>)) {
    const v = (keys as Record<string, unknown>)[k]
    if (typeof v === 'string' && DATE_RE.test(v)) out.keys[k] = v
  }
  return out
}

/**
 * Union with the later date per key. `changed` is false when every pending
 * date is already recorded at that day or later, in which case there is
 * nothing to write.
 */
export function mergeAccessed(
  stored: AccessedSidecar,
  pending: Iterable<[string, string]>,
): { sidecar: AccessedSidecar; changed: boolean } {
  const keys: Record<string, string> = { ...stored.keys }
  let changed = false
  for (const [k, day] of pending) {
    if (!DATE_RE.test(day)) continue
    const prior = Object.hasOwn(keys, k) ? keys[k] : undefined
    if (prior === undefined || prior < day) {
      keys[k] = day
      changed = true
    }
  }
  if (Object.keys(keys).length > MAX_ACCESSED_KEYS) {
    const kept = Object.entries(keys)
      .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : a[0] < b[0] ? -1 : 1))
      .slice(0, MAX_ACCESSED_KEYS)
    for (const k of Object.keys(keys)) delete keys[k]
    for (const [k, v] of kept) keys[k] = v
    changed = true
  }
  return { sidecar: { v: 1, keys }, changed }
}

/** Stable JSON: keys sorted, so an unchanged sidecar re-encrypts to the same hash. */
export function serializeAccessed(sidecar: AccessedSidecar): string {
  const keys: Record<string, string> = {}
  for (const k of Object.keys(sidecar.keys).sort()) keys[k] = sidecar.keys[k] as string
  return JSON.stringify({ v: 1, keys })
}

/** The stored sidecar, or an empty one when the namespace or the key does not exist. */
export async function readAccessed(client: AccessedClient, ns: string): Promise<AccessedSidecar> {
  try {
    return parseAccessed(await client.entry(ns, ACCESSED_KEY))
  } catch (e) {
    if (e instanceof OpenRecallHttpError && e.status === 404) return { v: 1, keys: {} }
    throw e
  }
}

/**
 * Read the sidecar and fold `pending` into it. Returns the content to push,
 * or null when the stored sidecar already records everything pending.
 */
export async function prepareAccessed(
  client: AccessedClient,
  ns: string,
  pending: Map<string, string>,
): Promise<string | null> {
  if (pending.size === 0) return null
  const { sidecar, changed } = mergeAccessed(await readAccessed(client, ns), pending)
  return changed ? serializeAccessed(sidecar) : null
}

/**
 * True for a 409 whose conflicts name the sidecar and nothing else: the one
 * refusal the tool layer resolves by itself. A 409 that names any other key
 * is the agent's to resolve and is rendered as today.
 */
export function isSidecarOnlyConflict(e: unknown): boolean {
  if (!(e instanceof OpenRecallHttpError) || e.status !== 409) return false
  const raw = e.details?.conflicts
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const keys = Object.keys(raw as Record<string, unknown>)
  return keys.length > 0 && keys.every(k => k === ACCESSED_KEY)
}

/**
 * Drop from `pending` every key whose flushed date is at least its pending
 * date. A key recalled again while the flush was in flight keeps its newer
 * day for the next flush.
 */
export function settleAccess(pending: Map<string, string>, flushed: Map<string, string>): void {
  for (const [k, day] of flushed) {
    const cur = pending.get(k)
    if (cur !== undefined && cur <= day) pending.delete(k)
  }
}

/**
 * Flush `pending` on its own (the threshold path). A sidecar-only 409 is
 * retried once after a re-read; any other failure is swallowed, since a
 * sidecar that did not land is a lost access date and nothing worse. Returns
 * whether something was written.
 */
export async function flushAccessed(
  client: AccessedClient,
  ns: string,
  pending: Map<string, string>,
): Promise<boolean> {
  const snapshot = new Map(pending)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const content = await prepareAccessed(client, ns, snapshot)
      if (content === null) {
        settleAccess(pending, snapshot)
        return false
      }
      await client.push(ns, { [ACCESSED_KEY]: content })
      settleAccess(pending, snapshot)
      return true
    } catch (e) {
      if (attempt === 0 && isSidecarOnlyConflict(e)) continue
      return false
    }
  }
  return false
}
