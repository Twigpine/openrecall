/**
 * The generated `MEMORY.md`.
 *
 * The memory guidance asks agents to keep a table of contents at the namespace
 * root, and a hand-maintained one drifts: notes get saved without a line, lines
 * outlive their notes, and two agents editing it at once lose each other's
 * edits. This module makes the index a projection of the notes that exist,
 * regenerated on every save from already-parsed metadata (`IndexNote`), with
 * one hand-edited region that survives: the `## Pinned` section.
 *
 * Rules:
 *
 * - The document opens with `# Memory index`, then `GENERATED_MARKER`, then
 *   `## Pinned` and the pinned lines (always present, possibly empty), then
 *   one `## <type>` section per non-empty type in the order user, feedback,
 *   project, reference, other.
 * - Each listed note is `- [name](key) — description`: name is the `name`
 *   field or the key's basename without `.md`; the description is clipped to
 *   120 characters. Hidden keys (`isHiddenKey`), notes whose status is not
 *   active, and notes expired before `now` are not listed. Within a section
 *   the newest `updated` comes first; notes without one come last, by key.
 * - Caps: 200 lines and 25,000 UTF-8 bytes. Over either, the oldest entries
 *   are dropped round-robin across the sections until it fits, and a final
 *   line says how many are not listed. `nearCap` is reported at 180 lines or
 *   22,500 bytes so the caller can warn before the cut happens.
 * - Pinned lines are preserved verbatim, at most `MAX_PINNED` of them; a
 *   pinned line that is itself an h1/h2 heading is escaped so it cannot end
 *   its own section on the next parse.
 * - A hand-maintained index (no marker) is parsed for adoption: its link
 *   lines are dropped (the generator re-derives them) and its remaining prose
 *   lines are returned as `legacyLines`, which the caller may make the first
 *   Pinned block.
 * - Same notes, same pinned lines, same clock: byte-identical output.
 * - `indexNoteOf` is the one bridge from a stored note to an `IndexNote`: the
 *   frontmatter fields the index reads, with the type inferred from the key
 *   (as the save stamp infers it) when the note carries none and the server's
 *   timestamp standing in for `updated` on a note that was never stamped, so
 *   a legacy `project/deploy.md` is filed under project. `linkTarget` reads
 *   the key a hand-written index line points at, so the caller can count the
 *   lines of a legacy index that name notes which no longer exist.
 */

import { inferType, parseFrontmatter } from './frontmatter.ts'
import { isHiddenKey } from './keys.ts'

export type IndexStatus = 'active' | 'superseded' | 'deleted'

/** A note as the index sees it: parsed metadata only, no body. */
export type IndexNote = {
  key: string
  name?: string
  description?: string
  type?: string
  /** ISO timestamp or date; compared as a string, so ISO order is newest-last. */
  updated?: string
  /** Absent means active. */
  status?: IndexStatus
  /** `YYYY-MM-DD` (or a longer ISO string); expired strictly before today's date. */
  expires?: string
}

export type ParsedIndex = {
  /** True when the text carries the generated marker. */
  generated: boolean
  /** Verbatim lines of the first `## Pinned` section, at most `MAX_PINNED`. */
  pinned: string[]
  /** For a hand-maintained index: its non-link, non-heading, non-blank lines outside Pinned. */
  legacyLines: string[]
}

export type GeneratedIndex = {
  text: string
  lines: number
  bytes: number
  /** Notes that were eligible but dropped to fit the caps. */
  truncated: number
  /** True at or above `NEAR_CAP_LINES` lines or `NEAR_CAP_BYTES` bytes. */
  nearCap: boolean
}

export const GENERATED_MARKER =
  '<!-- openrecall:generated v1 — edit only the Pinned section; the rest is regenerated on every save -->'

/** What identifies a generated index of any version. */
const MARKER_PREFIX = '<!-- openrecall:generated'

export const TITLE_LINE = '# Memory index'
export const PINNED_HEADING = '## Pinned'

export const MAX_PINNED = 20
export const MAX_LINES = 200
export const MAX_BYTES = 25_000
export const NEAR_CAP_LINES = 180
export const NEAR_CAP_BYTES = 22_500

/** Characters of a description kept on an index line. */
export const DESCRIPTION_CLIP = 120

/** Section order. Anything else, including an absent type, is `other`. */
export const TYPE_ORDER = ['user', 'feedback', 'project', 'reference'] as const
export const OTHER_TYPE = 'other'

const encoder = new TextEncoder()

/** UTF-8 length of a string; the cap is in bytes because the server's is. */
export function utf8Length(s: string): number {
  return encoder.encode(s).length
}

/**
 * A line the generator would have produced, or a hand-written equivalent: a
 * list item holding a markdown link, or a key followed by a separator. Such
 * lines are never adopted as legacy content.
 */
const LINK_LINE =
  /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(?:\[[^\]]*\]\(([^)]*)\)|(\S+\.md)(?:\s*[:—–-]|\s*$)|([A-Za-z0-9][\w.-]*\/[\w./-]+)\s*[:—–-])/

export function isLinkLine(line: string): boolean {
  return LINK_LINE.test(line)
}

/**
 * The key a link line points at: the target of its markdown link, or the bare
 * key it opens with. Null for a line that is not a link line. A markdown
 * target's optional `<…>` wrapper and title are stripped; what remains is
 * whatever the author wrote, which the caller checks against the keys that
 * exist rather than validating here.
 */
export function linkTarget(line: string): string | null {
  const m = LINK_LINE.exec(line)
  if (!m) return null
  if (m[1] !== undefined) {
    const target = m[1].trim()
    const angled = /^<([^>]*)>/.exec(target)
    return (angled ? angled[1] : target.split(/\s/)[0]).trim() || null
  }
  return (m[2] ?? m[3] ?? '').trim() || null
}

const INDEX_STATUSES: readonly string[] = ['active', 'superseded', 'deleted']

/**
 * A stored note as the index sees it. Only string-valued fields are read; a
 * `status` outside the index's own set is treated as active, since the index
 * hides a note for the two statuses it knows and has no opinion on others.
 * The type falls back to the key's first segment, as `stampForSave` infers
 * it; `serverUpdatedAt` stands in for `updated` on a note with no stamp.
 */
export function indexNoteOf(key: string, content: string, serverUpdatedAt?: string): IndexNote {
  const fields = parseFrontmatter(content)?.fields
  const str = (name: string): string | undefined => {
    const v = fields?.get(name)
    return typeof v === 'string' && v !== '' ? v : undefined
  }
  const status = str('status')
  const note: IndexNote = { key }
  const name = str('name')
  if (name !== undefined) note.name = name
  const description = str('description')
  if (description !== undefined) note.description = description
  const type = str('type') ?? inferType(key)
  if (type !== undefined) note.type = type
  const updated = str('updated') ?? serverUpdatedAt
  if (updated !== undefined) note.updated = updated
  if (status !== undefined && INDEX_STATUSES.includes(status)) note.status = status as IndexStatus
  const expires = str('expires')
  if (expires !== undefined) note.expires = expires
  return note
}

/** An h1 or h2 heading: the only lines that end a Pinned section. */
const SECTION_HEADING = /^#{1,2}\s/

/** Any ATX heading, dropped from legacy adoption. */
const ANY_HEADING = /^#{1,6}(\s|$)/

const PINNED_HEADING_RE = /^##\s+pinned\s*$/i

function trimBlankEnds(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && lines[start].trim() === '') start++
  while (end > start && lines[end - 1].trim() === '') end--
  return lines.slice(start, end)
}

/**
 * Read an existing index. `null` (no index yet) parses as not generated with
 * nothing pinned and nothing to adopt.
 */
export function parseIndex(existing: string | null): ParsedIndex {
  if (existing === null || existing === '') return { generated: false, pinned: [], legacyLines: [] }
  const lines = existing.split(/\r?\n/)
  const generated = lines.some(l => l.trimStart().startsWith(MARKER_PREFIX))

  let pinned: string[] = []
  let pinnedStart = -1
  let pinnedEnd = -1
  const heading = lines.findIndex(l => PINNED_HEADING_RE.test(l.trim()))
  if (heading >= 0) {
    pinnedStart = heading
    pinnedEnd = lines.length
    for (let i = heading + 1; i < lines.length; i++) {
      if (SECTION_HEADING.test(lines[i])) {
        pinnedEnd = i
        break
      }
    }
    pinned = trimBlankEnds(lines.slice(heading + 1, pinnedEnd)).slice(0, MAX_PINNED)
  }

  const legacyLines: string[] = []
  if (!generated) {
    for (let i = 0; i < lines.length; i++) {
      if (i >= pinnedStart && i < pinnedEnd) continue
      const line = lines[i].trimEnd()
      if (line.trim() === '' || ANY_HEADING.test(line) || isLinkLine(line)) continue
      legacyLines.push(line)
    }
  }
  return { generated, pinned, legacyLines }
}

/** True when `expires` names a date strictly before `now`'s UTC date. Malformed never expires. */
export function isExpired(expires: string | undefined, now: Date): boolean {
  if (!expires || !/^\d{4}-\d{2}-\d{2}/.test(expires)) return false
  return expires.slice(0, 10) < now.toISOString().slice(0, 10)
}

function basename(key: string): string {
  const last = key.slice(key.lastIndexOf('/') + 1)
  return last.endsWith('.md') ? last.slice(0, -3) : last
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function clip(s: string, max: number): string {
  const flat = oneLine(s)
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function entryLine(note: IndexNote): string {
  const name = oneLine(note.name ?? basename(note.key)).replace(/[[\]]/g, m => `\\${m}`)
  const description = note.description ? clip(note.description, DESCRIPTION_CLIP) : ''
  return `- [${name}](${note.key})${description ? ` — ${description}` : ''}`
}

function compareNotes(a: IndexNote, b: IndexNote): number {
  const ua = a.updated ?? ''
  const ub = b.updated ?? ''
  if (ua !== ub) {
    if (ua === '') return 1
    if (ub === '') return -1
    return ua > ub ? -1 : 1
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

function groupName(type: string | undefined): string {
  return (TYPE_ORDER as readonly string[]).includes(type ?? '') ? (type as string) : OTHER_TYPE
}

/** A pinned line that is an h1/h2 heading would end the section on the next parse; escape it. */
function escapePinned(line: string): string {
  return SECTION_HEADING.test(line) ? `\\${line}` : line
}

type Group = { heading: string; lines: string[] }

/** Lay out the whole document from the groups as they currently stand. */
function layout(pinned: string[], groups: Group[], truncated: number): string[] {
  const out = [TITLE_LINE, GENERATED_MARKER, '', PINNED_HEADING, ...pinned]
  for (const g of groups) {
    if (g.lines.length === 0) continue
    out.push('', g.heading, ...g.lines)
  }
  if (truncated > 0)
    out.push('', `… ${truncated} more entries not listed; memory_list shows every key`)
  return out
}

function measure(lines: string[]): { lines: number; bytes: number } {
  let bytes = lines.length > 0 ? lines.length - 1 : 0
  for (const l of lines) bytes += utf8Length(l)
  return { lines: lines.length, bytes }
}

/**
 * Build the index text for `notes`. `pinned` is kept verbatim (first
 * `MAX_PINNED` lines); `now` decides which notes have expired.
 */
export function generateIndex(notes: IndexNote[], pinned: string[], now: Date): GeneratedIndex {
  const kept = pinned.slice(0, MAX_PINNED).map(escapePinned)

  const byGroup = new Map<string, IndexNote[]>()
  for (const name of [...TYPE_ORDER, OTHER_TYPE]) byGroup.set(name, [])
  for (const note of notes) {
    if (isHiddenKey(note.key)) continue
    if ((note.status ?? 'active') !== 'active') continue
    if (isExpired(note.expires, now)) continue
    byGroup.get(groupName(note.type))!.push(note)
  }
  const groups: Group[] = []
  for (const [name, members] of byGroup) {
    members.sort(compareNotes)
    groups.push({ heading: `## ${name}`, lines: members.map(entryLine) })
  }

  // Drop the oldest entries round-robin across the non-empty groups until the
  // document fits. One entry is one line, so most of a line overage is dropped
  // as a batch before re-measuring; the batch is sized to never drop an entry
  // that could have stayed (a group that empties also takes its heading and
  // spacer, and the tail adds two lines the first time, so both are held back
  // as a margin) and the loop finishes one entry at a time. Bytes are batched
  // by the longest remaining line for the same reason.
  let truncated = 0
  let rr = -1
  const dropOne = (): boolean => {
    if (groups.every(g => g.lines.length === 0)) return false
    do rr = (rr + 1) % groups.length
    while (groups[rr].lines.length === 0)
    groups[rr].lines.pop()
    truncated++
    return true
  }
  let doc = layout(kept, groups, truncated)
  let size = measure(doc)
  while (size.lines > MAX_LINES || size.bytes > MAX_BYTES) {
    const nonEmpty = groups.filter(g => g.lines.length > 0).length
    let longest = 1
    for (const g of groups) for (const l of g.lines) longest = Math.max(longest, utf8Length(l) + 1)
    const byLines = size.lines - MAX_LINES + (truncated === 0 ? 2 : 0) - 2 * nonEmpty
    const byBytes = Math.floor((size.bytes - MAX_BYTES) / longest) - nonEmpty
    let batch = Math.max(1, byLines, byBytes)
    let dropped = false
    while (batch-- > 0 && dropOne()) dropped = true
    if (!dropped) break
    doc = layout(kept, groups, truncated)
    size = measure(doc)
  }

  return {
    text: doc.join('\n'),
    lines: size.lines,
    bytes: size.bytes,
    truncated,
    nearCap: size.lines >= NEAR_CAP_LINES || size.bytes >= NEAR_CAP_BYTES,
  }
}
