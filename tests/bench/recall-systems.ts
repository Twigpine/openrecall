/**
 * The systems the recall harness compares, behind one signature: a query and
 * a corpus in, an ordered list of entry keys and the plaintext bytes handed
 * to the caller out.
 *
 * - `tfidf` is the product ranker, `rankMemoriesDetailed` from
 *   `src/mcp/relevance.ts`, called as a pure function over the corpus. An
 *   empty result with a reason is an abstention. It is called directly rather
 *   than through the MCP tools or a client because `tests/setup.ts` pins the
 *   server caps at five entries, and because the harness measures ranking,
 *   not transport.
 * - `substring` is the grep baseline: the count of the query's content terms
 *   (lowercased, stopwords dropped, NOT stemmed, because grep does not stem)
 *   that occur as substrings of the key plus body, highest count first, ties
 *   by key in code-point order, at most ten, nothing when nothing matched. It
 *   is deliberately a little stronger than `memory_search`, which matches the
 *   whole query as one substring; a ranker that cannot beat a per-term grep
 *   has no reason to exist. It sees `MEMORY.md`, as `memory_search` does.
 * - `full` returns every key in code-point order and the whole corpus as its
 *   bytes. Its quality numbers are meaningless by design; it is the cost
 *   ceiling the bytes-per-query column is read against.
 *
 * Timing is reported per query as a mean over the question set. It is
 * informational: the blocking test asserts quality, and the latency budget
 * lives in `tests/relevance.test.ts`.
 */

import { createHash } from 'node:crypto'
import { rankMemoriesDetailed } from '../../src/mcp/relevance.ts'
import { contentTerms } from '../recall-corpus.ts'
import type { Question } from './recall-fixture.ts'
import type { SystemOutput } from './recall-metrics.ts'

export type Corpus = Record<string, string>
export type System = (query: string, corpus: Corpus) => SystemOutput

/**
 * SHA-256 over every key and body in key order. Stored in the baseline so a
 * generator change that moves the metrics without touching a question still
 * fails the drift guard instead of being read as a ranker change.
 */
export function corpusDigest(corpus: Corpus): string {
  const h = createHash('sha256')
  for (const key of Object.keys(corpus).sort()) h.update(`${key}\0${corpus[key]}\n`)
  return h.digest('hex')
}

export const SYSTEM_NAMES = ['tfidf', 'substring', 'full'] as const
export type SystemName = (typeof SYSTEM_NAMES)[number]

const utf8 = new TextEncoder()
const byteLength = (s: string) => utf8.encode(s).byteLength

const identity = (t: string) => t

/**
 * Per-corpus lowercase haystacks and sizes, built once per corpus object. The
 * cache is keyed on the corpus identity, so a different corpus (or a changed
 * one, which the harness never does) gets its own entry.
 */
type Prepared = {
  entries: { key: string; haystack: string; bytes: number }[]
  keys: string[]
  bytes: number
}
const prepared = new WeakMap<Corpus, Prepared>()

function prepare(corpus: Corpus): Prepared {
  let p = prepared.get(corpus)
  if (p) return p
  const keys = Object.keys(corpus).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const entries = keys.map(key => ({
    key,
    haystack: `${key}\n${corpus[key]}`.toLowerCase(),
    bytes: byteLength(corpus[key]),
  }))
  p = { entries, keys, bytes: entries.reduce((n, e) => n + e.bytes, 0) }
  prepared.set(corpus, p)
  return p
}

export const SYSTEMS: Record<SystemName, System> = {
  tfidf: (query, corpus) => {
    const ranked = rankMemoriesDetailed(query, corpus, 10)
    return {
      keys: ranked.results.map(r => r.key),
      bytes: ranked.results.reduce((n, r) => n + byteLength(r.content), 0),
    }
  },

  substring: (query, corpus) => {
    const terms = [...contentTerms(query, identity)]
    if (terms.length === 0) return { keys: [], bytes: 0 }
    const scored: { key: string; score: number; bytes: number }[] = []
    for (const e of prepare(corpus).entries) {
      let n = 0
      for (const t of terms) if (e.haystack.includes(t)) n++
      if (n > 0) scored.push({ key: e.key, score: n, bytes: e.bytes })
    }
    // Entries are already in key order, so a stable sort on score alone
    // leaves ties in key order.
    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, 10)
    return { keys: top.map(s => s.key), bytes: top.reduce((n, s) => n + s.bytes, 0) }
  },

  full: (_query, corpus) => {
    const p = prepare(corpus)
    return { keys: p.keys, bytes: p.bytes }
  },
}

/** Run one system over every question, timing the whole pass. */
export function run(
  system: System,
  corpus: Corpus,
  questions: Question[],
): { outputs: SystemOutput[]; msPerQuery: number } {
  const started = performance.now()
  const outputs = questions.map(q => system(q.query, corpus))
  const elapsed = performance.now() - started
  return { outputs, msPerQuery: questions.length === 0 ? 0 : elapsed / questions.length }
}
