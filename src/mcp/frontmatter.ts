/**
 * Frontmatter for organized memory notes: a strict YAML-subset parser, a
 * serializer with a fixed key order, and the stamp applied on every save.
 *
 * Why a subset and not a YAML library: the package has zero runtime
 * dependencies, and the notes only ever need flat metadata. Everything this
 * module cannot parse it keeps verbatim, so an agent's richer frontmatter (for
 * example Claude Code's auto-memory `metadata:` nested map) survives a
 * round-trip untouched instead of being dropped or flattened.
 *
 * The block is `---\n…\n---\n` at offset 0, closing at the first later line that
 * is exactly `---` (trailing blanks allowed), which is the same shape
 * `src/mcp/tools.ts` strips before it splits a body into regions and the shape
 * `src/mcp/relevance.ts` reads `description:` out of. A body that starts with
 * `---` and never closes has no frontmatter. The one place this parser is more
 * generous than the tools.ts regex is an empty block (`---\n---\n`), which the
 * regex rejects and this module accepts, so that its own serializer output
 * always parses.
 *
 * Accepted line forms (anything else is opaque, see below):
 *   key: scalar            key: "quoted"  /  key: 'quoted'   (\" and '' escapes)
 *   key: [a, b]            key: true | false                 key:   (empty scalar)
 *   key:                   followed by `  - item` lines (indented or not)
 * Keys match /^[A-Za-z_][\w-]*$/. A plain scalar that contains ` #` is opaque,
 * because YAML would treat the rest as a comment and this parser would not.
 * `|`/`>` block scalars, anchors, tags, flow maps, nested maps and multi-line
 * scalars are all opaque. A duplicate accepted key keeps its first value and
 * drops the rest, which is what `relevance.ts`'s first-match regex sees anyway.
 *
 * Opaque lines (comments, blank lines, nested maps, anything unparsed) are kept
 * in `opaque`, keyed by the accepted key that preceded them in the source ('' for
 * lines before the first key), in source order within each run. The serializer
 * re-emits each run immediately after its anchor key, so the lines travel with
 * the key they followed even though known keys are re-ordered; runs whose
 * anchor key is gone are emitted last. One exception keeps the ranker honest:
 * `id`, `type` and `description` are always the first three lines with nothing
 * between them, and the runs anchored to them (plus the top run) come right
 * after. `relevance.ts` matches `description:` with an unanchored,
 * case-insensitive regex over the whole block, so `description:` must be the
 * first line that can contain that substring and must appear exactly once.
 *
 * Serializer key order: id, type, description, name, tags, created, updated,
 * agent, session, supersedes, superseded_by, expires, locked, status, deleted,
 * then other keys in insertion order, then opaque runs as above. Output is
 * always LF-terminated regardless of the input's line endings. Scalars are
 * quoted only when a plain emission would not round-trip: empty, leading or
 * trailing blank, `: `, `#`, a leading `[`, `-`, `{`, `&`, `*`, `!`, `|`, `>`,
 * `%`, `@`, backtick or quote, the words true/false, or a control character.
 *
 * Stamp rules (`stampForSave`):
 *   id           ULID, kept from the existing note; an agent-supplied id that
 *                differs is replaced and reported in `corrected`.
 *   type         explicit, else the existing note's, else inferred from the key's
 *                first segment when it is user|feedback|project|reference, else
 *                absent (untyped). Any other explicit value is an error.
 *   description  preserved verbatim.
 *   created      existing note's, else ctx.serverUpdatedAt (legacy note), else now.
 *   updated      now.  agent / session  from ctx.
 *                Agent-supplied values for the five fields above are always
 *                overwritten. They are reported in `corrected` only when they
 *                match neither the stored note nor the new stamp: re-saving
 *                what `memory_get` returned carries stale stamps and is not a
 *                correction, while an invented value is.
 *   supersedes   ctx.supersedes, else the agent's; must be a valid entry key
 *                other than the note's own.  superseded_by  same validation.
 *   expires      YYYY-MM-DD, a real calendar date.
 *   tags         list of /^[a-z0-9][a-z0-9-]*$/, de-duplicated, at most 8. A
 *                scalar is split on commas first.
 *   locked       boolean.
 * Every validation failure throws `FrontmatterError`, whose message names the
 * rule, so the tool layer can hand it back to the agent as a refusal.
 */

import { randomBytes } from 'node:crypto'
import { InvalidNameError, validateEntryKey } from '../namespace.ts'

export type FmValue = string | boolean | string[]

export type Frontmatter = {
  fields: Map<string, FmValue>
  opaque: Map<string, string[]>
  body: string
}

export const TYPES = ['user', 'feedback', 'project', 'reference'] as const
export type NoteType = (typeof TYPES)[number]

export class FrontmatterError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message)
    this.name = 'FrontmatterError'
  }
}

export type StampContext = {
  now: string
  agent: string
  session: string
  key: string
  serverUpdatedAt?: string
  supersedes?: string
}

export type Stamped = {
  id: string
  type?: NoteType
  description?: string
  name?: string
  tags?: string[]
  created: string
  updated: string
  agent: string
  session: string
  supersedes?: string
  superseded_by?: string
  expires?: string
  locked?: boolean
  status?: string
  deleted?: string
}

/** Fixed emission order for the known keys. The first three never move. */
const KNOWN_ORDER = [
  'id',
  'type',
  'description',
  'name',
  'tags',
  'created',
  'updated',
  'agent',
  'session',
  'supersedes',
  'superseded_by',
  'expires',
  'locked',
  'status',
  'deleted',
] as const

const HEADER_KEYS = ['id', 'type', 'description'] as const

const KEY_RE = /^[A-Za-z_][\w-]*$/
const KEY_LINE_RE = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/
const LIST_ITEM_RE = /^[ \t]*-[ \t]+(.*)$/
const INDENTED_RE = /^[ \t]+\S/
const DELIM_RE = /^---[ \t]*$/
const TAG_RE = /^[a-z0-9][a-z0-9-]*$/
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
/** Most tags a note may carry; a merge that unions two sides' tags keeps the first eight. */
export const MAX_TAGS = 8

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse the frontmatter block at offset 0. Returns null when there is none
 * (no opening `---` line, or an opening line that never closes).
 */
export function parseFrontmatter(content: string): Frontmatter | null {
  const open = /^---[ \t]*\r?\n/.exec(content)
  if (!open) return null
  const after = content.slice(open[0].length)
  const rawLines = after.split('\n')
  let close = -1
  for (let i = 0; i < rawLines.length; i++) {
    if (DELIM_RE.test(stripCr(rawLines[i]))) {
      close = i
      break
    }
  }
  if (close < 0) return null
  const lines = rawLines.slice(0, close).map(stripCr)
  // Byte offset of the first body character: the closing line plus its newline.
  let consumed = open[0].length
  for (let i = 0; i <= close; i++) consumed += rawLines[i].length + 1
  const body = consumed > content.length ? '' : content.slice(consumed)

  const fields = new Map<string, FmValue>()
  const opaque = new Map<string, string[]>()
  let anchor = ''
  const keep = (line: string) => {
    const run = opaque.get(anchor)
    if (run) run.push(line)
    else opaque.set(anchor, [line])
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const m = KEY_LINE_RE.exec(line)
    if (!m) {
      keep(line)
      i++
      continue
    }
    const key = m[1]
    const rawValue = m[2] === undefined ? '' : m[2].trimEnd()
    // Look ahead: continuation lines decide whether this is a flat entry.
    let j = i + 1
    while (j < lines.length && INDENTED_RE.test(lines[j])) j++
    const hasContinuation = j > i + 1
    let value: FmValue | undefined
    if (rawValue === '') {
      // `key:` alone: an empty scalar, a block list, or a nested map (opaque).
      let k = i + 1
      if (k >= lines.length || !isBlockLine(lines[k])) {
        value = ''
        j = k
      } else {
        const items: string[] = []
        let listOk = true
        while (k < lines.length && isBlockLine(lines[k])) {
          const item = LIST_ITEM_RE.exec(lines[k])
          const parsed = item ? parseScalar(item[1].trimEnd()) : undefined
          if (parsed === undefined) {
            listOk = false
            break
          }
          items.push(String(parsed))
          k++
        }
        if (listOk) value = items
        while (k < lines.length && isBlockLine(lines[k])) k++
        j = k
      }
    } else if (hasContinuation) {
      value = undefined // multi-line scalar or block scalar: opaque
    } else {
      value = parseValue(rawValue)
    }
    if (value === undefined) {
      for (let k = i; k < j; k++) keep(lines[k])
      i = j
      continue
    }
    if (!fields.has(key)) fields.set(key, value)
    anchor = key
    i = j
  }
  return { fields, opaque, body }
}

/** The note without its frontmatter block; the whole note when it has none. */
export function stripFrontmatter(content: string): string {
  const fm = parseFrontmatter(content)
  return fm ? fm.body : content
}

/** A continuation line under a bare `key:`: indented, or a column-0 `- item`. */
function isBlockLine(line: string): boolean {
  return INDENTED_RE.test(line) || /^-[ \t]/.test(line)
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/** A value after `key: `. Undefined means "not in the subset, keep opaque". */
function parseValue(raw: string): FmValue | undefined {
  if (raw.startsWith('[')) return raw.endsWith(']') ? parseFlowList(raw) : undefined
  return parseScalar(raw)
}

function parseScalar(raw: string): string | boolean | undefined {
  if (raw === '') return ''
  const c = raw[0]
  if (c === '"' || c === "'") {
    const q = parseQuoted(raw)
    return q !== undefined && q.rest === '' ? q.value : undefined
  }
  if (raw === 'true') return true
  if (raw === 'false') return false
  // YAML indicators this subset does not implement.
  if ('[]{}&*!|>%@`'.includes(c)) return undefined
  if ((c === '-' || c === '?' || c === ':') && (raw.length === 1 || /\s/.test(raw[1]))) {
    return undefined
  }
  if (raw.includes(' #') || raw.includes('\t#') || c === '#') return undefined
  return raw
}

/** Parse a leading quoted string; `rest` is whatever follows the closing quote. */
function parseQuoted(raw: string): { value: string; rest: string } | undefined {
  const q = raw[0]
  let out = ''
  let i = 1
  while (i < raw.length) {
    const ch = raw[i]
    if (q === '"' && ch === '\\') {
      const n = raw[i + 1]
      if (n === '"' || n === '\\') out += n
      else if (n === 'n') out += '\n'
      else if (n === 't') out += '\t'
      else if (n === 'r') out += '\r'
      else return undefined
      i += 2
      continue
    }
    if (ch === q) {
      if (q === "'" && raw[i + 1] === "'") {
        out += "'"
        i += 2
        continue
      }
      return { value: out, rest: raw.slice(i + 1) }
    }
    out += ch
    i++
  }
  return undefined
}

function parseFlowList(raw: string): string[] | undefined {
  const inner = raw.slice(1, -1).trim()
  if (inner === '') return []
  const items: string[] = []
  let rest = inner
  for (;;) {
    rest = rest.trimStart()
    let item: string
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const q = parseQuoted(rest)
      if (!q) return undefined
      item = q.value
      rest = q.rest.trimStart()
      if (rest !== '' && !rest.startsWith(',')) return undefined
    } else {
      const comma = rest.indexOf(',')
      const plain = comma < 0 ? rest : rest.slice(0, comma)
      const s = parseScalar(plain.trim())
      if (s === undefined || s === '') return undefined
      item = String(s)
      rest = comma < 0 ? '' : rest.slice(comma)
    }
    items.push(item)
    if (rest === '') return items
    rest = rest.slice(1) // the comma
    if (rest.trim() === '') return undefined // trailing comma
  }
}

// ---------------------------------------------------------------------------
// Serializing
// ---------------------------------------------------------------------------

/**
 * Emit a frontmatter block (`---\n…\n---\n`). `opaque` may be the map returned
 * by `parseFrontmatter` or a plain list, which is emitted after every key.
 */
export function serializeFrontmatter(
  fields: Map<string, FmValue>,
  opaque: Map<string, string[]> | string[] = [],
): string {
  const runs = Array.isArray(opaque) ? new Map<string, string[]>() : opaque
  const tail = Array.isArray(opaque) ? opaque : []
  const out: string[] = ['---']
  const emitted = new Set<string>()
  const emitRun = (anchor: string) => {
    const run = runs.get(anchor)
    if (run) {
      out.push(...run)
      emitted.add(anchor)
    }
  }
  const emitKey = (key: string) => {
    const v = fields.get(key)
    if (v === undefined) return
    out.push(`${key}: ${formatValue(v)}`)
  }
  for (const key of HEADER_KEYS) emitKey(key)
  emitRun('')
  for (const key of HEADER_KEYS) if (fields.has(key)) emitRun(key)
  for (const key of KNOWN_ORDER.slice(HEADER_KEYS.length)) {
    if (!fields.has(key)) continue
    emitKey(key)
    emitRun(key)
  }
  for (const key of fields.keys()) {
    if ((KNOWN_ORDER as readonly string[]).includes(key)) continue
    if (!KEY_RE.test(key)) throw new FrontmatterError(`invalid frontmatter key: ${key}`, key)
    emitKey(key)
    emitRun(key)
  }
  for (const anchor of runs.keys()) if (!emitted.has(anchor)) emitRun(anchor)
  out.push(...tail, '---')
  return `${out.join('\n')}\n`
}

/** One field's value as the serializer writes it after `key: `. */
export function formatValue(v: FmValue): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (Array.isArray(v)) return `[${v.map(formatListItem).join(', ')}]`
  return formatScalar(v)
}

function needsQuotes(s: string): boolean {
  if (s === '' || s === 'true' || s === 'false') return true
  if (s !== s.trim()) return true
  if (s.includes(': ') || s.endsWith(':') || s.includes('#')) return true
  if ('[]{}&*!|>%@`"\'-?:,'.includes(s[0])) return true
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}

function formatScalar(s: string): string {
  return needsQuotes(s) ? quote(s) : s
}

function formatListItem(s: string): string {
  return needsQuotes(s) || /[,[\]]/.test(s) ? quote(s) : s
}

function quote(s: string): string {
  return `"${s.replace(/[\\"\n\t\r]/g, ch => {
    if (ch === '\n') return '\\n'
    if (ch === '\t') return '\\t'
    if (ch === '\r') return '\\r'
    return `\\${ch}`
  })}"`
}

// ---------------------------------------------------------------------------
// ULID and type inference
// ---------------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * A ULID for the given millisecond timestamp: 10 chars of time (48 bits) then
 * 16 chars of randomness (80 bits from `node:crypto`), Crockford base32. Ids
 * sort by creation time at millisecond resolution; within one millisecond the
 * order is random.
 */
export function ulid(now: number): string {
  if (!Number.isInteger(now) || now < 0 || now >= 2 ** 48) {
    throw new RangeError(`ulid: timestamp out of range: ${now}`)
  }
  let t = now
  let time = ''
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time
    t = Math.floor(t / 32)
  }
  let r = BigInt(`0x${randomBytes(10).toString('hex')}`)
  let rand = ''
  for (let i = 0; i < 16; i++) {
    rand = CROCKFORD[Number(r % 32n)] + rand
    r /= 32n
  }
  return time + rand
}

/** The note type implied by the key's first path segment, if it names one. */
export function inferType(key: string): NoteType | undefined {
  const slash = key.indexOf('/')
  if (slash < 0) return undefined
  const first = key.slice(0, slash)
  return (TYPES as readonly string[]).includes(first) ? (first as NoteType) : undefined
}

// ---------------------------------------------------------------------------
// Stamping
// ---------------------------------------------------------------------------

/**
 * Apply the save-time stamp to `incoming`, consulting `existing` (the note
 * currently stored under the same key, or null on create). See the header for
 * the rules. `corrected` lists the fields whose agent-supplied value was
 * overwritten.
 */
export function stampForSave(
  existing: string | null,
  incoming: string,
  ctx: StampContext,
): { content: string; corrected: string[]; meta: Stamped } {
  const nowMs = Date.parse(ctx.now)
  if (Number.isNaN(nowMs)) throw new FrontmatterError(`now must be an ISO timestamp`, 'updated')
  const inc = parseFrontmatter(incoming) ?? {
    fields: new Map<string, FmValue>(),
    opaque: new Map<string, string[]>(),
    body: incoming,
  }
  const prior = existing === null ? null : (parseFrontmatter(existing)?.fields ?? null)
  const fields = new Map(inc.fields)
  const corrected: string[] = []
  const stamp = (key: string, value: FmValue) => {
    const supplied = fields.get(key)
    const stored = prior?.get(key)
    const carried = stored !== undefined && sameValue(supplied ?? '', stored)
    if (supplied !== undefined && !sameValue(supplied, value) && !carried) corrected.push(key)
    fields.set(key, value)
  }

  const priorId = prior?.get('id')
  const id = typeof priorId === 'string' && priorId !== '' ? priorId : ulid(nowMs)
  stamp('id', id)

  const type = resolveType(fields.get('type'), prior?.get('type'), ctx.key)
  if (type) fields.set('type', type)
  else fields.delete('type')

  const description = fields.get('description')
  if (description !== undefined && typeof description !== 'string') {
    throw new FrontmatterError('description must be a single string', 'description')
  }

  const priorCreated = prior?.get('created')
  const created =
    typeof priorCreated === 'string' && priorCreated !== ''
      ? priorCreated
      : (ctx.serverUpdatedAt ?? ctx.now)
  stamp('created', created)
  stamp('updated', ctx.now)
  stamp('agent', ctx.agent)
  stamp('session', ctx.session)

  if (ctx.supersedes !== undefined) fields.set('supersedes', ctx.supersedes)
  for (const key of ['supersedes', 'superseded_by'] as const) {
    const v = fields.get(key)
    if (v === undefined) continue
    if (typeof v !== 'string' || v === '') {
      throw new FrontmatterError(`${key} must be an entry key`, key)
    }
    try {
      validateEntryKey(v)
    } catch (e) {
      if (e instanceof InvalidNameError) {
        throw new FrontmatterError(`${key} must be a valid entry key: ${e.message}`, key)
      }
      throw e
    }
    if (v === ctx.key) throw new FrontmatterError(`${key} must not name the note itself`, key)
  }

  const expires = fields.get('expires')
  if (expires !== undefined) {
    if (typeof expires !== 'string' || !isCalendarDate(expires)) {
      throw new FrontmatterError('expires must be a calendar date in YYYY-MM-DD form', 'expires')
    }
  }

  const rawTags = fields.get('tags')
  if (rawTags !== undefined) fields.set('tags', validateTags(rawTags))

  const locked = fields.get('locked')
  if (locked !== undefined && typeof locked !== 'boolean') {
    throw new FrontmatterError('locked must be true or false', 'locked')
  }

  const content = serializeFrontmatter(fields, inc.opaque) + inc.body
  return { content, corrected, meta: toStamped(fields) }
}

function resolveType(explicit: FmValue | undefined, prior: FmValue | undefined, key: string) {
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !(TYPES as readonly string[]).includes(explicit)) {
      throw new FrontmatterError(`type must be one of ${TYPES.join(', ')}`, 'type')
    }
    return explicit as NoteType
  }
  if (typeof prior === 'string' && (TYPES as readonly string[]).includes(prior)) {
    return prior as NoteType
  }
  return inferType(key)
}

function validateTags(raw: FmValue): string[] {
  let list: string[]
  if (Array.isArray(raw)) list = raw
  else if (typeof raw === 'string') {
    list = raw
      .split(',')
      .map(s => s.trim())
      .filter(s => s !== '')
  } else throw new FrontmatterError('tags must be a list', 'tags')
  const tags: string[] = []
  for (const t of list) {
    if (!TAG_RE.test(t)) {
      throw new FrontmatterError(
        `tag ${JSON.stringify(t)} must match ${TAG_RE} (lowercase letters, digits and hyphens)`,
        'tags',
      )
    }
    if (!tags.includes(t)) tags.push(t)
  }
  if (tags.length > MAX_TAGS) {
    throw new FrontmatterError(`at most ${MAX_TAGS} tags are allowed`, 'tags')
  }
  return tags
}

function isCalendarDate(s: string): boolean {
  const m = DATE_RE.exec(s)
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1) return false
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate()
}

function sameValue(a: FmValue, b: FmValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i])
    )
  }
  return a === b
}

function toStamped(fields: Map<string, FmValue>): Stamped {
  const str = (k: string) => {
    const v = fields.get(k)
    return typeof v === 'string' ? v : undefined
  }
  const meta: Stamped = {
    id: str('id') ?? '',
    created: str('created') ?? '',
    updated: str('updated') ?? '',
    agent: str('agent') ?? '',
    session: str('session') ?? '',
  }
  const type = str('type')
  if (type) meta.type = type as NoteType
  for (const k of [
    'description',
    'name',
    'supersedes',
    'superseded_by',
    'expires',
    'status',
    'deleted',
  ] as const) {
    const v = str(k)
    if (v !== undefined) meta[k] = v
  }
  const tags = fields.get('tags')
  if (Array.isArray(tags)) meta.tags = tags
  const locked = fields.get('locked')
  if (typeof locked === 'boolean') meta.locked = locked
  return meta
}
