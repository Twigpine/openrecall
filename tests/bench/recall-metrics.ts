/**
 * Retrieval metrics for the recall quality harness.
 *
 * Every metric is computed over the output of one system on one question
 * set: the system returns an ordered list of entry keys (empty when it
 * declined to answer) and the plaintext bytes it handed the caller. A single
 * gold key per question keeps the definitions short:
 *
 * - Recall@k: fraction of answerable questions whose gold is among the first
 *   k keys.
 * - MRR: mean of 1/rank of the gold within the first ten keys, 0 when absent.
 * - nDCG@10: 1/log2(rank + 1) for the gold within the first ten, 0 when
 *   absent. With one gold the ideal DCG is 1, so no normalisation step.
 * - staleAboveGold: over `update` questions, the fraction where the
 *   superseded note sits above the gold in the first ten keys, counting a
 *   superseded note that is present while the gold is absent.
 * - abstention precision: of the questions the system returned nothing for,
 *   the fraction that were unanswerable. Null when it never abstained: a
 *   system that always answers has no precision to measure, and reporting 0
 *   or 1 would invent one.
 * - abstention recall: of the unanswerable questions, the fraction the
 *   system returned nothing for.
 * - false-answer rate: over all questions, the fraction where the system
 *   returned something whose first key is not the gold. This is the "wrong
 *   answer delivered confidently" rate, and an unanswerable question answered
 *   at all counts.
 * - bytes per query: mean plaintext bytes returned, the cost axis.
 *
 * Recall, MRR and nDCG exclude unanswerable questions (there is no rank to
 * find); the abstention metrics and the false-answer rate are what score the
 * unanswerable ones.
 */

import type { Question } from './recall-fixture.ts'

export type SystemOutput = { keys: string[]; bytes: number }

export type Metrics = {
  questions: number
  answerable: number
  recallAt1: number
  recallAt5: number
  recallAt10: number
  mrr: number
  ndcg10: number
  staleAboveGold: number | null
  abstentionPrecision: number | null
  abstentionRecall: number | null
  falseAnswerRate: number
  bytesPerQuery: number
}

/** The metrics a change is judged on, with the direction that counts as better. */
export const QUALITY_METRICS: {
  key: Exclude<keyof Metrics, 'questions' | 'answerable' | 'bytesPerQuery'>
  label: string
  better: 'higher' | 'lower'
}[] = [
  { key: 'recallAt1', label: 'R@1', better: 'higher' },
  { key: 'recallAt5', label: 'R@5', better: 'higher' },
  { key: 'recallAt10', label: 'R@10', better: 'higher' },
  { key: 'mrr', label: 'MRR', better: 'higher' },
  { key: 'ndcg10', label: 'nDCG@10', better: 'higher' },
  { key: 'staleAboveGold', label: 'stale', better: 'lower' },
  { key: 'abstentionPrecision', label: 'absP', better: 'higher' },
  { key: 'abstentionRecall', label: 'absR', better: 'higher' },
  { key: 'falseAnswerRate', label: 'false', better: 'lower' },
]

const DEPTH = 10

/** 1-based rank of `key` within the first DEPTH entries, or 0 when absent. */
function rankOf(keys: string[], key: string): number {
  const i = keys.slice(0, DEPTH).indexOf(key)
  return i < 0 ? 0 : i + 1
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

/**
 * Score `outputs[i]` as the answer to `questions[i]`. The two arrays must line
 * up; the caller produced one from the other.
 */
export function score(questions: Question[], outputs: SystemOutput[]): Metrics {
  if (questions.length !== outputs.length)
    throw new Error(`score: ${questions.length} questions but ${outputs.length} outputs`)
  let answerable = 0
  let hit1 = 0
  let hit5 = 0
  let hit10 = 0
  let rr = 0
  let dcg = 0
  let updates = 0
  let stale = 0
  let unanswerable = 0
  let abstained = 0
  let abstainedRight = 0
  let falseAnswers = 0
  let bytes = 0

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    const { keys } = outputs[i]
    bytes += outputs[i].bytes
    if (keys.length === 0) {
      abstained++
      if (q.gold === null) abstainedRight++
    } else if (keys[0] !== q.gold) {
      falseAnswers++
    }
    if (q.gold === null) {
      unanswerable++
      continue
    }
    answerable++
    const rank = rankOf(keys, q.gold)
    if (rank >= 1 && rank <= 1) hit1++
    if (rank >= 1 && rank <= 5) hit5++
    if (rank >= 1) hit10++
    if (rank >= 1) {
      rr += 1 / rank
      dcg += 1 / Math.log2(rank + 1)
    }
    if (q.kind === 'update' && q.superseded) {
      updates++
      const staleRank = rankOf(keys, q.superseded)
      if (staleRank >= 1 && (rank === 0 || staleRank < rank)) stale++
    }
  }

  return {
    questions: questions.length,
    answerable,
    recallAt1: answerable === 0 ? 0 : hit1 / answerable,
    recallAt5: answerable === 0 ? 0 : hit5 / answerable,
    recallAt10: answerable === 0 ? 0 : hit10 / answerable,
    mrr: answerable === 0 ? 0 : rr / answerable,
    ndcg10: answerable === 0 ? 0 : dcg / answerable,
    staleAboveGold: ratio(stale, updates),
    abstentionPrecision: ratio(abstainedRight, abstained),
    abstentionRecall: ratio(abstainedRight, unanswerable),
    falseAnswerRate: questions.length === 0 ? 0 : falseAnswers / questions.length,
    bytesPerQuery: questions.length === 0 ? 0 : bytes / questions.length,
  }
}

/** Four decimals, or `n/a` for a metric that had nothing to measure. */
export function fmt(v: number | null): string {
  return v === null ? 'n/a' : v.toFixed(4)
}

/**
 * The system x metric table the test prints into the CI log and the script
 * prints to the terminal, in one place so the two never drift apart.
 */
export function renderTable(
  rows: { name: string; metrics: Metrics; msPerQuery: number }[],
): string {
  const header = ['system', ...QUALITY_METRICS.map(m => m.label), 'bytes/q', 'ms/q']
  const lines = rows.map(r => [
    r.name,
    ...QUALITY_METRICS.map(m => fmt(r.metrics[m.key])),
    Math.round(r.metrics.bytesPerQuery).toString(),
    r.msPerQuery.toFixed(1),
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map(l => l[i].length)))
  const row = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ')
  return [row(header), ...lines.map(row)].join('\n')
}
