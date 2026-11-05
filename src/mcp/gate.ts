/**
 * The save gate: duplicate and contradiction detection without a model.
 *
 * A memory that accepts every save fills with restatements, and recall then
 * answers one question with three near-identical notes, or with a note that was
 * overruled by a later one. The gate runs before a save is written and names
 * the existing notes the new one looks like, so the agent can decide whether
 * it is updating, superseding, adding or saying nothing new. It never decides
 * for the agent, it writes nothing, and it calls no model: every detector is a
 * closed-form score over the note text, cheap enough to run on every save at
 * the namespace cap.
 *
 * Input is ALREADY-PARSED metadata (`GateNote`): the caller splits frontmatter
 * from body and passes `description`, `title` (the `name:` field) and `type`.
 * Nothing here parses frontmatter, so the gate cannot drift from the parser.
 *
 * Detectors, each with a named threshold below and the fixture numbers that
 * bound it:
 *
 * - key twin: `normalizeKey` equal with a different raw key. Similarity 1.
 * - same-topic: TF-IDF cosine over `tokenize(description + ' ' + title)`,
 *   idf = ln(1 + N/df) over the corpus's description+title token sets.
 * - near-duplicate / duplicate: MinHash (64 permutations, word 3-shingles of
 *   `tokenizeAll(body)`, FNV-1a base hash, `(a·h + b) mod (2^32 − 5)`)
 *   estimating body Jaccard; when either side is short (fewer than 20 content
 *   tokens or fewer than 3 shingles, where an estimator over so few shingles is
 *   noise) the exact Jaccard of `tokenize(description + body)` sets is used
 *   instead. The two tiers apply on both paths: a verbatim copy of a two-line
 *   note under a new key is a duplicate, not merely a near one.
 * - possible-contradiction: same first path segment, same `type` when both
 *   carry one, topic overlap (cosine ≥ 0.3 or ≥ 2 shared stemmed title or
 *   description tokens), and then either a difference in which negation and
 *   reversal cue words the two notes contain, or a `label: value` line whose
 *   label both notes carry with different values.
 *
 * One reason per note, by priority duplicate > key-twin > near-duplicate >
 * possible-contradiction > same-topic, sorted by similarity, top `limit`. The
 * target's own key is a plain update and is never a candidate; hidden keys
 * (`isHiddenKey`) are bookkeeping, not notes.
 *
 * Cost: everything derived from one note (`NoteProfile`) is computed once and
 * cacheable by the caller; a gate call over 2,000 cached profiles is a few
 * milliseconds. Tokenizing 2,000 notes is about 15 ms on its own, which is why
 * the cache holds profiles and not only MinHash signatures: most memory notes
 * are short enough that the exact fallback runs and a signature is never used.
 *
 * The thresholds are measured, not derived. See the comment on each constant
 * for the fixture numbers that bound it; `tests/save-gate.test.ts` re-measures
 * them against `tests/recall-corpus.ts` on every run.
 */

import { isHiddenKey, normalizeKey } from './keys.ts'
import { tokenize, tokenizeAll } from './relevance.ts'

/** A note as the gate sees it: parsed metadata plus the frontmatter-stripped body. */
export type GateNote = {
  key: string
  type?: string
  description: string
  /** The `name:` field, when the note has one. Scored with the description. */
  title?: string
  body: string
}

export type CandidateReason =
  | 'duplicate'
  | 'key-twin'
  | 'near-duplicate'
  | 'possible-contradiction'
  | 'same-topic'

export type Candidate = {
  key: string
  description: string
  /** In [0, 1]; what it measures depends on `reason`. */
  similarity: number
  reason: CandidateReason
}

/** Inverse document frequency over description+title token sets, with the population size. */
export type Idf = { readonly n: number; readonly df: ReadonlyMap<string, number> }

export type ContradictionResult = {
  contradicts: boolean
  /** Topic overlap in [0, 1]: the larger of the description cosine and the shared-token fraction. */
  overlap: number
  /** Why, when `contradicts`. Plain text the caller may show. */
  reason?: string
}

/**
 * Description cosine at or above which two notes are about the same thing.
 *
 * MEASURED 2026-11-05 against `tests/recall-corpus.ts` (25 notes, index
 * excluded, idf over those 25): the highest cosine between two distinct corpus
 * notes is 0.33, the superseded pair `project/postgres-old.md` /
 * `project/postgres-new.md` ("superseded note about the datastore" / "current
 * decision about the datastore", names `postgres-old` / `postgres-new`). The
 * next is 0.23 (`feedback/commit-style.md` / `project/ci.md`, sharing
 * `commit`), and every other pair is at or below 0.18. Restatements of
 * `feedback/testing.md`'s "how tests are expected to be written" score 0.92
 * ("how we expect tests to be written") and 0.78 ("how tests should be
 * written"); a looser rewording ("what a well-formed test looks like") scores
 * 0.49 and is meant to fall under. 0.6 sits between the strongest distinct
 * pair and the weakest restatement with room either side.
 */
export const SAME_TOPIC = 0.6

/**
 * Body Jaccard (estimated or exact) at or above which a note is a
 * near-duplicate. The paraphrase of `feedback/testing.md` in
 * `tests/save-gate.test.ts` scores 0.75 exact against the original, and a
 * copy with two content words changed 0.77; the highest exact Jaccard between
 * two distinct corpus notes is 0.11 (`project/deploy.md` /
 * `feedback/outward-actions.md`, then the postgres pair at 0.11). 0.5 is the
 * plan's figure and sits in the middle of that gap.
 */
export const NEAR_DUP = 0.5

/**
 * Body Jaccard at or above which a note is a duplicate: a verbatim copy, or a
 * copy with a word touched. A copy of `feedback/testing.md` (15 content
 * tokens) with one content word changed scores 0.88 exact and with two 0.77,
 * so on a short note 0.8 means at most one word differs; two 62-word bodies
 * differing in four places have shingle Jaccard 0.64 and estimate at 0.69
 * with 64 permutations, a near-duplicate. 0.8 is reserved for copies that
 * differ by less than a sentence.
 */
export const DUP = 0.8

/**
 * Description cosine at or above which two notes overlap enough in topic for
 * a contradiction between them to be meaningful. The superseded fixture pair
 * is at 0.33 and is the pair this detector exists to catch, so the bound sits
 * just under it; the shared-token alternative (`CONTRADICTION_SHARED`) admits
 * that pair on its own at 2 shared tokens (`postgres`, `datastore`), and
 * admits two feedback pairs (`testing`/`planning`, `testing`/`tone`, sharing
 * `written`) that then fail the cue and label tests.
 */
export const CONTRADICTION_COSINE = 0.3

/** Shared stemmed title/description tokens that count as topic overlap on their own. */
export const CONTRADICTION_SHARED = 2

/** Fewer content tokens than this on either side, and MinHash gives way to exact Jaccard. */
export const SHORT_TEXT_TOKENS = 20

/** Fewer shingles than this on either side, and MinHash gives way to exact Jaccard. */
export const MIN_SHINGLES = 3

/** Permutations in a MinHash signature. 64 bounds the estimate's error at about ±0.12. */
export const MINHASH_PERMS = 64

/** Words per shingle. */
export const SHINGLE_WORDS = 3

/** Candidates returned when `limit` is not given. */
export const DEFAULT_LIMIT = 5

/** Characters of a candidate description shown in `renderNeedsDecision`. */
export const DESCRIPTION_CLIP = 120

/** Characters `renderNeedsDecision` never exceeds unless told otherwise. */
export const DEFAULT_MAX_CHARS = 4_000

/**
 * Words whose presence in one note and absence in the other suggests the two
 * disagree. The first ten are negations and are the plan's list; the rest are
 * reversal cues, added because a note that overrules a plan rarely negates it
 * ("the migration is parked", "this is superseded") and the fixture pair the
 * detector exists to catch contains no negation at all. Apostrophes are
 * removed before matching, so `don't` and `dont` are one cue. Presence sets
 * are compared, not counts: a note that says `never` twice disagrees with
 * nothing by saying it again.
 */
export const CONTRADICTION_CUES: ReadonlySet<string> = new Set([
  'never',
  'not',
  'no',
  'longer',
  'instead',
  'stop',
  'avoid',
  'always',
  'dont',
  'cannot',
  'parked',
  'paused',
  'superseded',
  'deprecated',
  'dropped',
  'abandoned',
  'reverted',
  'replaced',
  'obsolete',
  'retired',
  'cancelled',
  'canceled',
  'discontinued',
])

/**
 * Labels whose value is an explanation rather than a fact. Every note in the
 * memory guidance's shape ends with a `Why:` line, and two different reasons
 * for two different rules are not a contradiction; without this list every
 * same-topic pair in a namespace would be reported.
 */
const PROSE_LABELS: ReadonlySet<string> = new Set([
  'why',
  'because',
  'note',
  'notes',
  'context',
  'rationale',
  'reason',
  'reasons',
  'example',
  'examples',
  'see',
  'todo',
  'tip',
  'tips',
  'warning',
  'caveat',
  'caveats',
  'background',
  'summary',
  'details',
  'description',
])

/** Longest value, in words, that still reads as a fact rather than a sentence. */
const LABEL_VALUE_WORDS = 8

// ---------------------------------------------------------------------------
// Description TF-IDF
// ---------------------------------------------------------------------------

/** The tokens a note's topic is judged on: its description and its title. */
function topicTokens(note: GateNote): string[] {
  return tokenize(`${note.description} ${note.title ?? ''}`)
}

function countTerms(tokens: Iterable<string>): Map<string, number> {
  const tf = new Map<string, number>()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
  return tf
}

function idfOver(topics: Iterable<ReadonlyMap<string, number>>): Idf {
  const df = new Map<string, number>()
  let n = 0
  for (const topic of topics) {
    n++
    for (const t of topic.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  }
  return { n, df }
}

/** Document frequencies of description+title tokens over `notes`, with the count. */
export function buildIdf(notes: Iterable<GateNote>): Idf {
  return idfOver(Array.from(notes, note => countTerms(topicTokens(note))))
}

/**
 * ln(1 + N/df). A term in every note is worth ln 2, never zero; a term seen in
 * none of the population (the target's own, when it was not counted) is
 * weighted as if seen once.
 */
export function idfWeight(idf: Idf, term: string): number {
  return Math.log(1 + idf.n / Math.max(idf.df.get(term) ?? 0, 1))
}

function weigh(topic: ReadonlyMap<string, number>, idf: Idf): Map<string, number> {
  const out = new Map<string, number>()
  for (const [t, count] of topic) out.set(t, count * idfWeight(idf, t))
  return out
}

/** TF-IDF vector of a note's description and title: term -> count × idf. */
export function descriptionVector(note: GateNote, idf: Idf): Map<string, number> {
  return weigh(countTerms(topicTokens(note)), idf)
}

function norm(v: ReadonlyMap<string, number>): number {
  let s = 0
  for (const w of v.values()) s += w * w
  return Math.sqrt(s)
}

function cosine(
  a: ReadonlyMap<string, number>,
  normA: number,
  b: ReadonlyMap<string, number>,
  normB: number,
): number {
  if (normA === 0 || normB === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let dot = 0
  for (const [t, w] of small) {
    const x = large.get(t)
    if (x !== undefined) dot += w * x
  }
  return Math.min(1, dot / (normA * normB))
}

/** Cosine similarity of two notes' description+title vectors, in [0, 1]. */
export function descriptionCosine(a: GateNote, b: GateNote, idf: Idf): number {
  const va = descriptionVector(a, idf)
  const vb = descriptionVector(b, idf)
  return cosine(va, norm(va), vb, norm(vb))
}

// ---------------------------------------------------------------------------
// MinHash over word shingles
// ---------------------------------------------------------------------------

/** 2^32 − 5, the largest prime below 2^32. Permutation outputs are residues mod this. */
const PRIME = 4294967291

/** Signature slot value before any shingle is seen; above every residue. */
const EMPTY_SLOT = 0xffffffff

/** 32-bit FNV-1a over the UTF-16 code units of `s` (shingles are ASCII by construction). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32: a tiny seeded generator so the permutation parameters are fixed forever. */
function seeded(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return (t ^ (t >>> 14)) >>> 0
  }
}

/** The fixed permutation parameters: `a` in [1, PRIME−1], `b` in [0, PRIME−1]. */
const [PERM_A, PERM_B] = (() => {
  const next = seeded(0x6f70656e) // "open"
  const a = new Uint32Array(MINHASH_PERMS)
  const b = new Uint32Array(MINHASH_PERMS)
  for (let i = 0; i < MINHASH_PERMS; i++) {
    a[i] = 1 + (next() % (PRIME - 1))
    b[i] = next() % PRIME
  }
  return [a, b]
})()

/**
 * (a·h + b) mod PRIME without leaving the exactly-representable range of a
 * double: a·h is up to 2^64, so `a` is split into 16-bit halves and each
 * partial product (under 2^48) is reduced before recombining.
 */
function permute(h: number, a: number, b: number): number {
  const hi = ((a >>> 16) * h) % PRIME
  const lo = ((a & 0xffff) * h) % PRIME
  return (((hi * 65536) % PRIME) + lo + b) % PRIME
}

/** The word 3-shingles of a body, each as a space-joined string. */
function shingles(body: string): string[] {
  const words = tokenizeAll(body)
  const out: string[] = []
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i++)
    out.push(words.slice(i, i + SHINGLE_WORDS).join(' '))
  return out
}

/**
 * MinHash signature of a body: 64 slots, each the minimum of one fixed
 * permutation over the FNV-1a hashes of its word 3-shingles. Deterministic
 * across processes and machines. A body with fewer than three words has no
 * shingles and a signature of all `EMPTY_SLOT`, which `estimatedJaccard`
 * treats as resembling nothing.
 */
export function minhashSignature(body: string): Uint32Array {
  const sig = new Uint32Array(MINHASH_PERMS).fill(EMPTY_SLOT)
  for (const s of shingles(body)) {
    const h = fnv1a(s)
    for (let i = 0; i < MINHASH_PERMS; i++) {
      const v = permute(h, PERM_A[i], PERM_B[i])
      if (v < sig[i]) sig[i] = v
    }
  }
  return sig
}

/**
 * Fraction of signature slots that agree: an unbiased estimate of the shingle
 * Jaccard. Slots neither side filled do not count as agreement, so two empty
 * bodies estimate 0, not 1. Signatures of different lengths estimate 0.
 */
export function estimatedJaccard(a: Uint32Array, b: Uint32Array): number {
  if (a.length !== b.length || a.length === 0) return 0
  let same = 0
  for (let i = 0; i < a.length; i++) if (a[i] === b[i] && a[i] !== EMPTY_SLOT) same++
  return same / a.length
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

/** Exact Jaccard of the two notes' `tokenize(description + body)` sets. */
export function exactTokenJaccard(a: GateNote, b: GateNote): number {
  return jaccard(profileNote(a).content, profileNote(b).content)
}

/**
 * True when the body is too short for MinHash to estimate anything. The
 * shingle rule never fires on its own: a body with `SHORT_TEXT_TOKENS` content
 * tokens has at least that many words, and 20 words make 18 shingles. It is
 * kept as a stated rule so the two constants cannot be moved past each other
 * unnoticed; the check below refuses to load the module if they are.
 */
export function isShortText(note: GateNote): boolean {
  if (tokenize(note.body).length < SHORT_TEXT_TOKENS) return true
  return tokenizeAll(note.body).length - SHINGLE_WORDS + 1 < MIN_SHINGLES
}

if (SHORT_TEXT_TOKENS - SHINGLE_WORDS + 1 < MIN_SHINGLES)
  throw new Error('gate: SHORT_TEXT_TOKENS no longer implies MIN_SHINGLES; revisit isShortText')

// ---------------------------------------------------------------------------
// Contradiction heuristic
// ---------------------------------------------------------------------------

/** The first path segment, or '' for a key at the namespace root. */
function topSegment(key: string): string {
  const i = key.indexOf('/')
  return i < 0 ? '' : key.slice(0, i)
}

/** Which cue words a note contains, over its description, title and body. */
export function contradictionCues(note: GateNote): Set<string> {
  const text = `${note.description} ${note.title ?? ''} ${note.body}`
    .toLowerCase()
    .replace(/'/g, '')
  const out = new Set<string>()
  for (const w of text.split(/[^a-z]+/)) if (CONTRADICTION_CUES.has(w)) out.add(w)
  return out
}

/** `label: value` lines of a body, first occurrence per case-folded label, prose labels skipped. */
export function labelledValues(body: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of body.split('\n')) {
    const m = /^\s*(?:[-*+]\s+)?([A-Za-z][A-Za-z0-9 _-]{0,39}?)\s*:\s+(\S.*?)\s*$/.exec(line)
    if (!m) continue
    const label = m[1]
      .toLowerCase()
      .replace(/[\s_-]+/g, ' ')
      .trim()
    if (PROSE_LABELS.has(label)) continue
    const value = m[2]
    if (value.split(/\s+/).length > LABEL_VALUE_WORDS) continue
    if (!out.has(label)) out.set(label, value)
  }
  return out
}

/** Comparison form of a labelled value: case-folded, trailing punctuation dropped. */
function foldValue(v: string): string {
  return v
    .toLowerCase()
    .replace(/[.;,!]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// Per-note profiles
// ---------------------------------------------------------------------------

/**
 * Everything the detectors derive from one note. Independent of the corpus,
 * so a caller may cache one per key and reuse it across saves; the profile
 * must be dropped when the note's content changes (it is keyed by key, not by
 * content). The optional fields are filled on first use and are the only
 * mutable part. Treat the shape as opaque.
 */
export type NoteProfile = {
  readonly note: GateNote
  readonly prefix: string
  readonly normalizedKey: string
  /** term -> count over description + title, unweighted so it survives corpus changes. */
  readonly topic: ReadonlyMap<string, number>
  /** `tokenize(description + body)` as a set, for the exact fallback. */
  readonly content: ReadonlySet<string>
  /** Too few body tokens for MinHash; see `isShortText`. */
  readonly short: boolean
  cues?: Set<string>
  labels?: Map<string, string>
  signature?: Uint32Array
}

/** Derive a note's profile. Tokenizes the body once and the description twice. */
export function profileNote(note: GateNote): NoteProfile {
  const body = tokenize(note.body)
  return {
    note,
    prefix: topSegment(note.key),
    normalizedKey: normalizeKey(note.key),
    topic: countTerms(topicTokens(note)),
    content: new Set([...tokenize(note.description), ...body]),
    short: body.length < SHORT_TEXT_TOKENS,
  }
}

function cuesOf(p: NoteProfile): Set<string> {
  p.cues ??= contradictionCues(p.note)
  return p.cues
}

function labelsOf(p: NoteProfile): Map<string, string> {
  p.labels ??= labelledValues(p.note.body)
  return p.labels
}

/** A profile weighted against one corpus: the TF-IDF vector and its norm. */
type Weighted = { p: NoteProfile; vector: Map<string, number>; norm: number }

function weighted(p: NoteProfile, idf: Idf): Weighted {
  const vector = weigh(p.topic, idf)
  return { p, vector, norm: norm(vector) }
}

const NO_CONTRADICTION: ContradictionResult = { contradicts: false, overlap: 0 }

function contradictionOf(a: Weighted, b: Weighted): ContradictionResult {
  if (a.p.prefix !== b.p.prefix) return NO_CONTRADICTION
  const ta = a.p.note.type
  const tb = b.p.note.type
  if (ta !== undefined && tb !== undefined && ta !== tb) return NO_CONTRADICTION

  const cos = cosine(a.vector, a.norm, b.vector, b.norm)
  let shared = 0
  for (const t of a.p.topic.keys()) if (b.p.topic.has(t)) shared++
  const smaller = Math.max(1, Math.min(a.p.topic.size, b.p.topic.size))
  const overlap = Math.max(cos, shared / smaller)
  if (cos < CONTRADICTION_COSINE && shared < CONTRADICTION_SHARED)
    return { contradicts: false, overlap }

  const ca = cuesOf(a.p)
  const cb = cuesOf(b.p)
  const onlyA = [...ca].filter(c => !cb.has(c))
  const onlyB = [...cb].filter(c => !ca.has(c))
  if (onlyA.length > 0 || onlyB.length > 0) {
    const show = (xs: string[]) => (xs.length ? xs.sort().join(', ') : 'none')
    return {
      contradicts: true,
      overlap,
      reason: `negation cues differ: ${show(onlyA)} here, ${show(onlyB)} there`,
    }
  }

  const la = labelsOf(a.p)
  for (const [label, vb] of labelsOf(b.p)) {
    const va = la.get(label)
    if (va !== undefined && foldValue(va) !== foldValue(vb))
      return { contradicts: true, overlap, reason: `"${label}" is "${va}" here and "${vb}" there` }
  }
  return { contradicts: false, overlap }
}

/**
 * Does `b` look like it disagrees with `a`? Symmetric in `contradicts` and
 * `overlap`; the `reason` is phrased from `a`'s side ("here" is `a`).
 */
export function contradiction(a: GateNote, b: GateNote, idf: Idf): ContradictionResult {
  return contradictionOf(weighted(profileNote(a), idf), weighted(profileNote(b), idf))
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export type FindOptions = {
  /** Candidates returned, highest similarity first. Default `DEFAULT_LIMIT`. */
  limit?: number
  /**
   * Profiles by note key. Missing ones are computed and stored, so the caller
   * keeps one map per namespace and pays for a note's tokenization once. The
   * map is keyed by key alone: drop an entry when that note's content changes.
   */
  profiles?: Map<string, NoteProfile>
  /**
   * MinHash signatures by note key, the same way. Only long bodies ever need
   * one; a profile that already carries its signature does not consult this
   * map. Keep this when signatures are persisted separately from profiles.
   */
  signatures?: Map<string, Uint32Array>
  /** Precomputed idf over the corpus plus the target. Built per call when absent. */
  idf?: Idf
}

const PRIORITY: Record<CandidateReason, number> = {
  duplicate: 0,
  'key-twin': 1,
  'near-duplicate': 2,
  'possible-contradiction': 3,
  'same-topic': 4,
}

function profileOf(note: GateNote, cache: Map<string, NoteProfile> | undefined): NoteProfile {
  const hit = cache?.get(note.key)
  if (hit) return hit
  const p = profileNote(note)
  cache?.set(note.key, p)
  return p
}

function signatureOf(p: NoteProfile, cache: Map<string, Uint32Array> | undefined): Uint32Array {
  if (p.signature) return p.signature
  const sig = cache?.get(p.note.key) ?? minhashSignature(p.note.body)
  p.signature = sig
  cache?.set(p.note.key, sig)
  return sig
}

/**
 * Existing notes the target looks like, one reason each, best first.
 *
 * The target's own key is never a candidate (saving over it is an update,
 * not a duplicate), and hidden keys are skipped without being scored.
 */
export function findCandidates(
  target: GateNote,
  corpus: GateNote[],
  opts: FindOptions = {},
): Candidate[] {
  const limit = opts.limit ?? DEFAULT_LIMIT
  if (limit <= 0) return []

  const tp = profileNote(target)
  const profiles: NoteProfile[] = []
  for (const note of corpus) {
    if (note.key === target.key || isHiddenKey(note.key)) continue
    profiles.push(profileOf(note, opts.profiles))
  }
  const idf = opts.idf ?? idfOver([tp.topic, ...profiles.map(p => p.topic)])
  const t = weighted(tp, idf)

  const found: Candidate[] = []
  for (const p of profiles) {
    const w = weighted(p, idf)
    let best: Candidate | undefined
    const offer = (reason: CandidateReason, similarity: number) => {
      if (!best || PRIORITY[reason] < PRIORITY[best.reason])
        best = { key: p.note.key, description: p.note.description, similarity, reason }
    }

    if (p.normalizedKey === tp.normalizedKey) offer('key-twin', 1)

    const cos = cosine(t.vector, t.norm, w.vector, w.norm)
    if (cos >= SAME_TOPIC) offer('same-topic', cos)

    const bodySim =
      tp.short || p.short
        ? jaccard(tp.content, p.content)
        : estimatedJaccard(signatureOf(tp, opts.signatures), signatureOf(p, opts.signatures))
    if (bodySim >= DUP) offer('duplicate', bodySim)
    else if (bodySim >= NEAR_DUP) offer('near-duplicate', bodySim)

    const c = contradictionOf(t, w)
    if (c.contradicts) offer('possible-contradiction', c.overlap)

    if (best) found.push(best)
  }

  found.sort(
    (a, b) =>
      b.similarity - a.similarity ||
      PRIORITY[a.reason] - PRIORITY[b.reason] ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )
  return found.slice(0, limit)
}

// ---------------------------------------------------------------------------
// The needs_decision text
// ---------------------------------------------------------------------------

/** First `max` characters of a single-line form of `s`, with an ellipsis when cut. */
function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** The one line that tells the agent how to resave. */
export const RESAVE_MODES_LINE =
  'Resave with mode: "update" (key = the entry to rewrite; keeps its id and created), ' +
  '"supersede" (keep your key and pass supersedes: "<old key>"), ' +
  '"add" (a distinct fact), or "noop" (keep the existing entry).'

/**
 * The protocol text a refused save returns. Not sanitized here: the caller
 * neutralizes it with everything else it shows. Bounded to `maxChars` by
 * dropping candidate lines from the end (saying how many were dropped), then
 * by cutting.
 */
export function renderNeedsDecision(
  key: string,
  namespace: string,
  candidates: Candidate[],
  opts: { maxChars?: number } = {},
): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
  const n = candidates.length
  const head =
    `needs_decision: "${key}" was NOT saved; ${n} existing ${n === 1 ? 'entry looks' : 'entries look'} ` +
    `related in ${namespace}:`
  const lines = candidates.map(
    (c, i) =>
      `${i + 1}. ${c.key} — ${clip(c.description, DESCRIPTION_CLIP)} ` +
      `(similarity ${c.similarity.toFixed(2)}, ${c.reason})`,
  )
  const render = (shown: string[]) =>
    [
      head,
      ...shown,
      ...(shown.length < n ? [`… ${n - shown.length} more not shown`] : []),
      RESAVE_MODES_LINE,
    ].join('\n')
  let text = render(lines)
  while (text.length > maxChars && lines.length > 0) {
    lines.pop()
    text = render(lines)
  }
  // Only reachable with a maxChars smaller than the fixed lines; cut, keep the newlines.
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text
}
