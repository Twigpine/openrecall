/**
 * Local relevance ranking for memory_recall.
 *
 * Recall happens entirely client-side — the server only ever holds ciphertext,
 * so it cannot rank for us. We decrypt locally, then score each entry against
 * the query with a small TF-style ranker tuned for memdir markdown: matches in
 * the frontmatter `description:` and in the entry key (filename) count for more
 * than matches buried in the body, and an entry must cover a decent share of
 * the query terms to rank at all. This mirrors the intent of openclaude's
 * findRelevantMemories without needing its internals.
 */

export type ScoredEntry = { key: string; score: number; content: string }

// Common words that shouldn't drive relevance.
const STOP = new Set(
  'the a an and or to of in is it for on with that this i you my your we our as at be are was were do does what how when which their them they me'.split(
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
 * Rank entries (entryKey -> plaintext) against a query. Returns the top `limit`
 * by score, highest first; entries with no query-term overlap are dropped.
 */
export function rankMemories(
  query: string,
  entries: Record<string, string>,
  limit = 5,
): ScoredEntry[] {
  const qTerms = new Set(tokenize(query))
  if (qTerms.size === 0) return []

  const scored: ScoredEntry[] = []
  for (const [key, content] of Object.entries(entries)) {
    const keyTokens = new Set(tokenize(key))
    const descTokens = new Set(tokenize(frontmatterDescription(content)))
    const bodyTf = new Map<string, number>()
    for (const t of tokenize(content)) bodyTf.set(t, (bodyTf.get(t) ?? 0) + 1)

    let score = 0
    let covered = 0
    for (const t of qTerms) {
      let hit = false
      if (bodyTf.has(t)) {
        score += 1 + Math.log(bodyTf.get(t)!)
        hit = true
      }
      if (descTokens.has(t)) {
        score += 3
        hit = true
      }
      if (keyTokens.has(t)) {
        score += 2
        hit = true
      }
      if (hit) covered++
    }
    if (covered === 0) continue
    // Reward entries that cover more of the query, penalize one-term flukes.
    score *= covered / qTerms.size
    scored.push({ key, score, content })
  }

  scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
  return scored.slice(0, limit)
}
