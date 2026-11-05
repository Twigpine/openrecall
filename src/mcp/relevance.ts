/**
 * Local relevance ranking for memory_recall.
 *
 * Recall happens entirely client-side — the server only ever holds ciphertext,
 * so it cannot rank for us. We decrypt locally, then score each entry against
 * the query with BM25F over five fields of a memdir note: the entry key, the
 * frontmatter `name:` and `description:`, the body's headings, and the body
 * itself. A match in the description or the key counts for more than one
 * buried in the body, a term is worth less the more of the caller's entries
 * carry it, repeating a term saturates instead of adding up, a long note has
 * to earn a match that a short note gets for one mention, and covering less of
 * the query scales an entry's score down. This mirrors the intent of
 * openclaude's findRelevantMemories without needing its internals.
 *
 * The corpus statistics live in a `RecallIndex` that the MCP process keeps
 * between calls: an entry whose fingerprint has not changed is never
 * re-tokenized. `rankEntriesDetailed` is the same scoring over a transient
 * index, so the pure function the tests and the harness call and the index
 * the tools call cannot drift apart.
 *
 * What an entry covers no longer decides whether it is returned; the floor
 * below does. That split matters because a wrong recall answer delivered
 * confidently is worse than none: a query the corpus cannot answer has to come
 * back empty rather than with whatever scored highest among the noise.
 *
 * Two things the lexical score cannot see are read off a note's frontmatter
 * instead (`NoteMeta`): a note stamped `status: superseded` or `deleted`, or
 * one whose `expires:` date has passed, is not a candidate unless the caller
 * asks for it, and among hits that score within a few percent of the top the
 * most recently updated one goes first. Neither is a score term: the floor
 * sees exactly the ranking it saw before, and a note the floor withheld is
 * never promoted by its date.
 */

import { parseFrontmatter } from './frontmatter.ts'
import { isHiddenKey } from './keys.ts'

export type MemoryEntry = {
  key: string
  content: string
  namespace?: string
  /** ISO 8601 time of the entry's last write, when the caller knows it. Carried, not scored. */
  updatedAt?: string
}
export type ScoredEntry = MemoryEntry & {
  score: number
  /**
   * The score as a fraction of the most this query could have scored: a note
   * carrying every query term once in its body sits near 0.45, one that also
   * carries them in its key and description climbs toward 1, and one matching
   * a third of the query sits near a tenth of that. Corpus size and term
   * rarity cancel out of it, which is what lets one floor serve a 4-entry
   * namespace and a 2,000-entry one.
   */
  norm?: number
  /** What the note's frontmatter says about it, with `updated` resolved (see `NoteMeta`). */
  meta?: NoteMeta
}

/**
 * The frontmatter fields recall reads, as strings exactly as the note carries
 * them. Everything is optional: a legacy note has none of it, and the manifest
 * timestamp stands in for `updated` when the stamp is missing.
 */
export type NoteMeta = {
  /** `type:`, the closed set the stamp writes or whatever a hand-written note says. */
  type?: string
  /** `updated:`, else (on a `ScoredEntry`) the manifest timestamp the caller passed as `updatedAt`. */
  updated?: string
  /** `agent:`, the `name/version` the stamp wrote. */
  agent?: string
  /** `status:`; `superseded` and `deleted` make the note inactive. */
  status?: string
  /** `superseded_by:`, the key of the note that replaced this one. */
  supersededBy?: string
  /** `expires:` as `YYYY-MM-DD`; a past date makes the note inactive. */
  expires?: string
}

/** The frontmatter fields recall reads, off a note's content. Empty for a note without frontmatter. */
export function noteMeta(content: string): NoteMeta {
  const fm = parseFrontmatter(content)
  if (!fm) return {}
  const meta: NoteMeta = {}
  const str = (k: string) => {
    const v = fm.fields.get(k)
    return typeof v === 'string' && v !== '' ? v : undefined
  }
  const type = str('type')
  if (type !== undefined) meta.type = type
  const updated = str('updated')
  if (updated !== undefined) meta.updated = updated
  const agent = str('agent')
  if (agent !== undefined) meta.agent = agent
  const status = str('status')
  if (status !== undefined) meta.status = status
  const supersededBy = str('superseded_by')
  if (supersededBy !== undefined) meta.supersededBy = supersededBy
  const expires = str('expires')
  if (expires !== undefined) meta.expires = expires
  return meta
}

/** Today as the UTC calendar date `expires:` is written in. */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Whether a note is out of the running: superseded or deleted by its own
 * status line, or past its `expires:` date. The date compare is on the UTC
 * calendar day, as the stamp validates the field, and an `expires:` that is
 * not a calendar date never expires rather than expiring by accident.
 */
export function isInactive(meta: NoteMeta, today: string): boolean {
  if (meta.status === 'superseded' || meta.status === 'deleted') return true
  return meta.expires !== undefined && CALENDAR_DATE.test(meta.expires) && meta.expires < today
}

/**
 * Hits scoring at least this fraction of the top score are one band, ordered
 * by `updated` instead of by score. The band is for the update-pair shape: an
 * older note and its replacement carry the same topic words and differ by a
 * value and a sentence, so they land within a few percent of each other and
 * the lexical order between them is decided by length normalization, which
 * prefers whichever is shorter. Outside the band the score difference is a
 * real difference in match and recency does not override it.
 */
export const RECENCY_BAND = 0.95

/**
 * Which keys are skipped as ranking input: every `MEMORY.md` index and every
 * bookkeeping entry under `sys.openrecall/`. The rule itself lives in
 * `./keys.ts` (`isHiddenKey`); `isIndexKey` is re-exported from here because
 * the tests of the index exclusion import it from this module.
 *
 * The memory guidance tells agents to keep a `MEMORY.md` table of contents, so
 * it names every other entry and carries the whole namespace's vocabulary
 * without answering anything. Ranked alongside real notes it wins any query
 * that spans a few topics and returns a list of links where the answer was
 * wanted, which is worse the larger the namespace gets. The access sidecar
 * (`sys.openrecall/accessed.json`) has the same shape, every key in the
 * namespace and nothing that answers, and the trash and history that later
 * land under the same prefix are notes nobody asked to be reminded of.
 *
 * They are dropped from the INPUT rather than filtered out of the results,
 * because the results are the smaller half of the damage. Left in the corpus
 * an index still counts toward the entry total and, worse, still adds itself
 * to the document frequency of every term it lists, so a term carried by
 * exactly one note looks like it is carried by two and the note that answers
 * is downweighted for it. Filtering after scoring fixes what is displayed and
 * leaves that intact.
 *
 * At any depth: an agent that organizes a sub-tree the way the guide has it
 * organize the root keeps a `project/MEMORY.md` there too, and it has the
 * same shape and does the same damage as the root one. A fact filed under a
 * hidden key is still reachable through memory_get.
 */
export { isIndexKey } from './keys.ts'

/**
 * Function words that carry no topical signal, removed before scoring.
 *
 * Deliberately not left to document frequency. Rarity weighting only downweights
 * a word that many entries happen to use, and whether a modal or an interrogative
 * is common is a property of the corpus, not of the word: measured over this
 * fixture plus generated filler, `df("should")` stayed 1 at 26, 226 and 2026
 * entries, so idf rated it maximally informative at every size and "when should
 * I repot an orchid" outscored a must-pass pair two to one. Corpus growth does
 * not fix that; a stoplist does, identically at every size.
 *
 * The list is closed to function words on purpose: modals, auxiliaries,
 * interrogatives, pronouns, quantifiers, conjunctions and bare prepositions.
 * Nothing topical goes in, however common it looks. `short`, `long`, `up`,
 * `down`, `out`, `off`, `own`, `get`, `done` and `need` are all arguable and are
 * all left out, because a memdir legitimately holds a short timeout, a long
 * poll, an owner and a service that is down, and a stopped word is unfindable
 * rather than merely downweighted.
 */
const STOP = new Set(
  'the a an and or to of in is it for on with that this i you my your we our as at be are was were do does what how when which their them they me should would could must may might shall will can did have has had been being am who whom whose why where there here if so but not no yes all any some each both more most other such only same then than too very just also about into over under after before again once from by through without during between against within upon across since until while because he she him her his its us'.split(
    ' ',
  ),
)

/**
 * Shortest stem this normalizer will ever produce. Four is not a tuning knob:
 * an unguarded stripper turns `thing` into `th` and `sing` into `s`, and a
 * two-character stem matches a large share of any corpus, so the ranker starts
 * answering confidently with notes that share no meaning with the query. When a
 * rule would cut below this, the rule does not apply.
 */
const MIN_STEM = 4

/**
 * Suffix rules, longest first, as (suffix, replacement). The first rule whose
 * result is at least MIN_STEM characters wins; if none qualifies, the word is
 * left alone. `sses` -> `ss` and `ies` -> `y` come first so `processes` keeps
 * its double s and `queries` meets `query`.
 *
 * Known inconsistency, left for a later change gated by an idempotence test:
 * the rules strip by suffix alone, so `stored` becomes `stor` while `store`
 * stays `store`, and `prefer` becomes `pref` while `preference` becomes
 * `preference`. Changing a rule moves every pinned pair at once, so it is not
 * done as a side effect of a scoring change.
 */
const SUFFIX_RULES: [string, string][] = [
  ['sses', 'ss'],
  ['ies', 'y'],
  ['ements', ''],
  ['ement', ''],
  ['ments', ''],
  ['ment', ''],
  ['ations', ''],
  ['ation', ''],
  ['ings', ''],
  ['ing', ''],
  ['ers', ''],
  ['er', ''],
  ['ed', ''],
  ['s', ''],
]

/** `SUFFIX_RULES` grouped by the last character of the suffix, table order kept within a group. */
const RULES_BY_LAST_CHAR = new Map<string, [string, string][]>()
for (const rule of SUFFIX_RULES) {
  const last = rule[0][rule[0].length - 1]
  RULES_BY_LAST_CHAR.set(last, [...(RULES_BY_LAST_CHAR.get(last) ?? []), rule])
}

/**
 * Collapse a word to a crude stem so query and note match across word forms
 * ("deployment" finds a note that says "deploy"). Hand-written rather than a
 * Porter implementation because the package carries no runtime dependencies and
 * because the guards, not the coverage, are what matter here: a stemmer that
 * over-merges invents matches, and a wrong recall answer delivered confidently
 * is worse than none. Exported so tests can measure it directly, and so the
 * held-out overlap floor is computed over the same terms the ranker sees.
 */
export function stemTerm(term: string): string {
  if (term.length <= MIN_STEM) return term
  // Only the rules whose suffix ends in this word's last character can
  // apply, in their table order; the other ten `endsWith` checks per word
  // were a third of the cost of tokenizing a 2,000-note namespace.
  const rules = RULES_BY_LAST_CHAR.get(term[term.length - 1])
  if (!rules) return term
  for (const [suffix, replacement] of rules) {
    if (!term.endsWith(suffix)) continue
    // Never strip a trailing s that is preceded by one: `process`, `class` and
    // `address` are not plurals, and shortening them merges unrelated words.
    if (suffix === 's' && term.endsWith('ss')) continue
    const stem = term.slice(0, -suffix.length) + replacement
    if (stem.length >= MIN_STEM) return stem
  }
  return term
}

/**
 * The characters that join the parts of a code identifier, a version, a
 * hostname or a path segment: `release-please`, `24.22.1`, `o_excl`,
 * `bun:sqlite`, `src/mcp`. A run of word characters joined by these is a
 * compound.
 */
const JOINER = /[._:/-]/

/** Every word run of a lowercased string, compounds kept whole. */
const RUNS = /[a-z0-9]+(?:[._:/-][a-z0-9]+)*/g

/** A lowercase letter followed by an uppercase one: the seam inside camelCase. */
const CAMEL = /([a-z])([A-Z])/g

/**
 * Whether a token is a compound identifier, kept verbatim and never stemmed or
 * stop-filtered, as opposed to a word. A word never contains a joiner, so the
 * test is on shape alone.
 */
export function isCompound(token: string): boolean {
  return JOINER.test(token)
}

/**
 * Tokenize `s` into `out`, returning how many WORDS (non-compound tokens) were
 * emitted. Shared by both exported tokenizers, which differ only in `keep`.
 *
 * Code identifiers get three treatments, all of which have to agree between
 * the query side and the note side or an identifier is unfindable: camelCase
 * is split at its seams (`rankEntriesDetailed` -> rank entries detailed), a
 * compound is emitted verbatim (`release-please`, `24.22.1`, `o_excl`) so a
 * note that holds the exact identifier beats one that merely holds its parts,
 * and its parts go through the word rule too (`release`, `please`) so the
 * identifier is still findable by part. The compound is a bonus token: it adds
 * score, it is not a word the query has to cover (see `coverage` in `rank`),
 * and it does not count toward a field's length.
 */
function tokenizeInto(s: string, out: string[], keep: (word: string) => boolean): number {
  let words = 0
  for (const run of s.replace(CAMEL, '$1 $2').toLowerCase().match(RUNS) ?? []) {
    if (JOINER.test(run)) {
      out.push(run)
      for (const part of run.split(JOINER)) {
        if (!keep(part)) continue
        out.push(stemTerm(part))
        words++
      }
    } else if (keep(run)) {
      out.push(stemTerm(run))
      words++
    }
  }
  return words
}

const topical = (word: string) => word.length > 1 && !STOP.has(word)
const anyWord = (word: string) => word.length > 1

/**
 * Words of `s` as the ranker counts them: lowercased, single characters and
 * function words dropped, each stemmed, compound identifiers kept whole beside
 * their parts. Exported because a second layer needs the same answer to "what
 * is a query term". `tools.ts` picks which region of a hit to show by
 * weighting the query's terms within that entry, and when it derived its own
 * word list the stoplist never reached it: a stopword confined to one block
 * scored as the rarest term in the entry and won the region from the topical
 * word that made the entry rank at all. Two definitions of a term disagree the
 * moment either moves, so there is one.
 */
export function tokenize(s: string): string[] {
  const out: string[] = []
  tokenizeInto(s, out, topical)
  return out
}

/**
 * The same words without the stoplist, for the one caller that scores WITHIN a
 * single entry rather than across a corpus.
 *
 * A function word carries no topic, which is why the ranker drops it when
 * choosing between entries. Choosing between the blocks of one entry is a
 * different question: the entry's topic is already settled, and what separates
 * two of its sections is frequently exactly the word the ranker discards.
 * "Before you push" and "After you push" are the same section to a stoplisted
 * tokenizer, so a query asking for one gets the other by tie-break.
 *
 * This does not reopen the bug the stoplist closed at the region layer. That one
 * needed a stopword confined to a single block while the topical terms were
 * spread over several, so within-entry rarity handed the function word the
 * highest weight. Rarity is still what weights these terms, and a word that
 * appears in every block (the usual shape of a function word in prose) gets the
 * minimum weight rather than the maximum.
 */
export function tokenizeAll(s: string): string[] {
  const out: string[] = []
  tokenizeInto(s, out, anyWord)
  return out
}

/**
 * Drop YAML-ish frontmatter, returning the body that follows it. The ranker
 * scores the body field over this (the `name:` and `description:` lines are
 * fields of their own, and scoring the raw entry counted the description
 * twice: once as itself and once as body text), and `tools.ts` splits it into
 * regions. One definition, so what the ranker calls the body is what the
 * caller is shown.
 */
export function stripFrontmatterText(content: string): string {
  const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(content)
  return m ? content.slice(m[0].length) : content
}

/** Pull the `description:` value out of YAML-ish frontmatter, if present. */
function frontmatterDescription(content: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (!m) return ''
  const d = /description:\s*(.+)/i.exec(m[1])
  return d ? d[1] : ''
}

/** Pull the `name:` value out of YAML-ish frontmatter, if present. */
function frontmatterName(content: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (!m) return ''
  const n = /(?:^|\n)name:[ \t]*(.+)/i.exec(m[1])
  return n ? n[1] : ''
}

/**
 * The five fields of a note, in the order `FIELD_WEIGHT` and `FIELD_B` are
 * indexed: entry key, frontmatter `name:`, frontmatter `description:`, the
 * body's headings, and the body itself (frontmatter stripped, headings
 * included).
 */
const KEY = 0
const NAME = 1
const DESCRIPTION = 2
const HEADINGS = 3
const BODY = 4
const FIELDS = 5

/**
 * BM25F field weights: how much a term occurrence in a field is worth against
 * one in the body. The description is the one line an author wrote to say
 * what the note answers, so it leads; the key and the name are the author's
 * own label for it; a heading names a section.
 */
const FIELD_WEIGHT = [2, 2, 3, 1.5, 1]

/**
 * BM25F length normalization per field, 0 (none) to 1 (full). The body gets
 * the usual 0.75, which is what lets a one-fact note win over a long note
 * that repeats the topic words without holding the fact: both carry the term,
 * only one is long. The short fields get little, because a two-word key is
 * not more about its words than a four-word one.
 */
const FIELD_B = [0.3, 0.3, 0.5, 0.3, 0.75]

/** BM25 term-frequency saturation. 1.2 is the value every engine ships. */
const K1 = 1.2

/**
 * Term frequencies of one note: a bare number is a body-only term (most of
 * them), an array holds one count per field. Body-only terms are the common
 * case by far, and an array per term is what pushed a 5,000-note index past
 * what the process should hold.
 */
type TermFrequency = number | number[]

type Doc = {
  id: string
  key: string
  namespace?: string
  content: string
  updatedAt?: string
  fingerprint: string
  /** The frontmatter fields, parsed once per content change; `updated` here is the stamp alone. */
  meta: NoteMeta
  /** False for a hidden entry, which is tracked so `retain` sees it but never scored or counted. */
  candidate: boolean
  /**
   * True for a candidate that is superseded, deleted or expired: tokenized,
   * so it can be ranked on request, but kept out of the default statistics.
   * Re-evaluated against the day of each query for the dated ones.
   */
  inactive: boolean
  tf: Map<string, TermFrequency>
  /** Words per field (compounds excluded), what the length normalization reads. */
  len: number[]
}

/** The five token lists of a note and the word count of each. */
function fieldsOf(key: string, content: string): { tokens: string[]; words: number }[] {
  const body = stripFrontmatterText(content)
  const headings: string[] = []
  for (const line of body.split('\n')) if (/^#{1,6}\s/.test(line)) headings.push(line)
  const out: { tokens: string[]; words: number }[] = []
  const field = (text: string) => {
    const tokens: string[] = []
    const words = tokenizeInto(text, tokens, topical)
    out.push({ tokens, words })
  }
  // Keys are split on `/` first so a compound is one path segment
  // (`deploy.md`), never the whole path.
  const keyTokens: string[] = []
  let keyWords = 0
  for (const segment of key.split('/')) keyWords += tokenizeInto(segment, keyTokens, topical)
  out.push({ tokens: keyTokens, words: keyWords })
  field(frontmatterName(content))
  field(frontmatterDescription(content))
  field(headings.join('\n'))
  field(body)
  return out
}

function tokenizeDoc(
  key: string,
  content: string,
): { tf: Map<string, TermFrequency>; len: number[] } {
  const tf = new Map<string, TermFrequency>()
  const len: number[] = []
  const fields = fieldsOf(key, content)
  for (let f = 0; f < FIELDS; f++) {
    len.push(fields[f].words)
    for (const t of fields[f].tokens) {
      const cur = tf.get(t)
      if (f === BODY) {
        // The body is tokenized last, so a bare number here can only mean a
        // term seen in no other field.
        if (cur === undefined) tf.set(t, 1)
        else if (typeof cur === 'number') tf.set(t, cur + 1)
        else cur[BODY]++
      } else {
        const counts = typeof cur === 'object' ? cur : [0, 0, 0, 0, 0]
        counts[f]++
        if (counts !== cur) tf.set(t, counts)
      }
    }
  }
  return { tf, len }
}

/** One entry as handed to `RecallIndex.upsert`. */
export type IndexDoc = {
  /** Identity within the index. The tools use the entry key; the pure ranker uses `namespace|key`. */
  id: string
  key: string
  namespace?: string
  content: string
  updatedAt?: string
  /**
   * Whatever the caller can cheaply compare to know the content is the same
   * as last time: a ciphertext hash when the client has one, else a digest
   * the caller computes. An equal fingerprint skips tokenizing; the empty
   * string never matches, so a caller with no fingerprint always re-tokenizes.
   */
  fingerprint: string
  /** The frontmatter fields, when the caller already parsed them; else `upsert` parses the content. */
  meta?: NoteMeta
}

/** What `rank` may be asked beyond the query and the limit. */
export type RankOptions = {
  /** Rank superseded, deleted and expired notes too. Off by default. */
  includeInactive?: boolean
  /** The UTC calendar date `expires:` is compared against. Defaults to today. */
  today?: string
}

export type RankedResult = {
  /** Entries that cleared the floor, highest score first, capped at `limit`. */
  results: ScoredEntry[]
  /** Entries considered for this query, which excludes every `MEMORY.md` index. */
  searched: number
  /**
   * Superseded, deleted or expired entries left out of `searched`, so the
   * caller can say they exist; 0 when `includeInactive` ranked them.
   */
  inactive: number
  /** Entries that scored but did not clear the floor. Excludes `limit` trimming. */
  belowFloor: number
  /**
   * Entries that cleared the floor and were then cut by `limit`. Deliberately
   * separate from `belowFloor`, which is defined to exclude limit trimming, so
   * neither number can absorb the other's meaning. Without it the caller cannot
   * distinguish a namespace with exactly `limit` relevant entries from one with
   * many more, and reporting the first as the second is how an agent concludes
   * it has seen everything the corpus holds.
   */
  trimmedByLimit: number
  /**
   * Why `results` is empty, absent when anything was returned. The two empty
   * cases are not the same event and must not render as the same sentence: a
   * query the corpus was searched for and could not answer ('below-floor') is
   * an answer about the corpus, while a query of nothing but function words
   * ('no-content-terms') never reached the corpus at all and its zero
   * below-floor count means nothing was scored, not that nothing was withheld.
   * Reporting the second as the first tells the caller its fact is unrecorded
   * and invites the duplicate save the no-match recovery exists to prevent.
   */
  reason?: 'no-content-terms' | 'below-floor'
}

/** The floor constants, in one object so a fit can try alternatives against `applyFloors`. */
export type Floors = {
  /** `norm` the top hit needs for the query to be answered at all. */
  TOP_FLOOR: number
  /** Relative lead over the runner-up, `(top - second) / top`, that qualifies a weaker top hit. */
  GAP: number
  /** `norm` a top hit with a clear lead needs instead of TOP_FLOOR. */
  CLEAR_FLOOR: number
  /** `norm` every further member needs. */
  MEMBER_FLOOR: number
  /** Fraction of the top score every further member needs. */
  REL_FLOOR: number
}

/**
 * The relevance floor: what a ranking has to look like before anything in it
 * reaches the caller, in units that do not move with corpus size.
 *
 * Two routes answer a query. The usual one is a top hit whose `norm` reaches
 * TOP_FLOOR: it covers most of the query and carries the terms in the fields
 * that count. The other is a weak but unambiguous winner: a top hit that sits
 * above CLEAR_FLOOR and leads the runner-up by GAP of its own score. That
 * route exists for the paraphrase case, where a question shares one word
 * with the note that answers it and nothing else in the namespace carries
 * that word at all; the hit is weak on its own terms and still the only
 * candidate there is. Below either bar the result is empty and the reason is
 * 'below-floor'. Members behind the top hit need MEMBER_FLOOR on their own
 * norm and REL_FLOOR of the top score, so a strong answer does not drag a tail
 * of one-term flukes in with it.
 *
 * FITTED 2026-11-05 with `scripts/fit-floor.ts` on the four non-residual
 * TUNING pairs plus the twelve OFF_DOMAIN probes in `tests/recall-corpus.ts`,
 * over CORPUS (25 candidates). HELD_OUT was not used to choose anything; it is
 * reported by the script and ratcheted in `tests/recall-regression.test.ts`.
 *
 *   TUNING (must answer, expected key first):
 *     "namespace validation rules"           norm 0.763  gap 0.92
 *     "deployment process"                   norm 0.221  gap 0.43
 *     "am I allowed to open a pull request"  norm 0.074  gap 0.87
 *     "what do I need … push my work …"      norm 0.198  gap 0.84
 *   OFF_DOMAIN (should not answer), the four of twelve that score at all:
 *     "which river runs through Budapest"    norm 0.078  gap 1.00  (`runs`, CI description)
 *     "what tuning does a cello use"         norm 0.078  gap 1.00  (`use`, tone description)
 *     "which key is the moonlight sonata …"  norm 0.044  gap 0.18  (`key`, crypto)
 *     "how long should I braise … red wine"  norm 0.014  gap 0.05  (`red`, deploy)
 *
 * No constants separate all sixteen: the weakest must-pass ("open a pull
 * request": two of four words, in a long body, nothing else carries them) and
 * the strongest off-domain probes (one of three words, in a short
 * description, nothing else carries it) are the same shape to a lexical
 * ranker. The fit is therefore 4/4 tuning and 10/12 off-domain, with the two
 * sole-carrier probes answered through the clear route, stated here rather
 * than hidden.
 *
 * TOP_FLOOR 0.1 is bounded above by the weakest tuning pair that has a
 * runner-up close behind ("deployment process", 0.221; the push pair at 0.198
 * also clears it) and below by the strongest off-domain probe without a clear
 * lead ("moonlight sonata", 0.044), with about 2x margin on each side; 0.1 is
 * also where a body-only hit covering half the query's words lands (0.45 x
 * 0.5 x 0.5), which is the shape it means to admit. GAP 0.3 is bounded above
 * by "deployment process" (0.43) and below by "moonlight sonata" (0.18).
 * CLEAR_FLOOR is bounded above by "open a pull request" (0.074) and not at all
 * from below by the fit set (every off-domain probe under it is held off by
 * GAP), so it is set structurally: a sole carrier must still match one word in
 * five at the saturation a long note gives (0.25 x 1/25 = 0.01). MEMBER_FLOOR
 * 0.02 and REL_FLOOR 0.1 trim one-of-three flukes under a strong top hit
 * (`rule` alone under "namespace validation rules" sits at 0.06 of the top)
 * while keeping a member that covers half the query on a common word (the
 * `queue kestrel` case in `tests/relevance.test.ts`, 0.14 of the top); on the
 * harness no value tried for either cost a single gold.
 *
 * Joined the tuning set after the fit, without moving it: "are we moving to
 * postgres" (norm 0.46), which is decided by the old note being stamped
 * superseded and dropped from the candidates, not by any constant here.
 *
 * Reported, not fitted: HELD_OUT 4 of 12 top-1, the same four as before (the
 * sole-carrier paraphrases, all through the clear route). Against the
 * 2,000-entry harness this floor abstains on 8 of 25 unanswerable questions
 * (abstention recall 0.32, from 0) and on 12 answerable paraphrases whose
 * gold sat inside a ten-way tie on one word (R@10 0.683 -> 0.639); R@1 rose
 * 0.378 -> 0.439 and the false-answer rate fell 0.668 -> 0.385. The full
 * table is in the commit that fitted it and in `tests/bench/recall-baseline.json`.
 *
 * The lesson the previous floor left behind, kept short: an absolute score
 * floor measured on 26 entries did not survive 838, because raw scores grow
 * with corpus size and incidental one-term overlap climbs to meet any fixed
 * number. A floor on `norm` does not move with N. The other lesson is about
 * probes: never fit on queries drawn from the target's own rarest terms (the
 * easiest query an entry can receive), and never fit on the held-out set.
 */
export const FLOORS: Floors = {
  TOP_FLOOR: 0.1,
  GAP: 0.3,
  CLEAR_FLOOR: 0.01,
  MEMBER_FLOOR: 0.02,
  REL_FLOOR: 0.1,
}

/**
 * Cut a sorted scoring to what reaches the caller, or to nothing. Pure, and
 * exported so the fit script can try other constants against the same rule
 * the ranker applies.
 */
export function applyFloors(scored: ScoredEntry[], floors: Floors = FLOORS): ScoredEntry[] {
  const top = scored[0]
  if (!top || top.score <= 0) return []
  const topNorm = top.norm ?? 0
  const second = scored[1]?.score ?? 0
  const gap = (top.score - second) / top.score
  const answerable =
    topNorm >= floors.TOP_FLOOR || (gap >= floors.GAP && topNorm >= floors.CLEAR_FLOOR)
  if (!answerable) return []
  const kept = [top]
  for (let i = 1; i < scored.length; i++) {
    const r = scored[i]
    if ((r.norm ?? 0) >= floors.MEMBER_FLOOR && r.score >= top.score * floors.REL_FLOOR)
      kept.push(r)
  }
  return kept
}

/**
 * The document frequencies, total field lengths and note count of one group
 * of notes, kept incrementally: adding a note adds its own counts, removing
 * it subtracts them.
 */
class Stats {
  n = 0
  readonly df = new Map<string, number>()
  readonly totalLen = [0, 0, 0, 0, 0]

  add(d: Doc): void {
    this.n++
    for (let f = 0; f < FIELDS; f++) this.totalLen[f] += d.len[f]
    for (const t of d.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
  }

  subtract(d: Doc): void {
    this.n--
    for (let f = 0; f < FIELDS; f++) this.totalLen[f] -= d.len[f]
    for (const t of d.tf.keys()) {
      const n = (this.df.get(t) ?? 0) - 1
      if (n > 0) this.df.set(t, n)
      else this.df.delete(t)
    }
  }
}

/**
 * The corpus statistics of one namespace, kept between recalls and updated
 * per entry.
 *
 * What is stored per note is its term frequencies per field and its field
 * lengths; what is stored per index is the document frequency of every term
 * and the total length of every field. Scoring walks every note and looks up
 * each query term in it (N x |q| map lookups, under 30,000 at 5,000 notes)
 * rather than keeping postings lists: simpler, half the memory, and trivially
 * incremental, since removing a note is subtracting its own counts.
 *
 * A hidden entry (`isHiddenKey`: an index or a `sys.openrecall/` bookkeeping
 * entry) is tracked so `retain` and `sync` see it, but it is not a candidate:
 * it is never scored, never counted in `searched`, and contributes nothing to
 * any statistic.
 *
 * An inactive note (`isInactive`: superseded, deleted or expired by its own
 * frontmatter) is tokenized but its counts go to a second set of statistics
 * that a default query never reads, so it is neither scored nor counted in
 * `searched` and adds nothing to any term's document frequency: the counts a
 * miss reports describe the notes that could have answered, and a term that
 * only a replaced note still carries is as rare as it is. A query that asks
 * for inactive notes reads both sets, which is exactly ranking the union.
 */
export class RecallIndex {
  private readonly docs = new Map<string, Doc>()
  private readonly active = new Stats()
  private readonly inactiveStats = new Stats()
  /** Ids of candidates with an `expires:` date, whose activity depends on the day of the query. */
  private readonly dated = new Set<string>()

  /** Notes tracked, index entries included. */
  get size(): number {
    return this.docs.size
  }

  has(id: string): boolean {
    return this.docs.has(id)
  }

  /** The stored record for `id`, for tests that check what an upsert kept or replaced. */
  doc(id: string): Readonly<Doc> | undefined {
    return this.docs.get(id)
  }

  /**
   * Add or replace one note. Returns 'unchanged' when the stored fingerprint
   * equals the given one, in which case nothing is tokenized and only the
   * carried fields (content, namespace, updatedAt) are refreshed.
   */
  upsert(doc: IndexDoc): 'added' | 'updated' | 'unchanged' {
    const existing = this.docs.get(doc.id)
    if (existing && doc.fingerprint !== '' && existing.fingerprint === doc.fingerprint) {
      existing.content = doc.content
      existing.updatedAt = doc.updatedAt
      existing.namespace = doc.namespace
      return 'unchanged'
    }
    if (existing) this.subtract(existing)
    const candidate = !isHiddenKey(doc.key)
    const { tf, len } = candidate
      ? tokenizeDoc(doc.key, doc.content)
      : { tf: new Map<string, TermFrequency>(), len: [0, 0, 0, 0, 0] }
    // Parsed once per content change, like the term maps; a hidden entry's
    // frontmatter is as irrelevant as its terms.
    const meta = candidate ? (doc.meta ?? noteMeta(doc.content)) : {}
    const stored: Doc = {
      id: doc.id,
      key: doc.key,
      namespace: doc.namespace,
      content: doc.content,
      updatedAt: doc.updatedAt,
      fingerprint: doc.fingerprint,
      meta,
      candidate,
      inactive: candidate && isInactive(meta, utcToday()),
      tf,
      len,
    }
    this.docs.set(doc.id, stored)
    this.add(stored)
    return existing ? 'updated' : 'added'
  }

  /** Drop one note. Returns whether it was there. */
  remove(id: string): boolean {
    const existing = this.docs.get(id)
    if (!existing) return false
    this.subtract(existing)
    this.docs.delete(id)
    return true
  }

  /**
   * Move every dated note to the side of the line `today` puts it on. Called
   * once per query, so a note that expires while the process lives stops
   * ranking the day it expires, without re-tokenizing anything.
   */
  private refresh(today: string): void {
    // Snapshot: moving a note deletes and re-adds its id in `dated`.
    for (const id of [...this.dated]) {
      const d = this.docs.get(id)
      if (!d) continue
      const inactive = isInactive(d.meta, today)
      if (inactive === d.inactive) continue
      this.subtract(d)
      d.inactive = inactive
      this.add(d)
    }
  }

  /** Drop every note not in `ids`. Returns the ids removed. */
  retain(ids: Iterable<string>): string[] {
    const keep = ids instanceof Set ? ids : new Set(ids)
    const removed: string[] = []
    for (const id of this.docs.keys()) if (!keep.has(id)) removed.push(id)
    for (const id of removed) this.remove(id)
    return removed
  }

  /** Make the index hold exactly `docs`: upsert each, then drop the rest. */
  sync(docs: IndexDoc[]): { added: number; updated: number; unchanged: number; removed: number } {
    const counts = { added: 0, updated: 0, unchanged: 0, removed: 0 }
    const ids = new Set<string>()
    for (const doc of docs) {
      counts[this.upsert(doc)]++
      ids.add(doc.id)
    }
    counts.removed = this.retain(ids).length
    return counts
  }

  private add(d: Doc): void {
    if (!d.candidate) return
    if (d.meta.expires !== undefined) this.dated.add(d.id)
    ;(d.inactive ? this.inactiveStats : this.active).add(d)
  }

  private subtract(d: Doc): void {
    if (!d.candidate) return
    this.dated.delete(d.id)
    ;(d.inactive ? this.inactiveStats : this.active).subtract(d)
  }

  /** The statistics a query reads: the active notes, plus the inactive ones when asked. */
  private stats(includeInactive: boolean): Stats[] {
    return includeInactive ? [this.active, this.inactiveStats] : [this.active]
  }

  /**
   * Score every candidate of every given index against `query`, highest
   * first, with no floor applied. The statistics (N, document frequencies,
   * average field lengths) are summed across the indexes before anything is
   * scored, so ranking three namespaces together is exactly ranking their
   * union as one corpus: a term rare in one and common in another is weighed
   * by what the caller can actually be answered from.
   *
   * Ties break on key, then namespace, so equal scores render in a stable,
   * readable order rather than in map order.
   */
  static scoreAll(
    indexes: RecallIndex[],
    query: string,
    opts: RankOptions = {},
  ): { scored: ScoredEntry[]; searched: number; inactive: number; terms: string[] } {
    const includeInactive = opts.includeInactive ?? false
    const today = opts.today ?? utcToday()
    let searched = 0
    let inactive = 0
    const total = [0, 0, 0, 0, 0]
    for (const idx of indexes) {
      idx.refresh(today)
      for (const s of idx.stats(includeInactive)) {
        searched += s.n
        for (let f = 0; f < FIELDS; f++) total[f] += s.totalLen[f]
      }
      if (!includeInactive) inactive += idx.inactiveStats.n
    }
    const terms = [...new Set(tokenize(query))]
    if (terms.length === 0 || searched === 0) return { scored: [], searched, inactive, terms }

    const n = searched
    const compound = terms.map(isCompound)
    const words = compound.filter(c => !c).length
    const dfs = terms.map(t => {
      let df = 0
      for (const idx of indexes) for (const s of idx.stats(includeInactive)) df += s.df.get(t) ?? 0
      return df
    })
    // Never negative: a term in every note is worth ln(1 + 0.5 / (N + 0.5)).
    const idfOf = (df: number) => Math.log(1 + (n - df + 0.5) / (df + 0.5))
    const idf = dfs.map(idfOf)
    // The most this query could score, for `norm`: every word matched and
    // saturated at 1. A word no note carries is counted at the weight it
    // would have if one note did (df 1), not at its df-0 weight: that weight
    // is ln(2N + 2), which in a one-entry namespace is five times the weight
    // of the word that DID match, so a half-covered query there normalized to
    // nothing. Compounds are a bonus on top (see `tokenizeInto`), so they are
    // left out and `norm` is clamped instead of letting them push it past 1.
    let maxIdf = 0
    for (let i = 0; i < terms.length; i++) {
      if (words > 0 && compound[i]) continue
      maxIdf += idfOf(Math.max(dfs[i], 1))
    }

    const avg = total.map(t => t / n)
    // Per-field normalizer parts hoisted out of the per-note loop: K_f = 1 - b_f + b_f * len_f / avg_f.
    const bOver = FIELD_B.map((b, f) => (avg[f] > 0 ? b / avg[f] : 0))
    const oneMinusB = FIELD_B.map(b => 1 - b)

    const scored: ScoredEntry[] = []
    for (const idx of indexes) {
      for (const d of idx.docs.values()) {
        if (!d.candidate || (d.inactive && !includeInactive)) continue
        const wKey = FIELD_WEIGHT[KEY] / (oneMinusB[KEY] + bOver[KEY] * d.len[KEY])
        const wName = FIELD_WEIGHT[NAME] / (oneMinusB[NAME] + bOver[NAME] * d.len[NAME])
        const wDesc =
          FIELD_WEIGHT[DESCRIPTION] /
          (oneMinusB[DESCRIPTION] + bOver[DESCRIPTION] * d.len[DESCRIPTION])
        const wHead =
          FIELD_WEIGHT[HEADINGS] / (oneMinusB[HEADINGS] + bOver[HEADINGS] * d.len[HEADINGS])
        const wBody = FIELD_WEIGHT[BODY] / (oneMinusB[BODY] + bOver[BODY] * d.len[BODY])
        let score = 0
        let covered = 0
        for (let i = 0; i < terms.length; i++) {
          const tf = d.tf.get(terms[i])
          if (tf === undefined) continue
          const weighted =
            typeof tf === 'number'
              ? tf * wBody
              : tf[KEY] * wKey +
                tf[NAME] * wName +
                tf[DESCRIPTION] * wDesc +
                tf[HEADINGS] * wHead +
                tf[BODY] * wBody
          score += (idf[i] * weighted) / (K1 + weighted)
          if (!compound[i]) covered++
        }
        // Coverage degrades a score, it does not eliminate an entry: partial
        // matches stay rankable and the floor decides what is returned. An
        // entry covering nothing scores zero and never clears it anyway.
        if (words > 0) score *= covered / words
        // The stamp wins over the manifest: the manifest records the last
        // write of the ciphertext, which a resave that changed nothing but a
        // sidecar can move, while the stamp is the client's own record.
        const updated = d.meta.updated ?? d.updatedAt
        scored.push({
          key: d.key,
          score,
          norm: maxIdf > 0 ? Math.min(1, score / maxIdf) : 0,
          content: d.content,
          ...(d.namespace === undefined ? {} : { namespace: d.namespace }),
          ...(d.updatedAt === undefined ? {} : { updatedAt: d.updatedAt }),
          meta: { ...d.meta, ...(updated === undefined ? {} : { updated }) },
        })
      }
    }

    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.key.localeCompare(b.key) ||
        (a.namespace ?? '').localeCompare(b.namespace ?? ''),
    )
    return { scored, searched, inactive, terms }
  }

  /**
   * Rank the union of the given indexes against `query`, with the counts the
   * no-match message needs. This is the one scoring path: `rankEntriesDetailed`
   * builds a transient index and calls it.
   */
  static rank(indexes: RecallIndex[], query: string, limit = 5, opts?: RankOptions): RankedResult {
    const { scored, searched, inactive, terms } = RecallIndex.scoreAll(indexes, query, opts)
    if (terms.length === 0)
      return {
        results: [],
        searched,
        inactive,
        belowFloor: 0,
        trimmedByLimit: 0,
        reason: 'no-content-terms',
      }
    const kept = applyFloors(scored)
    if (kept.length === 0)
      return {
        results: [],
        searched,
        inactive,
        belowFloor: searched,
        trimmedByLimit: 0,
        reason: 'below-floor',
      }
    return {
      results: recencyOrder(kept).slice(0, limit),
      searched,
      inactive,
      belowFloor: searched - kept.length,
      trimmedByLimit: Math.max(0, kept.length - limit),
    }
  }
}

/** `updated` as a number for ordering; undefined when absent or not a date. */
function whenOf(entry: ScoredEntry): number | undefined {
  const s = entry.meta?.updated
  if (s === undefined) return undefined
  const t = Date.parse(s)
  return Number.isNaN(t) ? undefined : t
}

/**
 * Reorder the band of hits scoring within `RECENCY_BAND` of the top one by
 * `updated`, newest first, and leave everything after the band as it was.
 * Applied after the floor and before the limit, so it can neither promote a
 * withheld entry nor change which entries clear the floor. Dated entries go
 * before undated ones; within equal dates, and among the undated, the score
 * order with its key and namespace tiebreaks is kept (the sort is stable).
 */
export function recencyOrder(kept: ScoredEntry[]): ScoredEntry[] {
  const top = kept[0]
  if (!top) return kept
  const floor = top.score * RECENCY_BAND
  let n = 0
  while (n < kept.length && kept[n].score >= floor) n++
  if (n < 2) return kept
  const band = kept.slice(0, n).sort((a, b) => {
    const ta = whenOf(a)
    const tb = whenOf(b)
    if (ta === tb) return 0
    if (ta === undefined) return 1
    if (tb === undefined) return -1
    return tb - ta
  })
  return [...band, ...kept.slice(n)]
}

/**
 * Rank a combined corpus without confusing identical keys from distinct
 * namespaces. Pure: a transient index is built over `entries` and dropped, so
 * the harness and the tests exercise exactly the scoring the tools run.
 */
export function rankEntriesDetailed(
  query: string,
  entries: MemoryEntry[],
  limit = 5,
  opts?: RankOptions,
): RankedResult {
  const index = new RecallIndex()
  for (const e of entries) {
    index.upsert({
      id: `${e.namespace ?? ''}|${e.key}`,
      key: e.key,
      namespace: e.namespace,
      content: e.content,
      updatedAt: e.updatedAt,
      fingerprint: '',
    })
  }
  return RecallIndex.rank([index], query, limit, opts)
}

/**
 * Rank entries (entryKey -> plaintext) against a query, with the counts the
 * no-match message needs. `rankMemories` is the plain-list form and delegates
 * here.
 */
export function rankMemoriesDetailed(
  query: string,
  entries: Record<string, string>,
  limit = 5,
  opts?: RankOptions,
): RankedResult {
  return rankEntriesDetailed(
    query,
    Object.entries(entries).map(([key, content]) => ({ key, content })),
    limit,
    opts,
  )
}

/**
 * Rank entries (entryKey -> plaintext) against a query. Returns the top `limit`
 * by score, highest first; entries below the relevance floor are withheld, and
 * a query nothing answers returns nothing.
 */
export function rankMemories(
  query: string,
  entries: Record<string, string>,
  limit = 5,
): ScoredEntry[] {
  return rankMemoriesDetailed(query, entries, limit).results
}
