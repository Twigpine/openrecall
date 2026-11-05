/**
 * The doctor: an audit of one namespace's notes that proposes operations and
 * writes nothing.
 *
 * Organized memory accumulates drift that no single save can see: a note
 * whose index line was never written, a pinned line pointing at a note that
 * was deleted, two notes that say the same thing under different keys, a
 * fact past its `expires` date, a `superseded_by` naming a note that is gone,
 * trash nobody emptied, a namespace creeping toward its entry cap. The doctor
 * walks the whole namespace once, names each of these with the keys involved,
 * and says which existing tool call fixes it. It decides nothing and changes
 * nothing; the agent (or the person reading `openrecall doctor`) does.
 *
 * Input is ALREADY-DECRYPTED plaintext plus parsed-at-pull metadata
 * (`DoctorInput`): every key in the namespace, bookkeeping entries included,
 * the server's `updatedAt` for legacy notes without a stamp, the access-date
 * sidecar, the clock, and the caps. Nothing here touches a client, a store or
 * the network, and nothing here is wired to a tool yet.
 *
 * Finding kinds, in report order, and their rules:
 *
 * - index-missing: an active, non-hidden, unexpired note with no link line in
 *   `MEMORY.md`. When there is no index at all, one finding says so. When the
 *   index carries the generator's `… N more entries not listed` tail it is at
 *   its cap and the unlisted notes are expected, so none are reported.
 * - index-dangling: a link line (Pinned, generated or legacy) whose target is
 *   not a key in the namespace. Targets are taken from `[..](key)` links, or
 *   from the bare `key.md:` / `dir/key —` forms `isLinkLine` accepts; a target
 *   that is not a well-formed entry key (a URL, an anchor) is not a link to a
 *   note and is ignored.
 * - near-duplicate: an unordered pair of active, non-hidden notes that the
 *   save gate would report at `duplicate`, `key-twin`, `near-duplicate` or
 *   `possible-contradiction` level. The gate's own detectors decide
 *   (`findCandidates`, one call per note over that note's candidates), so the
 *   doctor never disagrees with the gate; what the doctor adds is candidate
 *   generation that stays cheap at the cap: LSH banding of the 64-slot MinHash
 *   signatures into `LSH_BANDS` bands of `LSH_ROWS` rows for the notes the
 *   gate scores by shingles (a pair is a candidate when one band matches,
 *   which at 8×8 catches a verbatim copy always and a 0.8-Jaccard copy about
 *   three times in four), a 32-slot MinHash over the content-token set banded
 *   8×4 for every note (the set the gate's short-text rule compares exactly,
 *   and the only signature a short note gets: the shingle signature costs
 *   80 µs a note and most memory notes are short), key twins by
 *   `normalizeKey`, and for the contradiction detector an inverted index over
 *   description and title tokens restricted to the same first path segment and
 *   to tokens rare enough (`topicDfCap`) not to pair everything with
 *   everything. Each note contributes at most `PER_TARGET_CANDIDATES` pairs and
 *   the whole pass verifies at most `PAIR_BUDGET`; past that a last
 *   near-duplicate finding with no keys says the search stopped, because a
 *   namespace of two thousand restatements has two million pairs and the
 *   report shows five.
 * - expired: `expires` strictly before today's UTC date.
 * - stale: nothing has touched the note within its type's horizon, measured
 *   from the later of `updated` and the sidecar's access date: project 90 d,
 *   reference 180 d, user and feedback 365 d, untyped 180 d. Reported as
 *   "verify or supersede"; a note with neither stamp is not judged.
 * - dangling-link: `supersedes` or `superseded_by` naming a key that does not
 *   exist; the detail says when the target is in the trash.
 * - trash-old: a `sys.openrecall/trash/*` entry whose `deleted` stamp (or the
 *   server's `updatedAt`) is more than `TRASH_OLD_DAYS` old.
 * - cross-namespace-twin (`runDoctorAcross` only): the same `normalizeKey` in
 *   two namespaces, or a pair the gate scores at `duplicate` level across
 *   namespaces, found with the same banding over the union of the notes.
 * - untyped: an active, non-hidden note with no `type` the stamp could
 *   resolve: no valid `type:` field and a first path segment that is not one
 *   of the four types.
 * - history-near-cap: the namespace holds `HISTORY_WARN_ENTRIES` entries or
 *   more; version history stops being recorded at `HISTORY_STOP_ENTRIES`.
 *
 * Meters count every entry, bookkeeping included, because the server's caps
 * do. Bytes are plaintext UTF-8 plus the 29-byte ciphertext envelope per
 * entry, which is what the server measures against `maxNamespaceBytes`.
 *
 * `renderReport` is the text a tool result or the CLI shows: the meters line,
 * then one section per finding kind in the order above, each capped at
 * `SECTION_ITEMS` lines with a count of the rest, every key and detail passed
 * through `neutralize`, and the whole thing held under `maxChars` by dropping
 * whole sections from the end and saying so.
 *
 * `isDue`, `markerKey`, `readMarker` and `writeMarker` are the scheduling
 * side: a run is due with no marker, after `DUE_AFTER_MS`, or after
 * `DUE_AFTER_VERSIONS` mutating writes. The marker file maps
 * `sha256(namespace)` to `{ ranAt, version, findings }`, holds no memory
 * content, and is written 0600 under a 0700 directory; a read error reads as
 * no markers and a write error is reported as `false`, never thrown, because
 * an unwritable state directory must not stop a recall.
 */

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { sha256Hex } from '../hash.ts'
import { validateEntryKey } from '../namespace.ts'
import { type FmValue, inferType, parseFrontmatter, TYPES } from './frontmatter.ts'
import {
  buildIdf,
  type CandidateReason,
  findCandidates,
  fnv1a,
  type GateNote,
  type Idf,
  MINHASH_PERMS,
  minhashSignature,
  type NoteProfile,
  profileNote,
} from './gate.ts'
import { HISTORY_STOP_ENTRIES, HISTORY_WARN_ENTRIES } from './history.ts'
import {
  HISTORY_PREFIX,
  INDEX_BASENAME,
  isHiddenKey,
  normalizeKey,
  TRASH_PREFIX,
  trashKey,
} from './keys.ts'
import { isExpired, isLinkLine, MAX_BYTES, MAX_LINES, parseIndex, utf8Length } from './memindex.ts'
import { neutralize } from './sanitize.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DoctorInput = {
  namespace: string
  /** key → plaintext, every key in the namespace including `sys.openrecall/*` and `MEMORY.md`. */
  entries: Record<string, string>
  /** key → server `updatedAt` (ISO), for legacy notes with no `updated` stamp. */
  updatedAt?: Record<string, string | undefined>
  /** key → `YYYY-MM-DD` from the access sidecar. */
  accessed?: Record<string, string>
  /** ISO timestamp of the run. */
  now: string
  /** The server's per-namespace caps. Defaults to `DEFAULT_CAPS`. */
  caps?: { maxEntries: number; maxBytes: number }
}

export type FindingKind =
  | 'index-missing'
  | 'index-dangling'
  | 'near-duplicate'
  | 'expired'
  | 'stale'
  | 'dangling-link'
  | 'trash-old'
  | 'cross-namespace-twin'
  | 'untyped'
  | 'history-near-cap'

export type Finding = {
  kind: FindingKind
  /** The notes involved; empty for a namespace-level finding. */
  keys: string[]
  /** What was found. Plain text; neutralized when rendered. */
  detail: string
  /** The fix, phrased with the existing tools. */
  suggest: string
}

export type DoctorMeters = {
  entries: number
  bytes: number
  indexLines: number
  indexBytes: number
  history: number
  trash: number
  capEntries: number
  capBytes: number
}

export type DoctorReport = {
  namespace: string
  meters: DoctorMeters
  findings: Finding[]
}

export type DoctorMarker = { ranAt: string; version: number; findings: number }
export type DoctorMarkers = Record<string, DoctorMarker>

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Report order of the sections. */
export const KIND_ORDER: readonly FindingKind[] = [
  'index-missing',
  'index-dangling',
  'near-duplicate',
  'expired',
  'stale',
  'dangling-link',
  'trash-old',
  'cross-namespace-twin',
  'untyped',
  'history-near-cap',
]

/** The server's defaults for `config.limits.maxEntriesPerNamespace` and `maxNamespaceBytes`. */
export const DEFAULT_CAPS = { maxEntries: 2_000, maxBytes: 10_000_000 } as const

/** Bytes the ciphertext envelope adds to every entry: version, nonce and GCM tag. */
export const ENVELOPE_BYTES = 29

/** Days since the later of `updated` and the access date, per type, after which a note is stale. */
export const STALE_HORIZON_DAYS: Readonly<Record<string, number>> = {
  project: 90,
  reference: 180,
  user: 365,
  feedback: 365,
}

/** Horizon for a note with no resolvable type. */
export const STALE_HORIZON_UNTYPED_DAYS = 180

/** Days in the trash after which the doctor proposes a hard delete. */
export const TRASH_OLD_DAYS = 30

/** Items shown per section before `… and N more`. */
export const SECTION_ITEMS = 5

/** Characters `renderReport` never exceeds unless told otherwise. */
export const DEFAULT_MAX_CHARS = 2_000

/** Characters of a description shown in a finding. */
export const DESCRIPTION_CLIP = 60

/** A run is due this long after the last one. */
export const DUE_AFTER_MS = 24 * 60 * 60 * 1000

/** A run is due after this many mutating writes since the last one. */
export const DUE_AFTER_VERSIONS = 10

/** LSH banding of the MinHash signature: bands × rows must equal `MINHASH_PERMS`. */
export const LSH_BANDS = 8
export const LSH_ROWS = 8

/** Candidate pairs one note may contribute. */
export const PER_TARGET_CANDIDATES = 16

/** Candidate pairs one pass verifies before it stops and says so. */
export const PAIR_BUDGET = 20_000

if (LSH_BANDS * LSH_ROWS !== MINHASH_PERMS) {
  throw new Error('doctor: LSH_BANDS × LSH_ROWS must equal MINHASH_PERMS')
}

/**
 * The token-set signature: 32 slots banded 8 × 4, so a pair is a candidate
 * when one band of four slots agrees. At token Jaccard 1 that is certain, at
 * 0.75 about nineteen times in twenty, at 0.5 about two times in five; the
 * contradiction index (shared rare description tokens in one segment) is the
 * second net for same-topic pairs the bands miss.
 */
export const TOKEN_PERMS = 32
export const TOKEN_BANDS = 8
export const TOKEN_ROWS = 4

if (TOKEN_BANDS * TOKEN_ROWS !== TOKEN_PERMS) {
  throw new Error('doctor: TOKEN_BANDS × TOKEN_ROWS must equal TOKEN_PERMS')
}

/** One fixed odd seed per token-signature slot, derived so it never changes. */
const TOKEN_SEEDS: Uint32Array = Uint32Array.from(
  { length: TOKEN_PERMS },
  (_, i) => fnv1a(`openrecall-doctor-token-slot-${i}`) | 1,
)

/** Signature slot value for "no shingle seen" (mirrors the gate's EMPTY_SLOT). */
const EMPTY_SLOT = 0xffffffff

const DAY_MS = 24 * 60 * 60 * 1000

const TRUNCATED_LINE = '(report truncated)'

const INDEX_TAIL = /^… \d+ more entries not listed/

const MD_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g

const BARE_LINK = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?(\S+?)(?:\s*[:—–-](?:\s|$)|\s*$)/

/** The gate levels the near-duplicate section reports. */
const PAIR_LEVELS: ReadonlySet<CandidateReason> = new Set([
  'duplicate',
  'key-twin',
  'near-duplicate',
  'possible-contradiction',
])

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/** One parsed entry, as the doctor sees it. */
type Note = {
  key: string
  hidden: boolean
  /** The type the stamp would resolve: a valid `type:` field, else the key's first segment. */
  type?: string
  /** The `type:` field as written, when it is not one of the four. */
  rawType?: string
  description: string
  name?: string
  /** ISO; the stamp, else the server's `updatedAt`. */
  updated?: string
  deleted?: string
  status: string
  supersedes?: string
  supersededBy?: string
  expires?: string
  body: string
  bytes: number
}

function str(fields: Map<string, FmValue> | undefined, k: string): string | undefined {
  const v = fields?.get(k)
  return typeof v === 'string' && v !== '' ? v : undefined
}

function parseNote(key: string, text: string, updatedAt: string | undefined): Note {
  const fm = parseFrontmatter(text)
  const f = fm?.fields
  const explicit = str(f, 'type')
  const valid = explicit !== undefined && (TYPES as readonly string[]).includes(explicit)
  const note: Note = {
    key,
    hidden: isHiddenKey(key),
    description: str(f, 'description') ?? '',
    status: str(f, 'status') ?? 'active',
    body: fm ? fm.body : text,
    bytes: utf8Length(text) + ENVELOPE_BYTES,
  }
  const type = valid ? explicit : inferType(key)
  if (type !== undefined) note.type = type
  if (explicit !== undefined && !valid) note.rawType = explicit
  const name = str(f, 'name')
  if (name !== undefined) note.name = name
  const updated = str(f, 'updated') ?? updatedAt
  if (updated !== undefined) note.updated = updated
  for (const [from, to] of [
    ['deleted', 'deleted'],
    ['supersedes', 'supersedes'],
    ['superseded_by', 'supersededBy'],
    ['expires', 'expires'],
  ] as const) {
    const v = str(f, from)
    if (v !== undefined) note[to] = v
  }
  return note
}

function isActive(note: Note): boolean {
  return !note.hidden && note.status === 'active'
}

function toGateNote(note: Note): GateNote {
  const g: GateNote = { key: note.key, description: note.description, body: note.body }
  if (note.type !== undefined) g.type = note.type
  if (note.name !== undefined) g.title = note.name
  return g
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** Milliseconds since the epoch, or undefined for anything `Date.parse` rejects. */
function toMs(stamp: string | undefined): number | undefined {
  if (stamp === undefined) return undefined
  const ms = Date.parse(stamp)
  return Number.isNaN(ms) ? undefined : ms
}

function daysBetween(fromMs: number, toMs: number): number {
  return Math.floor((toMs - fromMs) / DAY_MS)
}

function dateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function quoteKey(key: string): string {
  return `"${key}"`
}

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

// ---------------------------------------------------------------------------
// Index drift
// ---------------------------------------------------------------------------

function isEntryKey(s: string): boolean {
  try {
    validateEntryKey(s)
    return true
  } catch {
    return false
  }
}

/** The note keys a link line points at. */
export function linkTargets(line: string): string[] {
  const out: string[] = []
  for (const m of line.matchAll(MD_LINK)) if (isEntryKey(m[1])) out.push(m[1])
  if (out.length === 0) {
    const m = BARE_LINK.exec(line)
    if (m && (m[1].endsWith('.md') || m[1].includes('/')) && isEntryKey(m[1])) out.push(m[1])
  }
  return out
}

function indexFindings(entries: Record<string, string>, notes: Note[], nowDate: Date): Finding[] {
  const out: Finding[] = []
  const text = entries[INDEX_BASENAME]
  if (text === undefined) {
    out.push({
      kind: 'index-missing',
      keys: [],
      detail: `no ${INDEX_BASENAME} in the namespace`,
      suggest: 'memory_save mode=update any note: the index is regenerated with every save',
    })
    return out
  }
  const pinned = new Set(parseIndex(text).pinned)
  const lines = text.split(/\r?\n/)
  const listed = new Set<string>()
  const atCap = lines.some(l => INDEX_TAIL.test(l))
  const dangling: Finding[] = []
  for (const line of lines) {
    if (!isLinkLine(line)) continue
    for (const target of linkTargets(line)) {
      listed.add(target)
      if (target in entries) continue
      dangling.push({
        kind: 'index-dangling',
        keys: [target],
        detail: pinned.has(line)
          ? `pinned line links to a key that does not exist`
          : `index line links to a key that does not exist`,
        suggest: pinned.has(line)
          ? `memory_save ${INDEX_BASENAME} mode=update without the line ${JSON.stringify(clip(line, DESCRIPTION_CLIP))}`
          : 'memory_save mode=update any note to regenerate the index',
      })
    }
  }
  if (!atCap) {
    for (const note of notes) {
      if (!isActive(note) || isExpired(note.expires, nowDate) || listed.has(note.key)) continue
      out.push({
        kind: 'index-missing',
        keys: [note.key],
        detail: `not listed in ${INDEX_BASENAME}`,
        suggest: `memory_save ${quoteKey(note.key)} mode=update to regenerate the index`,
      })
    }
  }
  out.push(...dangling)
  return out
}

// ---------------------------------------------------------------------------
// Pairs: candidate generation bounded by LSH banding, verified by the gate
// ---------------------------------------------------------------------------

/** A note the pair search works on, with its position in the search population. */
type Member = {
  index: number
  /** The entry key as stored. */
  key: string
  /**
   * What the gate sees. Within one namespace its key is `key`; across
   * namespaces it is qualified with the namespace, because the gate treats a
   * corpus note with the target's key as the target itself and the doctor's
   * caches are keyed by it.
   */
  note: GateNote
  profile: NoteProfile
  /** Which namespace it came from, for the cross-namespace search; '' within one. */
  ns: string
  updated?: string
}

type Pair = { a: Member; b: Member; reason: CandidateReason; similarity: number }

/** Tokens in more notes than this do not generate contradiction candidates on their own. */
export function topicDfCap(n: number): number {
  return Math.max(8, Math.ceil(n * 0.02))
}

/**
 * Candidate sets, one per member, holding only higher indexes so each
 * unordered pair is proposed once. `accept` says whether a pair is wanted at
 * all (the cross-namespace search wants only pairs from different
 * namespaces).
 */
class Candidates {
  /** Per member: proposed higher index → how many buckets proposed it (the evidence). */
  readonly hits: Map<number, number>[]
  constructor(
    n: number,
    private readonly accept: (i: number, j: number) => boolean,
  ) {
    this.hits = Array.from({ length: n }, () => new Map<number, number>())
  }

  /**
   * Propose every pair within a bucket, each member contributing at most its
   * cap. A pair proposed again gains evidence; once a member's cap is reached
   * the scan of that bucket stops at the first stranger, so a bucket of a
   * thousand restatements costs its members a thousand steps, not a million.
   */
  bucket(members: number[]): void {
    if (members.length < 2) return
    for (let x = 0; x < members.length - 1; x++) {
      const i = members[x]
      const mine = this.hits[i]
      for (let y = x + 1; y < members.length; y++) {
        const j = members[y]
        if (i === j || !this.accept(i, j)) continue
        const seen = mine.get(j)
        if (seen !== undefined) {
          mine.set(j, seen + 1)
          continue
        }
        if (mine.size >= PER_TARGET_CANDIDATES) break
        mine.set(j, 1)
      }
    }
  }
}

function bucketsOf<T>(items: T[], keysOf: (item: T, index: number) => string[]): number[][] {
  const map = new Map<string, number[]>()
  items.forEach((item, index) => {
    for (const k of keysOf(item, index)) {
      const list = map.get(k)
      if (list) list.push(index)
      else map.set(k, [index])
    }
  })
  return [...map.values()].filter(list => list.length > 1)
}

/** The LSH band keys of a signature; a band with no shingle in it is skipped. */
function bandKeys(sig: Uint32Array): string[] {
  const out: string[] = []
  for (let b = 0; b < LSH_BANDS; b++) {
    const start = b * LSH_ROWS
    if (sig[start] === EMPTY_SLOT) continue
    let key = `${b}`
    for (let r = 0; r < LSH_ROWS; r++) key += `:${sig[start + r]}`
    out.push(key)
  }
  return out
}

/**
 * MinHash over a note's content-token set: each slot is the minimum over the
 * tokens of a fixed per-slot mix of the token's FNV-1a hash. Deterministic;
 * an empty set is all `EMPTY_SLOT` and bands nowhere.
 */
export function tokenSignature(content: ReadonlySet<string>): Uint32Array {
  const sig = new Uint32Array(TOKEN_PERMS).fill(EMPTY_SLOT)
  for (const t of content) {
    const h = fnv1a(t)
    for (let i = 0; i < TOKEN_PERMS; i++) {
      let v = (h ^ TOKEN_SEEDS[i]) >>> 0
      v = Math.imul(v ^ (v >>> 16), 0x45d9f3b) >>> 0
      v = (v ^ (v >>> 16)) >>> 0
      if (v < sig[i]) sig[i] = v
    }
  }
  return sig
}

/** The band keys of a token signature, prefixed so they never collide with shingle bands. */
function tokenBandKeys(sig: Uint32Array): string[] {
  const out: string[] = []
  for (let b = 0; b < TOKEN_BANDS; b++) {
    const start = b * TOKEN_ROWS
    if (sig[start] === EMPTY_SLOT) continue
    let key = `t${b}`
    for (let r = 0; r < TOKEN_ROWS; r++) key += `:${sig[start + r]}`
    out.push(key)
  }
  return out
}

function topSegment(key: string): string {
  const i = key.indexOf('/')
  return i < 0 ? '' : key.slice(0, i)
}

/**
 * Propose and verify pairs over `members`. Candidate generation is the
 * bounded part (see the header); verification is one `findCandidates` call
 * per member over its candidates, so the reasons and similarities are the
 * gate's. Returns the pairs at the wanted levels and whether the budget ran
 * out.
 */
function findPairs(
  members: Member[],
  accept: (i: number, j: number) => boolean,
  levels: ReadonlySet<CandidateReason>,
  opts: { contradictions: boolean },
): { pairs: Pair[]; exhausted: boolean } {
  const n = members.length
  const cands = new Candidates(n, accept)
  const signatures = new Map<string, Uint32Array>()
  const profiles = new Map<string, NoteProfile>()
  for (const m of members) {
    profiles.set(m.note.key, m.profile)
    // The shingle signature is what the gate compares two long notes by; a
    // short note is compared by its token set, so it never needs one.
    if (!m.profile.short) {
      m.profile.signature ??= minhashSignature(m.note.body)
      signatures.set(m.note.key, m.profile.signature)
    }
  }

  for (const b of bucketsOf(members, m =>
    m.profile.signature ? bandKeys(m.profile.signature) : [],
  ))
    cands.bucket(b)
  for (const b of bucketsOf(members, m => tokenBandKeys(tokenSignature(m.profile.content))))
    cands.bucket(b)
  for (const b of bucketsOf(members, m => [m.profile.normalizedKey])) cands.bucket(b)
  if (opts.contradictions) {
    const df = new Map<string, number>()
    for (const m of members) for (const t of m.profile.topic.keys()) df.set(t, (df.get(t) ?? 0) + 1)
    const cap = topicDfCap(n)
    for (const b of bucketsOf(members, m => {
      const seg = topSegment(m.note.key)
      const keys: string[] = []
      for (const t of m.profile.topic.keys()) if ((df.get(t) ?? 0) <= cap) keys.push(`${seg}\0${t}`)
      return keys
    }))
      cands.bucket(b)
  }

  // Verify round-robin by rank: every member's best-evidenced candidate is
  // checked before any member's second, so whatever the budget cuts, a note
  // with one strong twin is never the note that went unchecked.
  type Proposed = { i: number; j: number; rank: number; hits: number }
  const proposed: Proposed[] = []
  for (let i = 0; i < n; i++) {
    const ranked = [...cands.hits[i]].sort((x, y) => y[1] - x[1] || x[0] - y[0])
    for (let rank = 0; rank < ranked.length; rank++) {
      proposed.push({ i, j: ranked[rank][0], rank, hits: ranked[rank][1] })
    }
  }
  proposed.sort((x, y) => x.rank - y.rank || y.hits - x.hits || x.i - y.i || x.j - y.j)
  const exhausted = proposed.length > PAIR_BUDGET
  const byMember = new Map<number, number[]>()
  for (const p of proposed.slice(0, PAIR_BUDGET)) {
    const list = byMember.get(p.i)
    if (list) list.push(p.j)
    else byMember.set(p.i, [p.j])
  }

  const idf: Idf = buildIdf(members.map(m => m.note))
  const pairs: Pair[] = []
  const byKey = new Map(members.map(m => [m.note.key, m]))
  for (const [i, js] of byMember) {
    const a = members[i]
    const corpus = js.map(j => members[j].note)
    const found = findCandidates(a.note, corpus, { profiles, signatures, idf, limit: js.length })
    for (const c of found) {
      if (!levels.has(c.reason)) continue
      const b = byKey.get(c.key)
      if (b) pairs.push({ a, b, reason: c.reason, similarity: c.similarity })
    }
  }
  pairs.sort(
    (x, y) =>
      y.similarity - x.similarity ||
      (x.a.note.key < y.a.note.key ? -1 : x.a.note.key > y.a.note.key ? 1 : 0) ||
      (x.b.note.key < y.b.note.key ? -1 : x.b.note.key > y.b.note.key ? 1 : 0),
  )
  return { pairs, exhausted }
}

function toMembers(notes: Note[], ns: string, offset = 0, qualify = false): Member[] {
  const out: Member[] = []
  for (const note of notes) {
    if (!isActive(note)) continue
    const g = toGateNote(note)
    if (qualify) g.key = `${ns}\0${note.key}`
    const m: Member = {
      index: offset + out.length,
      key: note.key,
      note: g,
      profile: profileNote(g),
      ns,
    }
    if (note.updated !== undefined) m.updated = note.updated
    out.push(m)
  }
  return out
}

/** Which of a pair is older by `updated`; undefined when either lacks a stamp. */
function olderOf(p: Pair): Member | undefined {
  if (p.a.updated === undefined || p.b.updated === undefined) return undefined
  return p.a.updated <= p.b.updated ? p.a : p.b
}

function pairFinding(p: Pair): Finding {
  const descs = `${clip(p.a.note.description, DESCRIPTION_CLIP) || '(no description)'} / ${
    clip(p.b.note.description, DESCRIPTION_CLIP) || '(no description)'
  }`
  const detail = `${p.reason} ${p.similarity.toFixed(2)}: ${descs}`
  let suggest: string
  if (p.reason === 'possible-contradiction') {
    const older = olderOf(p)
    suggest =
      older === undefined
        ? 'memory_get both; memory_save mode=supersede the current one with supersedes: <the older key>, or mode=update to reconcile'
        : `memory_get both; memory_save ${quoteKey(
            older === p.a ? p.b.key : p.a.key,
          )} mode=supersede with supersedes: ${quoteKey(older.key)}, or mode=update to reconcile`
  } else {
    suggest = `memory_get both; keep one with memory_save mode=update (merge the other into it), then memory_delete the other`
  }
  return { kind: 'near-duplicate', keys: [p.a.key, p.b.key], detail, suggest }
}

function nearDuplicateFindings(notes: Note[]): Finding[] {
  const members = toMembers(notes, '')
  const { pairs, exhausted } = findPairs(members, () => true, PAIR_LEVELS, {
    contradictions: true,
  })
  const out = pairs.map(pairFinding)
  if (exhausted) {
    out.push({
      kind: 'near-duplicate',
      keys: [],
      detail: `search stopped after ${PAIR_BUDGET} candidate pairs; more may exist`,
      suggest: 'act on the pairs above and run the doctor again',
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// The rest of the finding kinds
// ---------------------------------------------------------------------------

function expiredFindings(notes: Note[], nowDate: Date): Finding[] {
  const out: Finding[] = []
  for (const note of notes) {
    if (!isActive(note) || !isExpired(note.expires, nowDate)) continue
    out.push({
      kind: 'expired',
      keys: [note.key],
      detail: `expired ${note.expires}`,
      suggest: `memory_delete ${quoteKey(note.key)} (soft), or memory_save mode=update with a later expires`,
    })
  }
  return out
}

function staleFindings(notes: Note[], accessed: Record<string, string>, nowMs: number): Finding[] {
  const out: Finding[] = []
  const nowDate = new Date(nowMs)
  for (const note of notes) {
    if (!isActive(note) || isExpired(note.expires, nowDate)) continue
    const updated = toMs(note.updated)
    const seen = toMs(accessed[note.key])
    if (updated === undefined && seen === undefined) continue
    const last = Math.max(updated ?? Number.NEGATIVE_INFINITY, seen ?? Number.NEGATIVE_INFINITY)
    const horizon =
      note.type === undefined ? STALE_HORIZON_UNTYPED_DAYS : STALE_HORIZON_DAYS[note.type]
    const age = daysBetween(last, nowMs)
    if (age <= horizon) continue
    out.push({
      kind: 'stale',
      keys: [note.key],
      detail: `${note.type ?? 'untyped'} note last touched ${dateOf(last)} (${age} d ago, horizon ${horizon} d)`,
      suggest: `memory_get ${quoteKey(note.key)} and verify; memory_save mode=update if still true, mode=supersede or memory_delete if not`,
    })
  }
  return out
}

function danglingLinkFindings(notes: Note[], entries: Record<string, string>): Finding[] {
  const out: Finding[] = []
  for (const note of notes) {
    if (note.hidden) continue
    for (const [field, target] of [
      ['supersedes', note.supersedes],
      ['superseded_by', note.supersededBy],
    ] as const) {
      if (target === undefined || target in entries) continue
      const parked = trashKey(target)
      const where = parked !== null && parked in entries ? ' (it is in the trash)' : ''
      out.push({
        kind: 'dangling-link',
        keys: [note.key],
        detail: `${field} names ${quoteKey(target)}, which does not exist${where}`,
        suggest:
          field === 'superseded_by'
            ? `memory_save ${quoteKey(note.key)} mode=update without superseded_by and status (it is current again), or memory_delete it`
            : `memory_save ${quoteKey(note.key)} mode=update without supersedes`,
      })
    }
  }
  return out
}

function trashFindings(
  notes: Note[],
  updatedAt: Record<string, string | undefined>,
  nowMs: number,
): Finding[] {
  const out: Finding[] = []
  for (const note of notes) {
    if (!note.key.startsWith(TRASH_PREFIX)) continue
    const stamp = toMs(note.deleted) ?? toMs(updatedAt[note.key])
    if (stamp === undefined) continue
    const age = daysBetween(stamp, nowMs)
    if (age <= TRASH_OLD_DAYS) continue
    out.push({
      kind: 'trash-old',
      keys: [note.key],
      detail: `in the trash since ${dateOf(stamp)} (${age} d)`,
      suggest: `memory_delete ${quoteKey(note.key)} hard=true`,
    })
  }
  return out
}

function untypedFindings(notes: Note[]): Finding[] {
  const out: Finding[] = []
  for (const note of notes) {
    if (!isActive(note) || note.type !== undefined) continue
    out.push({
      kind: 'untyped',
      keys: [note.key],
      detail:
        note.rawType !== undefined
          ? `type ${JSON.stringify(note.rawType)} is not one of ${TYPES.join(', ')}`
          : 'no type field and the key does not start with a type',
      suggest: `memory_save ${quoteKey(note.key)} mode=update with type: ${TYPES.join('|')}`,
    })
  }
  return out
}

function historyCapFindings(meters: DoctorMeters): Finding[] {
  if (meters.entries < HISTORY_WARN_ENTRIES) return []
  return [
    {
      kind: 'history-near-cap',
      keys: [],
      detail: `${meters.entries} entries of ${meters.capEntries}; version history stops being recorded at ${HISTORY_STOP_ENTRIES}`,
      suggest: `memory_delete hard=true old trash (${TRASH_PREFIX}*) and history (${HISTORY_PREFIX}*) to free entries`,
    },
  ]
}

// ---------------------------------------------------------------------------
// Meters and the run
// ---------------------------------------------------------------------------

function meter(input: DoctorInput, notes: Note[]): DoctorMeters {
  const caps = input.caps ?? DEFAULT_CAPS
  const index = input.entries[INDEX_BASENAME]
  let bytes = 0
  let history = 0
  let trash = 0
  for (const note of notes) {
    bytes += note.bytes
    if (note.key.startsWith(HISTORY_PREFIX)) history++
    else if (note.key.startsWith(TRASH_PREFIX)) trash++
  }
  return {
    entries: notes.length,
    bytes,
    indexLines: index === undefined ? 0 : index.split(/\r?\n/).length,
    indexBytes: index === undefined ? 0 : utf8Length(index),
    history,
    trash,
    capEntries: caps.maxEntries,
    capBytes: caps.maxBytes,
  }
}

type Analysis = { report: DoctorReport; notes: Note[] }

function analyze(input: DoctorInput): Analysis {
  const nowMs = Date.parse(input.now)
  if (Number.isNaN(nowMs))
    throw new RangeError(`doctor: now must be an ISO timestamp: ${input.now}`)
  const nowDate = new Date(nowMs)
  const updatedAt = input.updatedAt ?? {}
  const accessed = input.accessed ?? {}
  const notes = Object.keys(input.entries)
    .sort()
    .map(key => parseNote(key, input.entries[key], updatedAt[key]))
  const meters = meter(input, notes)
  const findings: Finding[] = [
    ...indexFindings(input.entries, notes, nowDate),
    ...nearDuplicateFindings(notes),
    ...expiredFindings(notes, nowDate),
    ...staleFindings(notes, accessed, nowMs),
    ...danglingLinkFindings(notes, input.entries),
    ...trashFindings(notes, updatedAt, nowMs),
    ...untypedFindings(notes),
    ...historyCapFindings(meters),
  ]
  return { report: { namespace: input.namespace, meters, findings }, notes }
}

/** Audit one namespace. Pure; throws only for a `now` that is not a timestamp. */
export function runDoctor(input: DoctorInput): DoctorReport {
  return analyze(input).report
}

/**
 * Audit several namespaces and add the cross-namespace twins. With one input
 * this is `runDoctor`. With more, the report's namespace is the namespaces
 * joined with ` + `, the meters are totals (caps included, so the meters line
 * reads as totals against totals), each namespace's findings carry
 * `[namespace] ` at the front of their detail, and the twins come after.
 */
export function runDoctorAcross(inputs: DoctorInput[]): DoctorReport {
  if (inputs.length === 0) {
    return {
      namespace: '',
      meters: meter({ namespace: '', entries: {}, now: '' }, []),
      findings: [],
    }
  }
  if (inputs.length === 1) return runDoctor(inputs[0])
  const analyses = inputs.map(analyze)
  const meters: DoctorMeters = {
    entries: 0,
    bytes: 0,
    indexLines: 0,
    indexBytes: 0,
    history: 0,
    trash: 0,
    capEntries: 0,
    capBytes: 0,
  }
  const findings: Finding[] = []
  for (const { report } of analyses) {
    for (const k of Object.keys(meters) as (keyof DoctorMeters)[]) meters[k] += report.meters[k]
    for (const f of report.findings) {
      findings.push({ ...f, detail: `[${report.namespace}] ${f.detail}` })
    }
  }

  const members: Member[] = []
  for (const { report, notes } of analyses) {
    members.push(...toMembers(notes, report.namespace, members.length, true))
  }
  const seen = new Set<string>()
  const twin = (a: Member, b: Member, what: string) => {
    const id = `${a.ns}\0${a.key}\0${b.ns}\0${b.key}`
    if (seen.has(id)) return
    seen.add(id)
    findings.push({
      kind: 'cross-namespace-twin',
      keys: [a.key, b.key],
      detail: `${quoteKey(a.key)} in ${a.ns} and ${quoteKey(b.key)} in ${b.ns}: ${what}`,
      suggest:
        'memory_get both; keep the one in the namespace its type belongs to (user → shared, project/reference → the project) with memory_save mode=update, then memory_delete the other',
    })
  }

  // Key twins first: the gate cannot see them (a corpus note with the
  // target's key is the target to it), and they need no text comparison.
  const byNormalized = new Map<string, Member[]>()
  for (const m of members) {
    const k = normalizeKey(m.key)
    const list = byNormalized.get(k)
    if (list) list.push(m)
    else byNormalized.set(k, [m])
  }
  for (const group of byNormalized.values()) {
    for (let x = 0; x < group.length; x++) {
      for (let y = x + 1; y < group.length; y++) {
        const a = group[x]
        const b = group[y]
        if (a.ns === b.ns) continue
        twin(a, b, a.key === b.key ? 'same key' : 'twin keys')
      }
    }
  }

  const { pairs } = findPairs(
    members,
    (i, j) => members[i].ns !== members[j].ns,
    new Set(['duplicate']),
    { contradictions: false },
  )
  for (const p of pairs) twin(p.a, p.b, `${p.reason} ${p.similarity.toFixed(2)}`)
  return { namespace: inputs.map(i => i.namespace).join(' + '), meters, findings }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function trimZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

/** `1.9 MB`, `21.3 KB`, `512 B`; decimal units, like the caps are stated. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${trimZero((bytes / 1_000_000).toFixed(1))} MB`
  if (bytes >= 1_000) return `${trimZero((bytes / 1_000).toFixed(1))} KB`
  return `${bytes} B`
}

function kb(bytes: number): string {
  return trimZero((bytes / 1_000).toFixed(1))
}

/** The meters line, in the shape `renderReport` prints first. */
export function formatMeters(m: DoctorMeters): string {
  return (
    `entries ${m.entries}/${m.capEntries} · bytes ${formatBytes(m.bytes)}/${formatBytes(m.capBytes)} · ` +
    `index ${m.indexLines}/${MAX_LINES} lines, ${kb(m.indexBytes)}/${kb(MAX_BYTES)} KB · ` +
    `history ${m.history} · trash ${m.trash}`
  )
}

function itemLine(f: Finding): string {
  const keys = f.keys.join(' ↔ ')
  const head = keys === '' ? f.detail : f.detail === '' ? keys : `${keys}: ${f.detail}`
  return neutralize(`- ${head} → ${f.suggest}`)
}

function section(kind: FindingKind, items: Finding[]): string {
  const lines = [`${kind} (${items.length}):`]
  for (const f of items.slice(0, SECTION_ITEMS)) lines.push(itemLine(f))
  if (items.length > SECTION_ITEMS) lines.push(`… and ${items.length - SECTION_ITEMS} more`)
  return lines.join('\n')
}

/**
 * The report as text: meters first, then the sections in `KIND_ORDER`, every
 * key and detail neutralized, at most `maxChars` characters.
 */
export function renderReport(report: DoctorReport, opts: { maxChars?: number } = {}): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
  const byKind = new Map<FindingKind, Finding[]>()
  for (const f of report.findings) {
    const list = byKind.get(f.kind)
    if (list) list.push(f)
    else byKind.set(f.kind, [f])
  }
  const sections = KIND_ORDER.filter(k => byKind.has(k)).map(k =>
    section(k, byKind.get(k) as Finding[]),
  )
  let text = formatMeters(report.meters)
  if (sections.length === 0) text += '\nno findings'
  let truncated = false
  for (let i = 0; i < sections.length; i++) {
    const next = `${text}\n${sections[i]}`
    const last = i === sections.length - 1
    const room = last ? 0 : TRUNCATED_LINE.length + 1
    if (next.length + room <= maxChars) {
      text = next
      continue
    }
    truncated = true
    break
  }
  if (truncated) text += `\n${TRUNCATED_LINE}`
  // Only reachable with a maxChars smaller than the meters line itself; cut.
  return text.length > maxChars ? text.slice(0, maxChars) : text
}

// ---------------------------------------------------------------------------
// Scheduling: due rule and the marker file
// ---------------------------------------------------------------------------

/**
 * Whether a run is due: no marker, a marker that cannot be read as a time,
 * more than `DUE_AFTER_MS` since it, or `DUE_AFTER_VERSIONS` or more
 * mutating writes since it.
 */
export function isDue(
  marker: { ranAt: string; version: number } | undefined,
  now: string,
  version: number,
): boolean {
  if (marker === undefined) return true
  const ran = toMs(marker.ranAt)
  const at = toMs(now)
  if (ran === undefined || at === undefined) return true
  if (at - ran > DUE_AFTER_MS) return true
  return version - marker.version >= DUE_AFTER_VERSIONS
}

/** The marker file's key for a namespace: its sha256, so the file names no namespace. */
export function markerKey(namespace: string): string {
  return sha256Hex(namespace)
}

function toMarker(x: unknown): DoctorMarker | undefined {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return undefined
  const r = x as Record<string, unknown>
  if (typeof r.ranAt !== 'string' || typeof r.version !== 'number') return undefined
  if (typeof r.findings !== 'number') return undefined
  return { ranAt: r.ranAt, version: r.version, findings: r.findings }
}

/** The markers in `path`, or `{}` when the file is missing, unreadable or malformed. */
export async function readMarker(path: string): Promise<DoctorMarkers> {
  let doc: unknown
  try {
    doc = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return {}
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return {}
  const out: DoctorMarkers = {}
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
    const m = toMarker(v)
    if (m) out[k] = m
  }
  return out
}

/**
 * Write the markers to `path` (parent created 0700, file 0600, replaced
 * atomically). False, never a throw, when anything fails.
 */
export async function writeMarker(path: string, markers: DoctorMarkers): Promise<boolean> {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(tmp, `${JSON.stringify(markers)}\n`, { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, path)
    return true
  } catch {
    await unlink(tmp).catch(() => {})
    return false
  }
}
