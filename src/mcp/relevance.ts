/**
 * Local relevance ranking for memory_recall.
 *
 * Recall happens entirely client-side — the server only ever holds ciphertext,
 * so it cannot rank for us. We decrypt locally, then score each entry against
 * the query with a small TF-IDF-style ranker tuned for memdir markdown: matches
 * in the frontmatter `description:` and in the entry key (filename) count for
 * more than matches buried in the body, a term is worth less the more of the
 * caller's entries carry it, and covering less of the query scales an entry's
 * score down. This mirrors the intent of openclaude's findRelevantMemories
 * without needing its internals.
 *
 * What an entry covers no longer decides whether it is returned; the floor
 * below does. That split matters because a wrong recall answer delivered
 * confidently is worse than none: a query the corpus cannot answer has to come
 * back empty rather than with whatever scored highest among the noise.
 */

export type ScoredEntry = { key: string; score: number; content: string }

/**
 * The namespace-root index, skipped as ranking input.
 *
 * The memory guidance tells agents to keep a `MEMORY.md` table of contents, so
 * it names every other entry and carries the whole namespace's vocabulary
 * without answering anything. Ranked alongside real notes it wins any query
 * that spans a few topics and returns a list of links where the answer was
 * wanted, which is worse the larger the namespace gets.
 *
 * It is dropped from the INPUT rather than filtered out of the results,
 * because the results are the smaller half of the damage. Left in the corpus
 * it still counts toward the entry total and, worse, still adds itself to the
 * document frequency of every term it lists, so a term carried by exactly one
 * note looks like it is carried by two and the note that answers is
 * downweighted for it. Filtering after scoring fixes what is displayed and
 * leaves that intact.
 *
 * Exact key match, and only at the namespace root: `project/MEMORY.md` is a
 * note somebody wrote, not the guidance-named index, and a basename or suffix
 * test would swallow it.
 */
const INDEX_KEY = 'MEMORY.md'

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
  for (const [suffix, replacement] of SUFFIX_RULES) {
    if (!term.endsWith(suffix)) continue
    // Never strip a trailing s that is preceded by one: `process`, `class` and
    // `address` are not plurals, and shortening them merges unrelated words.
    if (suffix === 's' && term.endsWith('ss')) continue
    const stem = term.slice(0, -suffix.length) + replacement
    if (stem.length >= MIN_STEM) return stem
  }
  return term
}

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter(t => t.length > 1 && !STOP.has(t))
    .map(stemTerm)
}

/** Pull the `description:` value out of YAML-ish frontmatter, if present. */
function frontmatterDescription(content: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (!m) return ''
  const d = /description:\s*(.+)/i.exec(m[1])
  return d ? d[1] : ''
}

/**
 * Fraction of the top score an entry must reach to be returned. A query's own
 * best hit sets the scale, so this trims the tail of one-token flukes that sit
 * an order of magnitude below the real answer without needing a corpus-wide
 * constant. It can never produce an empty result: the top hit is always 100% of
 * itself, which is why the absolute floor below exists.
 */
const RELATIVE_FLOOR = 0.25

/**
 * Minimum top score for a query to be answered at all. This is the only
 * component that can produce no-match, and it is what replaces the old
 * zero-coverage hard drop: with soft coverage, a query relevant to nothing
 * still scores most of the corpus above zero on incidental one-token matches.
 *
 * CORPUS- AND SCORING-SPECIFIC. Measured 2026-08-06 against the fixture corpus
 * in `tests/recall-corpus.ts` (26 entries) with the rarity weighting and soft
 * coverage in this file. It does not transfer to another corpus or another
 * scoring function; any change to the weights above means re-measuring it, and
 * the plan's quoted 4.62-8.10 vs 1.61-3.15 separation came from a different
 * corpus and a pre-stemming ranker, so it was not inherited.
 *
 * RE-MEASURED with the function-word stoplist above in place. The previous 0.5
 * was fitted to a score distribution that no longer exists and would now be
 * stale rather than conservative.
 *
 * Measured populations, top score per query (4 non-residual tuning pairs plus
 * the 12 held-out probes against 12 off-domain probes about cooking, geography,
 * sport, gardening and music):
 *   relevant   0.66 .. 43.23 over the 11 that match anything, e.g. "namespace
 *              validation rules" 43.23, "deployment process" 9.37, "am I
 *              allowed to open a pull request" 0.66; 5 paraphrases match
 *              nothing at all and sit at 0.00.
 *   irrelevant 0.00 .. 4.39, with 8 of 12 now at 0.00 (up from 4), e.g. "how
 *              long should I braise short ribs in red wine" 0.55, "which key is
 *              the moonlight sonata written in" 3.55, "which river runs through
 *              Budapest" 4.39.
 *
 * The stoplist removed the whole class of false positives that came from a
 * function word being rare: "when should I repot an orchid" and "who won the
 * 1994 world cup final" both dropped from above the weakest must-pass pair to
 * exactly zero. The populations still DO NOT separate, and the reason is now a
 * different and harder one: the three remaining non-zero irrelevant probes match
 * on genuinely topical words this corpus happens to use ("key" in the crypto
 * note, "runs" in the CI description, "use" in the tone note). Those are words a
 * caller must be able to search for, so no stoplist reaches them and only
 * semantics would.
 *
 * 0.6 sits in the real gap that is left, above the strongest irrelevant query
 * the floor can reach (0.55) and below the weakest must-pass (0.66), with about
 * 9% either side rather than the 6% the pre-stoplist value had. The consequence
 * is stated rather than hidden: 3 of 12 irrelevant probes still return a hit.
 *
 * RE-CHECKED after the index exclusion below, which drops the entry count these
 * scores are weighed against from 26 to 25 and removes the index from the
 * document frequency of every term it lists. Scores rose; the gap did not
 * close. The weakest must-pass went from 0.66 to 2.93, the named strongest
 * irrelevant ("braise short ribs") from 0.55 to 0.54, and the lowest non-zero
 * score among all relevant probes is 0.65. 0.6 still separates them, so the
 * value stands unchanged rather than being refitted to a distribution it was
 * not measured against.
 */
const ABSOLUTE_FLOOR = 0.6

export type RankedResult = {
  /** Entries that cleared both floors, highest score first, capped at `limit`. */
  results: ScoredEntry[]
  /** Entries considered for this query, which excludes the namespace-root index. */
  searched: number
  /** Entries that scored but did not clear the floor. Excludes `limit` trimming. */
  belowFloor: number
}

/**
 * How many of `entries` contain each query term, so a term's weight can scale
 * with its rarity. Computed per call over the entries passed in rather than
 * from a stored index: recall ranks whatever the caller decrypted, there is no
 * persistent corpus to build statistics from, and the caller's set is the only
 * population the answer is drawn from anyway.
 */
function documentFrequency(qTerms: Set<string>, docs: Set<string>[]): Map<string, number> {
  const df = new Map<string, number>()
  for (const t of qTerms) {
    let n = 0
    for (const d of docs) if (d.has(t)) n++
    df.set(t, n)
  }
  return df
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
): RankedResult {
  // The index is removed here, before anything counts entries or terms, so
  // every number downstream (the searched count, the document frequencies, the
  // entry total they are weighed against) is computed over the same population
  // the caller can actually be answered from.
  const candidates = Object.entries(entries).filter(([key]) => key !== INDEX_KEY)
  const searched = candidates.length
  const qTerms = new Set(tokenize(query))
  if (qTerms.size === 0) return { results: [], searched, belowFloor: 0 }

  // One tokenizing pass, reused by the document-frequency pass and the scoring
  // pass, so rarity weighting costs an extra walk over the term sets rather than
  // an extra tokenization of every entry.
  const docs = candidates.map(([key, content]) => {
    const keyTokens = new Set(tokenize(key))
    const descTokens = new Set(tokenize(frontmatterDescription(content)))
    const bodyTf = new Map<string, number>()
    for (const t of tokenize(content)) bodyTf.set(t, (bodyTf.get(t) ?? 0) + 1)
    const all = new Set([...keyTokens, ...descTokens, ...bodyTf.keys()])
    return { key, content, keyTokens, descTokens, bodyTf, all }
  })

  const df = documentFrequency(
    qTerms,
    docs.map(d => d.all),
  )
  // A term in every entry is worth log(2); a term in one of 27 is worth log(28).
  // Never zero, so a common term still contributes something.
  const idf = (t: string) => Math.log(1 + searched / Math.max(df.get(t) ?? 0, 1))

  const scored: ScoredEntry[] = []
  for (const d of docs) {
    let score = 0
    let covered = 0
    for (const t of qTerms) {
      let raw = 0
      if (d.bodyTf.has(t)) raw += 1 + Math.log(d.bodyTf.get(t)!)
      if (d.descTokens.has(t)) raw += 3
      if (d.keyTokens.has(t)) raw += 2
      if (raw > 0) {
        score += raw * idf(t)
        covered++
      }
    }
    // Coverage degrades a score, it no longer eliminates an entry: partial
    // matches stay rankable and the floors below decide what is returned. An
    // entry covering nothing scores zero and never clears the floor anyway.
    score *= covered / qTerms.size
    scored.push({ key: d.key, score, content: d.content })
  }

  scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))

  const top = scored[0]?.score ?? 0
  if (top < ABSOLUTE_FLOOR) return { results: [], searched, belowFloor: searched }
  const kept = scored.filter(r => r.score >= top * RELATIVE_FLOOR)
  return { results: kept.slice(0, limit), searched, belowFloor: searched - kept.length }
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
