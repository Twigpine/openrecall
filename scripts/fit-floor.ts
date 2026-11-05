/**
 * Where every probe lands under the ranker, so the relevance floor in
 * `src/mcp/relevance.ts` can be chosen honestly. Development only; nothing
 * ships from here.
 *
 *   bun run scripts/fit-floor.ts            one table per probe set
 *   bun run scripts/fit-floor.ts --grid     plus a sweep over floor constants
 *
 * Per probe it prints the top hit's `norm`, the lead over the runner-up
 * (`(top - second) / top`), the rank of the expected key, and whether the
 * current FLOORS answer it. The constants are chosen on TUNING (must answer,
 * expected key first) and OFF_DOMAIN (must not answer) ONLY. HELD_OUT is
 * printed last and separately, and is never used to pick a constant: it is
 * the number `tests/recall-regression.test.ts` ratchets, and a floor tuned to
 * it would measure nothing.
 *
 * `--grid` also scores the 2,000-entry harness once and re-applies each
 * candidate floor to the scored lists, so the abstention trade-off (R@1, MRR
 * against abstention recall and the false-answer rate) is visible next to the
 * tuning and off-domain counts. Those numbers inform the choice; the rule in
 * `docs/performance.md` still governs what the baseline may become.
 */

import { applyFloors, FLOORS, type Floors, RecallIndex } from '../src/mcp/relevance.ts'
import { fixture } from '../tests/bench/recall-fixture.ts'
import { fmt, score } from '../tests/bench/recall-metrics.ts'
import { CORPUS, HELD_OUT, OFF_DOMAIN, TUNING } from '../tests/recall-corpus.ts'

const grid = process.argv.includes('--grid')

const index = new RecallIndex()
for (const [key, content] of Object.entries(CORPUS))
  index.upsert({ id: key, key, content, fingerprint: '' })

type Probe = { query: string; expect: string | null; residual?: boolean }

function measure(query: string, expect: string | null, floors: Floors) {
  const { scored } = RecallIndex.scoreAll([index], query)
  const top = scored[0]
  const second = scored[1]
  const topScore = top?.score ?? 0
  const gap = topScore > 0 ? (topScore - (second?.score ?? 0)) / topScore : 0
  const rank = expect === null ? 0 : scored.findIndex(r => r.key === expect && r.score > 0) + 1
  const kept = applyFloors(scored, floors)
  return {
    norm: topScore > 0 ? (top?.norm ?? 0) : 0,
    gap,
    rank,
    topKey: topScore > 0 ? top?.key : undefined,
    answered: kept.length > 0,
    first: kept[0]?.key,
    members: kept.length,
  }
}

function table(title: string, probes: Probe[], floors: Floors) {
  console.log(`\n${title}`)
  console.log(
    `${'query'.padEnd(58)} ${'norm'.padStart(6)} ${'gap'.padStart(5)} ${'rank'.padStart(4)}  ${'verdict'.padEnd(9)} top`,
  )
  let right = 0
  for (const p of probes) {
    const m = measure(p.query, p.expect, floors)
    const ok = p.expect === null ? !m.answered : m.answered && m.first === p.expect
    if (ok) right++
    const verdict = m.answered ? `answer:${m.members}` : 'empty'
    console.log(
      `${(p.residual ? `~ ${p.query}` : p.query).slice(0, 58).padEnd(58)} ${m.norm.toFixed(3).padStart(6)} ${m.gap.toFixed(2).padStart(5)} ${String(m.rank || '-').padStart(4)}  ${verdict.padEnd(9)} ${m.topKey ?? '(nothing scored)'}${ok ? '' : '   <-- wrong'}`,
    )
  }
  console.log(`${right}/${probes.length} as expected`)
  return right
}

const tuning: Probe[] = TUNING.map(t => ({
  query: t.query,
  expect: t.expect,
  residual: t.residual,
}))
const offDomain: Probe[] = OFF_DOMAIN.map(q => ({ query: q, expect: null }))
const heldOut: Probe[] = HELD_OUT.map(h => ({ query: h.query, expect: h.expect }))

console.log(`FLOORS ${JSON.stringify(FLOORS)}`)
table('TUNING (fit set; ~ marks an accepted residual, reported only)', tuning, FLOORS)
table('OFF_DOMAIN (fit set; every row should be empty)', offDomain, FLOORS)
table('HELD_OUT (NEVER fitted on; reported and ratcheted only)', heldOut, FLOORS)

if (grid) {
  // Score the harness once; floors are applied to the stored lists per
  // candidate, so a 200-point grid costs one scoring pass.
  const { corpus, questions } = fixture(1, 2000)
  const bench = new RecallIndex()
  for (const [key, content] of Object.entries(corpus))
    bench.upsert({ id: key, key, content, fingerprint: '' })
  const lists = questions.map(q => RecallIndex.scoreAll([bench], q.query).scored)
  const byteLength = (s: string) => new TextEncoder().encode(s).byteLength

  const fitProbes = [...tuning.filter(p => !p.residual), ...offDomain]
  const rows: string[] = []
  rows.push(
    `${'TOP'.padStart(5)} ${'GAP'.padStart(5)} ${'CLEAR'.padStart(6)} | ${'fit'.padStart(5)} ${'held'.padStart(5)} | ${'R@1'.padStart(7)} ${'R@5'.padStart(7)} ${'R@10'.padStart(7)} ${'MRR'.padStart(7)} ${'absR'.padStart(7)} ${'absP'.padStart(7)} ${'false'.padStart(7)}`,
  )
  for (const TOP_FLOOR of [0.06, 0.08, 0.1, 0.12, 0.15, 0.2])
    for (const GAP of [0.2, 0.3, 0.4, 0.6, 1.01])
      for (const CLEAR_FLOOR of [0, 0.01, 0.02, 0.04, 0.08]) {
        if (CLEAR_FLOOR >= TOP_FLOOR) continue
        const floors: Floors = { ...FLOORS, TOP_FLOOR, GAP, CLEAR_FLOOR }
        const fit = fitProbes.filter(p => {
          const m = measure(p.query, p.expect, floors)
          return p.expect === null ? !m.answered : m.answered && m.first === p.expect
        }).length
        const held = heldOut.filter(p => {
          const m = measure(p.query, p.expect, floors)
          return m.answered && m.first === p.expect
        }).length
        const outputs = lists.map(scored => {
          const kept = applyFloors(scored, floors).slice(0, 10)
          return {
            keys: kept.map(r => r.key),
            bytes: kept.reduce((n, r) => n + byteLength(r.content), 0),
          }
        })
        const m = score(questions, outputs)
        rows.push(
          `${TOP_FLOOR.toFixed(2).padStart(5)} ${GAP.toFixed(2).padStart(5)} ${CLEAR_FLOOR.toFixed(2).padStart(6)} | ${`${fit}/${fitProbes.length}`.padStart(5)} ${`${held}/${heldOut.length}`.padStart(5)} | ${fmt(m.recallAt1).padStart(7)} ${fmt(m.recallAt5).padStart(7)} ${fmt(m.recallAt10).padStart(7)} ${fmt(m.mrr).padStart(7)} ${fmt(m.abstentionRecall).padStart(7)} ${fmt(m.abstentionPrecision).padStart(7)} ${fmt(m.falseAnswerRate).padStart(7)}`,
        )
      }
  console.log('\nGRID over TOP_FLOOR x GAP x CLEAR_FLOOR (MEMBER_FLOOR and REL_FLOOR as in FLOORS)')
  console.log(
    'fit = tuning pairs answered right + off-domain probes empty; held = held-out top-1 (report only)',
  )
  console.log(rows.join('\n'))
}
