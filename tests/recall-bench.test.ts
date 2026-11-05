/**
 * Recall quality harness: the blocking half.
 *
 * `tests/recall-regression.test.ts` pins specific query/answer pairs and a
 * 12-pair held-out floor; it catches a regression on a pair it knows about
 * and cannot say whether the ranker got better or worse overall. This suite
 * scores the product ranker over a seeded 2,000-entry corpus and 205
 * questions (`tests/bench/recall-fixture.ts`) and holds every quality metric
 * within `minEffect` of the committed baseline in
 * `tests/bench/recall-baseline.json`, under the preregistered rule written in
 * `docs/performance.md`: a change may claim an improvement only when a metric
 * moves by at least `minEffect`, and may not move any metric the wrong way by
 * that much. The baseline is updated only by `bun run bench:recall
 * --update-baseline` in a reviewed diff.
 *
 * Everything here is deterministic. The fixture is generated from a seed by a
 * module that imports nothing (the provenance guard in
 * `tests/recall-regression.test.ts` covers it), the questions are compared to
 * the committed `recall-questions.jsonl`, and the corpus digest is compared to
 * the one stored in the baseline, so a number that moved is a ranker that
 * moved, not a fixture that drifted. The ranker is called as a pure function
 * (`tests/setup.ts` caps the test server at five entries, so nothing this
 * size can go through a client), and the 10,000-entry corpus is left to the
 * script: at ~130 ms per query it does not belong in a blocking test.
 *
 * Budget: the three systems over 205 questions run in about six seconds on an
 * M4 Pro, nearly all of it the ranker at ~26 ms per query. Scoring happens
 * once, at collection time, so the per-test timeout never applies to it; the
 * tests below read the results.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stemTerm } from '../src/mcp/relevance.ts'
import {
  FACT_COUNT,
  fixture,
  GENERATOR_VERSION,
  type Question,
  UNCOVERED_TERMS,
} from './bench/recall-fixture.ts'
import {
  fmt,
  type Metrics,
  QUALITY_METRICS,
  renderTable,
  type SystemOutput,
  score,
} from './bench/recall-metrics.ts'
import { corpusDigest, run, SYSTEM_NAMES, SYSTEMS } from './bench/recall-systems.ts'
import { contentTerms, sharedTerms } from './recall-corpus.ts'

const BENCH_DIR = join(import.meta.dir, 'bench')

type Baseline = {
  seed: number
  size: 2000 | 10000
  generatorVersion: string
  corpusDigest: string
  minEffect: number
  questions: number
  answerable: number
  systems: Record<string, Omit<Metrics, 'questions' | 'answerable'>>
}

const baseline = JSON.parse(
  readFileSync(join(BENCH_DIR, 'recall-baseline.json'), 'utf8'),
) as Baseline

const committedQuestions: Question[] = readFileSync(
  join(BENCH_DIR, 'recall-questions.jsonl'),
  'utf8',
)
  .split('\n')
  .filter(Boolean)
  .map(line => JSON.parse(line) as Question)

const { corpus, questions } = fixture(baseline.seed, 2000)
const rankedKeys = Object.keys(corpus).filter(k => k !== 'MEMORY.md')

describe('recall bench fixture', () => {
  test('the baseline was produced by this generator at this size', () => {
    expect(baseline.size).toBe(2000)
    expect(baseline.generatorVersion).toBe(GENERATOR_VERSION)
    expect(baseline.questions).toBe(questions.length)
  })

  test('the same seed generates the same corpus and questions twice', () => {
    const again = fixture(baseline.seed, 2000)
    expect(again.questions).toEqual(questions)
    expect(corpusDigest(again.corpus)).toBe(corpusDigest(corpus))
  })

  // The two drift guards. A fixture edit that changes a question fails the
  // first; one that changes only note text (a frame, a value list) fails the
  // second. Either way the fix is to regenerate both committed files with
  // `bun run bench:recall --write-questions --update-baseline` and bump
  // GENERATOR_VERSION, in the same diff, so the reviewer sees the numbers
  // move next to the reason they moved.
  test('the generated questions equal the committed recall-questions.jsonl', () => {
    expect(questions).toEqual(committedQuestions)
  })

  test('the generated corpus has the digest the baseline was measured against', () => {
    expect(corpusDigest(corpus)).toBe(baseline.corpusDigest)
  })

  test('has exactly 2,000 entries, the index among them, near the measured mean length', () => {
    expect(Object.keys(corpus).length).toBe(2000)
    expect(corpus['MEMORY.md']).toStartWith('# index\n')
    const mean = rankedKeys.reduce((n, k) => n + corpus[k].length, 0) / rankedKeys.length
    // The latency figures the budget rests on were measured at ~400 chars.
    expect(`${mean.toFixed(0)} chars`).toMatch(/^(3[0-9]{2}|4[0-9]{2}) chars$/)
    // About a tenth of the corpus is the long topic-vocabulary noise.
    const long = rankedKeys.filter(k => corpus[k].length >= 1000).length
    expect(long).toBeGreaterThanOrEqual(150)
    expect(long).toBeLessThanOrEqual(300)
  })

  test('every gold note exists, is a one-fact note, and the index lists it', () => {
    for (const q of questions) {
      if (q.gold === null) continue
      const body = corpus[q.gold]
      expect(body).toBeDefined()
      expect(body.length).toBeGreaterThanOrEqual(100)
      expect(body.length).toBeLessThanOrEqual(1600)
      expect(body).toMatch(
        /^---\nname: .+\ndescription: .+\ntype: (user|feedback|project|reference)\n---\n# /,
      )
      expect(corpus['MEMORY.md']).toContain(`](${q.gold})`)
    }
  })

  test('question kinds are in the designed proportions', () => {
    const count = (kind: Question['kind']) => questions.filter(q => q.kind === kind).length
    expect(questions.length).toBeGreaterThanOrEqual(150)
    expect(questions.length).toBeLessThanOrEqual(300)
    expect(count('lexical')).toBe(count('paraphrase'))
    expect(count('update')).toBeGreaterThanOrEqual(Math.floor(FACT_COUNT * 0.2))
    expect(count('update')).toBeLessThanOrEqual(Math.ceil(FACT_COUNT * 0.3))
    const unanswerable = count('unanswerable') / questions.length
    expect(unanswerable).toBeGreaterThanOrEqual(0.1)
    expect(unanswerable).toBeLessThanOrEqual(0.15)
    expect(new Set(questions.map(q => q.id)).size).toBe(questions.length)
  })

  // The classification is intended by the fixture and verified here with the
  // ranker's own stemmer, because the fixture module may import nothing. The
  // paraphrase floor is the same one the held-out set in
  // tests/recall-regression.test.ts lives under: at most one shared content
  // term with the gold (key plus body, frontmatter included), so a paraphrase
  // cannot be answered by restating the note.
  test('every lexical and update question shares at least two content terms with its gold', () => {
    const short: string[] = []
    for (const q of questions) {
      if (q.kind !== 'lexical' && q.kind !== 'update') continue
      const shared = sharedTerms(q.query, q.gold as string, corpus[q.gold as string], stemTerm)
      if (shared.length < 2) short.push(`${q.id} "${q.query}" shares only [${shared.join(',')}]`)
    }
    expect(short).toEqual([])
  })

  test('every paraphrase question shares at most one content term with its gold', () => {
    const over: string[] = []
    for (const q of questions) {
      if (q.kind !== 'paraphrase') continue
      const shared = sharedTerms(q.query, q.gold as string, corpus[q.gold as string], stemTerm)
      if (shared.length > 1) over.push(`${q.id} "${q.query}" shares [${shared.join(',')}]`)
    }
    expect(over).toEqual([])
  })

  test('every update question names a superseded note that exists, differs, and shares the topic', () => {
    for (const q of questions) {
      if (q.kind !== 'update') continue
      expect(q.superseded).toBeDefined()
      expect(q.superseded).not.toBe(q.gold)
      expect(corpus[q.superseded as string]).toBeDefined()
      expect(corpus[q.superseded as string]).toContain('Dated ')
      expect(corpus[q.gold as string]).toContain('replaces the earlier note')
      const shared = sharedTerms(
        q.query,
        q.superseded as string,
        corpus[q.superseded as string],
        stemTerm,
      )
      expect(shared.length).toBeGreaterThanOrEqual(2)
    }
    expect(questions.some(q => q.kind !== 'update' && q.superseded !== undefined)).toBe(false)
  })

  // Unanswerable in the only sense a lexical harness can verify: each names a
  // term no note carries. The rest of its words are ordinary corpus words, so
  // a ranker that answers it did so on real matches, not on a typo.
  test('every unanswerable question names a term that appears in no note', () => {
    const corpusTerms = new Set<string>()
    for (const k of rankedKeys)
      for (const t of contentTerms(`${k} ${corpus[k]}`, stemTerm)) corpusTerms.add(t)
    const leaked = UNCOVERED_TERMS.filter(u => corpusTerms.has(stemTerm(u)))
    expect(leaked).toEqual([])
    const uncovered = new Set(UNCOVERED_TERMS.map(stemTerm))
    for (const q of questions) {
      if (q.kind !== 'unanswerable') continue
      expect(q.gold).toBeNull()
      const terms = [...contentTerms(q.query, stemTerm)]
      expect(`${q.query} :: ${terms.some(t => uncovered.has(t))}`).toBe(`${q.query} :: true`)
      // And enough in-vocabulary words that the floor cannot drop it for free.
      expect(terms.filter(t => corpusTerms.has(t)).length).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('recall bench metrics', () => {
  const q = (
    id: string,
    gold: string | null,
    kind: Question['kind'],
    superseded?: string,
  ): Question =>
    superseded ? { id, query: id, gold, kind, superseded } : { id, query: id, gold, kind }
  const out = (keys: string[], bytes = keys.length * 100): SystemOutput => ({ keys, bytes })

  test('recall, MRR and nDCG follow the rank of the single gold within ten', () => {
    const m = score(
      [
        q('a', 'g', 'lexical'),
        q('b', 'g', 'lexical'),
        q('c', 'g', 'lexical'),
        q('d', 'g', 'lexical'),
      ],
      [
        out(['g', 'x']),
        out(['x', 'y', 'g']),
        out(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'g']),
        out([]),
      ],
    )
    expect(m.answerable).toBe(4)
    expect(m.recallAt1).toBe(1 / 4)
    expect(m.recallAt5).toBe(2 / 4)
    expect(m.recallAt10).toBe(2 / 4)
    expect(m.mrr).toBeCloseTo((1 + 1 / 3) / 4, 10)
    expect(m.ndcg10).toBeCloseTo((1 + 1 / Math.log2(4)) / 4, 10)
    expect(m.bytesPerQuery).toBe((200 + 300 + 1100 + 0) / 4)
  })

  test('staleAboveGold counts a superseded note above the gold, or present while the gold is absent', () => {
    const qs = [
      q('above', 'new', 'update', 'old'),
      q('below', 'new', 'update', 'old'),
      q('gold-absent', 'new', 'update', 'old'),
      q('both-absent', 'new', 'update', 'old'),
      q('not-update', 'new', 'lexical'),
    ]
    const m = score(qs, [
      out(['old', 'new']),
      out(['new', 'old']),
      out(['x', 'old']),
      out(['x']),
      out(['old', 'new']),
    ])
    expect(m.staleAboveGold).toBe(2 / 4)
    expect(score([q('n', 'g', 'lexical')], [out(['g'])]).staleAboveGold).toBeNull()
  })

  test('abstention precision is null until the system abstains once, and recall is over the unanswerable', () => {
    const qs = [
      q('u1', null, 'unanswerable'),
      q('u2', null, 'unanswerable'),
      q('a1', 'g', 'lexical'),
    ]
    const never = score(qs, [out(['x']), out(['y']), out(['g'])])
    expect(never.abstentionPrecision).toBeNull()
    expect(never.abstentionRecall).toBe(0)
    expect(never.falseAnswerRate).toBe(2 / 3)
    const sometimes = score(qs, [out([]), out(['y']), out([])])
    expect(sometimes.abstentionPrecision).toBe(1 / 2)
    expect(sometimes.abstentionRecall).toBe(1 / 2)
    expect(sometimes.falseAnswerRate).toBe(1 / 3)
    expect(sometimes.recallAt10).toBe(0)
  })

  test('refuses outputs that do not line up with the questions', () => {
    expect(() => score([q('a', 'g', 'lexical')], [])).toThrow(/1 questions but 0 outputs/)
  })
})

describe('recall bench (2,000 entries, committed baseline)', () => {
  const rows = SYSTEM_NAMES.map(name => {
    const { outputs, msPerQuery } = run(SYSTEMS[name], corpus, questions)
    return { name, metrics: score(questions, outputs), msPerQuery }
  })
  const byName = Object.fromEntries(rows.map(r => [r.name, r.metrics])) as Record<string, Metrics>

  // Printed so the numbers appear in the CI log next to `[held-out]`, where a
  // reviewer of a ranker change can read them without running anything.
  test('prints the system x metric table', () => {
    console.log(
      `[recall-bench] seed=${baseline.seed} size=2000 generator=${GENERATOR_VERSION} questions=${questions.length} minEffect=${baseline.minEffect}\n${renderTable(rows)}`,
    )
    expect(rows.map(r => r.name)).toEqual([...SYSTEM_NAMES])
  })

  // The preregistered rule, mechanically: no quality metric of the product
  // ranker may move the wrong way by minEffect or more against the committed
  // baseline. A metric the baseline could not measure (null: the ranker never
  // abstained, so abstention precision is undefined) is not a number to
  // regress from, and the abstention recall and false-answer rate beside it
  // already score the behaviour.
  test('tfidf holds every quality metric within minEffect of the committed baseline', () => {
    const base = baseline.systems.tfidf
    const now = byName.tfidf
    const regressions: string[] = []
    for (const m of QUALITY_METRICS) {
      const was = base[m.key]
      const is = now[m.key]
      if (was === null || is === null) continue
      const bad =
        m.better === 'higher' ? is < was - baseline.minEffect : is > was + baseline.minEffect
      if (bad)
        regressions.push(`${m.label} ${fmt(is)} vs baseline ${fmt(was)} (${m.better} is better)`)
    }
    expect(regressions).toEqual([])
  })

  // Non-vacuity for the rule above: a baseline of zeros would hold anything.
  test('the committed baseline records a ranker that answers something', () => {
    expect(baseline.systems.tfidf.recallAt10).toBeGreaterThan(0.3)
    expect(baseline.systems.tfidf.mrr).toBeGreaterThan(0.2)
  })

  // The ranker must beat grep, or it is a slower grep. Substring sees the
  // index and ties by key, which is what memory_search would give a caller.
  test('the ranker beats the substring baseline on MRR', () => {
    const summary = `tfidf ${fmt(byName.tfidf.mrr)} vs substring ${fmt(byName.substring.mrr)}`
    expect(`${byName.tfidf.mrr >= byName.substring.mrr} :: ${summary}`).toBe(`true :: ${summary}`)
  })

  test('the full-corpus baseline costs every byte and the ranker a fraction of them', () => {
    const total = rankedKeys.reduce((n, k) => n + corpus[k].length, 0) + corpus['MEMORY.md'].length
    expect(byName.full.bytesPerQuery).toBe(total)
    expect(byName.tfidf.bytesPerQuery).toBeLessThan(total / 20)
  })
})
