/**
 * Recall quality benchmark: the three systems in `tests/bench/recall-systems.ts`
 * over the seeded fixture in `tests/bench/recall-fixture.ts`, scored by
 * `tests/bench/recall-metrics.ts`.
 *
 *   bun run bench:recall [--size 2000|10000] [--seed N]
 *                        [--update-baseline] [--write-questions]
 *
 * Prints the system x metric table plus ms/query and bytes/query, and, when
 * the run matches the committed baseline's seed, size and generator, the
 * delta of every `tfidf` metric against it under the preregistered rule in
 * `docs/performance.md`: a metric has moved only when it moved by at least
 * `minEffect`, in either direction.
 *
 * `--update-baseline` rewrites `tests/bench/recall-baseline.json` from this
 * run (2,000 entries only: that is the size the blocking test runs at) and
 * `--write-questions` rewrites `tests/bench/recall-questions.jsonl`. Both are
 * meant to land in a reviewed diff next to the change that justifies them;
 * the test refuses a baseline whose generator version or corpus digest does
 * not match what it generated.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type FixtureSize, fixture, GENERATOR_VERSION } from '../tests/bench/recall-fixture.ts'
import {
  fmt,
  type Metrics,
  QUALITY_METRICS,
  renderTable,
  score,
} from '../tests/bench/recall-metrics.ts'
import { corpusDigest, run, SYSTEM_NAMES, SYSTEMS } from '../tests/bench/recall-systems.ts'

const BENCH_DIR = join(import.meta.dir, '..', 'tests', 'bench')
const BASELINE_PATH = join(BENCH_DIR, 'recall-baseline.json')
const QUESTIONS_PATH = join(BENCH_DIR, 'recall-questions.jsonl')
const MIN_EFFECT = 0.02

type Baseline = {
  seed: number
  size: FixtureSize
  generatorVersion: string
  corpusDigest: string
  minEffect: number
  questions: number
  answerable: number
  systems: Record<string, Omit<Metrics, 'questions' | 'answerable'>>
}

function usage(message?: string): never {
  if (message) console.error(message)
  console.error(
    'usage: bun run bench:recall [--size 2000|10000] [--seed N] [--update-baseline] [--write-questions]',
  )
  process.exit(2)
}

function readBaseline(): Baseline | null {
  if (!existsSync(BASELINE_PATH)) return null
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline
}

// ---- arguments -------------------------------------------------------------

const existing = readBaseline()
let size: FixtureSize = 2000
let seed = existing?.seed ?? 1
let updateBaseline = false
let writeQuestions = false

const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const [flag, inline] = argv[i].split('=', 2)
  const value = () => {
    const v = inline ?? argv[++i]
    if (v === undefined) usage(`${flag} needs a value`)
    return v
  }
  switch (flag) {
    case '--size': {
      const n = Number(value())
      if (n !== 2000 && n !== 10000) usage('--size must be 2000 or 10000')
      size = n
      break
    }
    case '--seed': {
      const n = Number(value())
      if (!Number.isInteger(n) || n < 0) usage('--seed must be a non-negative integer')
      seed = n
      break
    }
    case '--update-baseline':
      updateBaseline = true
      break
    case '--write-questions':
      writeQuestions = true
      break
    case '--help':
    case '-h':
      usage()
      break
    default:
      usage(`unknown argument ${argv[i]}`)
  }
}
if (updateBaseline && size !== 2000)
  usage('--update-baseline only at --size 2000, the size the blocking test runs at')

// ---- run -------------------------------------------------------------------

const started = performance.now()
const { corpus, questions } = fixture(seed, size)
const generated = performance.now() - started
const keys = Object.keys(corpus)
const ranked = keys.filter(k => k !== 'MEMORY.md')
const mean = ranked.reduce((n, k) => n + corpus[k].length, 0) / ranked.length
const kinds = new Map<string, number>()
for (const q of questions) kinds.set(q.kind, (kinds.get(q.kind) ?? 0) + 1)
const digest = corpusDigest(corpus)

console.log(
  `[recall-bench] seed=${seed} size=${size} generator=${GENERATOR_VERSION} ` +
    `entries=${keys.length} mean=${mean.toFixed(0)} chars digest=${digest.slice(0, 12)} ` +
    `(generated in ${generated.toFixed(0)} ms)`,
)
console.log(
  `[recall-bench] questions=${questions.length} (${[...kinds]
    .map(([k, n]) => `${k} ${n}`)
    .join(', ')})`,
)

const rows = SYSTEM_NAMES.map(name => {
  const { outputs, msPerQuery } = run(SYSTEMS[name], corpus, questions)
  return { name, metrics: score(questions, outputs), msPerQuery }
})
console.log(renderTable(rows))

// ---- compare -----------------------------------------------------------------

const tfidf = rows[0].metrics
if (
  existing &&
  existing.seed === seed &&
  existing.size === size &&
  existing.generatorVersion === GENERATOR_VERSION &&
  existing.corpusDigest === digest
) {
  const base = existing.systems.tfidf
  const lines: string[] = []
  for (const m of QUALITY_METRICS) {
    const now = tfidf[m.key]
    const was = base[m.key]
    if (now === null || was === null) {
      lines.push(`  ${m.label.padEnd(8)} ${fmt(was)} -> ${fmt(now)}`)
      continue
    }
    const delta = now - was
    const moved = Math.abs(delta) >= existing.minEffect
    const better = m.better === 'higher' ? delta > 0 : delta < 0
    const verdict = !moved ? 'unchanged' : better ? 'IMPROVED' : 'REGRESSED'
    lines.push(
      `  ${m.label.padEnd(8)} ${fmt(was)} -> ${fmt(now)}  ${delta >= 0 ? '+' : ''}${delta.toFixed(4)}  ${verdict}`,
    )
  }
  console.log(`[recall-bench] tfidf vs committed baseline (minEffect ${existing.minEffect}):`)
  console.log(lines.join('\n'))
} else if (existing) {
  console.log(
    '[recall-bench] no comparison: this run differs from the committed baseline in seed, size, generator or corpus',
  )
}

// ---- write -------------------------------------------------------------------

if (writeQuestions) {
  writeFileSync(QUESTIONS_PATH, `${questions.map(q => JSON.stringify(q)).join('\n')}\n`)
  console.log(`[recall-bench] wrote ${questions.length} questions to ${QUESTIONS_PATH}`)
}

if (updateBaseline) {
  const round = (v: number | null) => (v === null ? null : Number(v.toFixed(4)))
  const systems: Baseline['systems'] = {}
  for (const r of rows) {
    const { questions: _q, answerable: _a, ...rest } = r.metrics
    systems[r.name] = {
      recallAt1: round(rest.recallAt1) as number,
      recallAt5: round(rest.recallAt5) as number,
      recallAt10: round(rest.recallAt10) as number,
      mrr: round(rest.mrr) as number,
      ndcg10: round(rest.ndcg10) as number,
      staleAboveGold: round(rest.staleAboveGold),
      abstentionPrecision: round(rest.abstentionPrecision),
      abstentionRecall: round(rest.abstentionRecall),
      falseAnswerRate: round(rest.falseAnswerRate) as number,
      bytesPerQuery: Math.round(rest.bytesPerQuery),
    }
  }
  const baseline: Baseline = {
    seed,
    size,
    generatorVersion: GENERATOR_VERSION,
    corpusDigest: digest,
    minEffect: existing?.minEffect ?? MIN_EFFECT,
    questions: questions.length,
    answerable: tfidf.answerable,
    systems,
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`)
  console.log(`[recall-bench] wrote baseline to ${BASELINE_PATH}`)
}
