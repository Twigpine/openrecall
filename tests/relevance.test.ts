/**
 * Relevance ranker. Asserts ordering and the description/key weighting, plus
 * the empty-query and no-overlap guards.
 */

import { describe, expect, test } from 'bun:test'
import { stampForSave } from '../src/mcp/frontmatter.ts'
import {
  FLOORS,
  isInactive,
  noteMeta,
  RECENCY_BAND,
  RecallIndex,
  rankEntriesDetailed,
  rankMemories,
  rankMemoriesDetailed,
  stemTerm,
  tokenize,
  tokenizeAll,
} from '../src/mcp/relevance.ts'
import {
  BASELINE_RANK_MS,
  CORPUS,
  DAMAGE_VOCAB,
  DAMAGE_WORDS,
  HELD_OUT,
  nearCapCorpus,
  OFF_DOMAIN,
  TUNING,
} from './recall-corpus.ts'

const entries = {
  'MEMORY.md': '# index\n- [prefs](prefs.md)\n- [deploy](deploy.md)',
  'prefs.md':
    '---\nname: prefs\ndescription: how the user likes answers formatted\n---\nThe user prefers terse, direct answers and dislikes preamble.',
  'deploy.md':
    '---\nname: deploy\ndescription: where and how the project ships\n---\nDeploys to Fly in region sin via Docker. Single machine for the beta.',
  'stack.md':
    '---\nname: stack\ndescription: runtime and language choices\n---\nBun + TypeScript, zero-dependency crypto using node:crypto.',
}

describe('rankMemories', () => {
  test('ranks the on-topic entry first', () => {
    const r = rankMemories('how should I format my answers for this user', entries)
    expect(r[0].key).toBe('prefs.md')
  })

  test('a deployment query surfaces the deploy note', () => {
    const r = rankMemories('what region do we deploy to', entries)
    expect(r[0].key).toBe('deploy.md')
  })

  test('description matches outweigh incidental body matches', () => {
    // "runtime" appears in stack.md's description; should win over a stray hit.
    const r = rankMemories('runtime choices', entries)
    expect(r[0].key).toBe('stack.md')
  })

  test('empty / stopword-only queries return nothing', () => {
    expect(rankMemories('', entries)).toHaveLength(0)
    expect(rankMemories('the a of to', entries)).toHaveLength(0)
  })

  test('respects the limit', () => {
    expect(rankMemories('user project answers deploy', entries, 2).length).toBeLessThanOrEqual(2)
  })

  // The point of stemming: the query and the note say the same thing in
  // different grammatical shapes, and the ranker has to see through that.
  test('a query in a different word form still finds its note', () => {
    expect(rankMemories('deployment plans', entries)[0]?.key).toBe('deploy.md')
  })
})

/**
 * Where a term sits, holding everything else equal. The older assertion here
 * ("runtime choices" ranks stack.md first) passed with the description and key
 * weights deleted outright, because stack.md carries the terms in its body too
 * and wins on that alone. These two pin the weights themselves: each pair
 * differs ONLY in which field carries the query term, and the entry that
 * carries it in the weighted field is deliberately the one that LOSES the
 * alphabetical tie-break, so removing the weight does not merely equalize the
 * scores, it inverts the order.
 */
describe('field weighting', () => {
  const filler = (o: Record<string, string>) => {
    for (let i = 0; i < 2; i++) o[`filler-${i}.md`] = 'Unrelated notes about the weather.'
    return o
  }
  const note = (description: string, body: string) =>
    ['---', 'name: n', `description: ${description}`, '---', body].join('\n')

  // Same description text apart from the term, same body text apart from the
  // term. `zulu.md` sorts last, so a tie hands rank 1 to `alpha.md`.
  const byField = filler({
    'zulu.md': note('kestrel identification notes', 'A sentence about the moor at dusk.'),
    'alpha.md': note('assorted identification notes', 'A sentence about the kestrel at dusk.'),
  })

  test('a term in the description outranks the same term in the body', () => {
    const r = rankMemories('kestrel', byField, 10)
    expect(r.map(x => x.key)).toEqual(['zulu.md', 'alpha.md'])
    expect(r[0].score).toBeGreaterThan(r[1].score)
  })

  // Same again for the key. `zulu/kestrel.md` carries the term in its key and
  // nowhere else; `alpha.md` carries it in its body and nowhere else.
  const byKey = filler({
    'zulu/kestrel.md': note('assorted identification notes', 'A sentence about the moor at dusk.'),
    'alpha.md': note('assorted identification notes', 'A sentence about the kestrel at dusk.'),
  })

  test('a term in the entry key outranks the same term in the body', () => {
    const r = rankMemories('kestrel', byKey, 10)
    expect(r.map(x => x.key)).toEqual(['zulu/kestrel.md', 'alpha.md'])
    expect(r[0].score).toBeGreaterThan(r[1].score)
  })
})

describe('rarity weighting', () => {
  // Seven entries talk about the queue; one mentions a kestrel and nothing
  // else. Both candidates cover exactly one of the two query terms, so
  // coverage cannot be what separates them: under the pre-U3 ranker the entry
  // saying "queue" three times won at 1.049 against the kestrel entry's 0.500,
  // because three occurrences of a word every entry uses outweighed one
  // occurrence of a word nobody else uses. Document frequency inverts that,
  // and the ordering is where it is observable.
  const flock: Record<string, string> = {}
  for (let i = 0; i < 8; i++) flock[`note-${i}.md`] = 'The queue drains in order.'
  flock['note-0.md'] = 'The queue feeds the queue that feeds the queue.'
  flock['note-3.md'] = 'A kestrel was watched at dusk.'

  test('a term in every entry counts for less than a term in one', () => {
    const r = rankMemories('queue kestrel', flock, 8)
    expect(r[0]?.key).toBe('note-3.md')
    // And the repetition still counts for something among equals: the entry
    // saying "queue" three times outranks the ones saying it once.
    const rest = r.filter(x => x.key !== 'note-3.md')
    expect(rest[0]?.key).toBe('note-0.md')
  })
})

describe('soft coverage', () => {
  // Coverage degrades a score instead of eliminating an entry. `narrow.md`
  // carries its single query term in the key, the description and the body,
  // which is twice the raw match strength of any one of `wide.md`'s three
  // hits; covering three of four terms is what puts wide ahead anyway. Both
  // stay in the result: partial coverage is a penalty, not a rejection.
  const birds: Record<string, string> = {
    'birds/wide.md': [
      '---',
      'name: wide',
      'description: a survey of the moor',
      '---',
      'A kestrel, a merlin and an osprey were counted at dusk.',
    ].join('\n'),
    'birds/falcon.md': [
      '---',
      'name: falcon',
      'description: falcon identification notes',
      '---',
      'The falcon is told apart by its wingbeat.',
    ].join('\n'),
  }
  for (let i = 0; i < 6; i++) birds[`filler-${i}.md`] = 'Unrelated notes about the weather.'

  test('covering more of the query outranks a stronger match on less of it', () => {
    const r = rankMemories('kestrel merlin osprey falcon', birds, 10)
    expect(r.map(x => x.key)).toEqual(['birds/wide.md', 'birds/falcon.md'])
  })
})

describe('the relevance floor', () => {
  // The must-not case, and the reason the floor and soft coverage are one
  // change rather than two. A cooking question shares exactly one incidental
  // token with the corpus ("red", from "a red run stops it", plus a couple of
  // one-token flukes), so a ranker without a floor answers it with three
  // print-routing notes. Removing the zero-coverage drop without a floor
  // makes that worse, not better: nearly every entry would come back. An
  // empty ranking is the only correct answer, and only a floor on the top hit
  // can produce it, because a cut measured against the top score can never
  // trim the top hit.
  const IRRELEVANT = 'how long should I braise short ribs in red wine'

  test('a query relevant to nothing clears no entry and returns an empty ranking', () => {
    const ranked = rankMemories(IRRELEVANT, CORPUS, Object.keys(CORPUS).length)
    // Assert on the keys, so a failure names what leaked through.
    expect(ranked.map(r => r.key)).toEqual([])
  })

  // The fitted constants, pinned as literals deliberately: the fit in
  // src/mcp/relevance.ts and scripts/fit-floor.ts produced exactly these, so
  // a silent change to any of them surfaces here and has to come with a refit.
  test('the floor constants are the fitted ones', () => {
    expect(FLOORS).toEqual({
      TOP_FLOOR: 0.1,
      GAP: 0.3,
      CLEAR_FLOOR: 0.01,
      MEMBER_FLOOR: 0.02,
      REL_FLOOR: 0.1,
    })
  })

  // The member floors gate every member, not only the top hit. The weakest
  // must-pass pair is the one to check them on: its top hit is answered
  // through the clear route (norm 0.074, a lead of 0.87 over the runner-up),
  // so the bar for its members sits as low as it ever does and a tail of
  // one-token flukes is most likely to get in.
  const WEAK_TOP = 'am I allowed to open a pull request'

  test('a returned member below the member floors never reaches the caller', () => {
    const ranked = rankMemories(WEAK_TOP, CORPUS, Object.keys(CORPUS).length)
    // Non-vacuous: the query does have an answer, so this is not the empty case.
    expect(ranked[0]?.key).toBe('feedback/outward-actions.md')
    const top = ranked[0].score
    // Names the offenders on failure rather than asserting a count.
    const offenders = ranked
      .slice(1)
      .filter(r => (r.norm ?? 0) < FLOORS.MEMBER_FLOOR || r.score < top * FLOORS.REL_FLOOR)
      .map(r => `${r.key}:norm=${(r.norm ?? 0).toFixed(4)}:rel=${(r.score / top).toFixed(4)}`)
    expect(offenders).toEqual([])
  })

  // The top hit is admitted by one of two routes and nothing else: a norm at
  // or above TOP_FLOOR, or a clear lead with a norm at or above CLEAR_FLOOR.
  // Every entry returned for any tuning or held-out query must satisfy that,
  // and every probe answered must have a top hit that does.
  test('every answered query has a top hit that clears one of the two routes', () => {
    const index = new RecallIndex()
    for (const [key, content] of Object.entries(CORPUS))
      index.upsert({ id: key, key, content, fingerprint: '' })
    const queries = [...TUNING.map(t => t.query), ...HELD_OUT.map(h => h.query), ...OFF_DOMAIN]
    let answered = 0
    for (const q of queries) {
      const ranked = RecallIndex.rank([index], q, Object.keys(CORPUS).length).results
      // The lead is measured over the unfloored scoring, since the runner-up
      // may itself have been cut by the member floors.
      const { scored } = RecallIndex.scoreAll([index], q)
      const top = scored[0]
      const norm = top?.norm ?? 0
      const gap = top && top.score > 0 ? (top.score - (scored[1]?.score ?? 0)) / top.score : 0
      const admitted = norm >= FLOORS.TOP_FLOOR || (gap >= FLOORS.GAP && norm >= FLOORS.CLEAR_FLOOR)
      expect(
        `${q} :: norm=${norm.toFixed(3)} gap=${gap.toFixed(2)} answered=${ranked.length > 0}`,
      ).toBe(`${q} :: norm=${norm.toFixed(3)} gap=${gap.toFixed(2)} answered=${admitted}`)
      if (ranked.length > 0) answered++
    }
    // Non-vacuous in both directions: some are answered and some are not.
    expect(answered).toBeGreaterThanOrEqual(8)
    expect(answered).toBeLessThan(queries.length)
  })

  // The off-domain probes are the other half of the fit: at most two of the
  // twelve may be answered, and the two that are ("which river runs through
  // Budapest" on `runs` in the CI description, "what tuning does a cello use"
  // on `use` in the tone note) are answered through the clear route, as the
  // sole entry carrying one query word. That is the shape the clear route
  // exists to admit for paraphrases, and the floor cannot tell these apart
  // from them; the number is stated rather than hidden.
  test('at most two off-domain probes are answered, each by a sole carrier', () => {
    const answered = OFF_DOMAIN.filter(q => rankMemories(q, CORPUS).length > 0)
    expect(answered.length).toBeLessThanOrEqual(2)
    for (const q of answered) {
      const d = rankMemoriesDetailed(q, CORPUS, Object.keys(CORPUS).length)
      expect(`${q} :: ${d.results.length} returned`).toBe(`${q} :: 1 returned`)
    }
  })

  test('a relevant query still returns its answer and withholds the long tail', () => {
    const ranked = rankMemories('namespace validation rules', CORPUS, Object.keys(CORPUS).length)
    expect(ranked[0]?.key).toBe('reference/namespaces.md')
    // The floor is only doing work if it trims: without it this query scores
    // most of the corpus above zero.
    expect(ranked.length).toBeLessThan(Object.keys(CORPUS).length / 2)
  })
})

describe('rankMemoriesDetailed', () => {
  // The counts exist for the no-match message U7 builds, and an unread count is
  // an unchecked one, so they are pinned here rather than at their consumer.
  //
  // Two fewer than the corpus: the namespace-root `MEMORY.md` never enters
  // ranking input, so it is not among the entries searched either (reporting
  // it as searched would be the same defect as ranking it, one layer along),
  // and `project/postgres-old.md` is stamped superseded, so it is counted as
  // left out rather than as searched.
  const all = Object.keys(CORPUS).length - 2

  test('reports what was searched and what the floor withheld', () => {
    const d = rankMemoriesDetailed('namespace validation rules', CORPUS, 5)
    expect(d.searched).toBe(all)
    expect(d.inactive).toBe(1)
    expect(d.results[0]?.key).toBe('reference/namespaces.md')
    // belowFloor counts what the floor withheld, not what `limit` trimmed:
    // results plus below-floor must not add up to more than the corpus.
    expect(d.belowFloor).toBeGreaterThan(0)
    expect(d.belowFloor).toBeLessThan(all)
    expect(d.results.length + d.belowFloor).toBeLessThanOrEqual(all)
  })

  test('a no-match query reports every entry as below the floor', () => {
    const d = rankMemoriesDetailed('how long should I braise short ribs in red wine', CORPUS, 5)
    expect(d.results).toEqual([])
    expect(`${d.belowFloor}/${d.searched}`).toBe(`${all}/${all}`)
  })

  test('rankMemories returns exactly the detailed results', () => {
    for (const q of ['namespace validation rules', 'deployment process', 'nothing at all here']) {
      expect(rankMemories(q, CORPUS, 3)).toEqual(rankMemoriesDetailed(q, CORPUS, 3).results)
    }
  })
})

/**
 * The namespace-root index is not a memory. Guidance tells agents to keep a
 * `MEMORY.md` table of contents, so it names every other entry and repeats the
 * whole namespace's vocabulary; ranked alongside real notes it wins broad
 * queries outright and returns a list of links where the answer was wanted. It
 * is skipped as ranking INPUT rather than filtered out of the results, because
 * a post-filter leaves it in the corpus statistics: it would still push the
 * searched count up by one and, worse, still add itself to the document
 * frequency of every term it lists, making the term look one entry more common
 * than it is and quietly downweighting the note that actually answers.
 */
describe('the namespace-root index is excluded from ranking', () => {
  // Every content term of this query appears in MEMORY.md's link list. Before
  // the exclusion the index took rank 1 at 21.09 with the note that actually
  // answers at 9.24 behind it.
  const INDEX_QUERY = 'commit style tone planning review'

  test('a query whose terms all appear in the index does not return it', () => {
    const ranked = rankMemories(INDEX_QUERY, CORPUS, Object.keys(CORPUS).length)
    // Assert on the whole key list, at every rank: R5 is absolute, so "not
    // first" is not the property. A failure names where it leaked in.
    expect(ranked.map(r => r.key)).not.toContain('MEMORY.md')
    expect(ranked[0]?.key).toBe('feedback/commit-style.md')
  })

  test('the index appears at no rank for any tuning or held-out query', () => {
    const queries = [...TUNING.map(t => t.query), ...HELD_OUT.map(h => h.query)]
    expect(queries.length).toBeGreaterThanOrEqual(19)
    const leaks = queries.filter(q =>
      rankMemories(q, CORPUS, Object.keys(CORPUS).length).some(r => r.key === 'MEMORY.md'),
    )
    expect(leaks).toEqual([])
  })

  // A `MEMORY.md` at any depth is an index. An agent that organizes a
  // sub-tree the way the guide has it organize the root keeps one there too,
  // so `project/MEMORY.md` lists its folder's notes and carries their
  // vocabulary without answering anything.
  // This inverts the earlier pin that ranked it as "a note somebody wrote":
  // a note whose answer is "the lantern is serviced every second Tuesday"
  // belongs under a key of its own, and a user who put it in an index file
  // gets it back through memory_get, not recall.
  const NESTED = {
    'MEMORY.md': '# index\n- [project](project/MEMORY.md)',
    'project/MEMORY.md': [
      '---',
      'name: project index',
      'description: lantern maintenance schedule',
      '---',
      'The lantern on the west site is serviced every second Tuesday.',
    ].join('\n'),
    'other.md': 'Unrelated notes about the weather.',
  }

  test('a nested MEMORY.md is an index too and never ranks', () => {
    const ranked = rankMemories('lantern maintenance', NESTED, 10)
    expect(ranked.map(r => r.key)).toEqual([])
  })

  test('a nested index is dropped from the searched count like the root one', () => {
    expect(rankMemoriesDetailed('lantern maintenance', NESTED, 10).searched).toBe(1)
  })

  // Degenerate namespace: the index is all there is. The ranker must return an
  // empty ranking rather than throw on an empty candidate set, and its counts
  // must stay coherent (nothing searched, nothing withheld).
  test('a namespace whose only entry is the index ranks nothing and does not throw', () => {
    const onlyIndex = { 'MEMORY.md': '# index\n- [deploy](project/deploy.md)' }
    expect(rankMemories('deploy', onlyIndex, 5)).toEqual([])
    const d = rankMemoriesDetailed('deploy', onlyIndex, 5)
    expect(`${d.results.length}/${d.searched}/${d.belowFloor}`).toBe('0/0/0')
  })

  /**
   * The interaction case with U3's rarity weighting, and the reason this unit
   * was sequenced after it. `lantern` is carried by one real note; the index
   * lists it too, so counting the index makes the term look twice as common as
   * it is. `beacon` is genuinely in two notes. With the index in the
   * denominator the two terms are equally rare and the note that answers loses
   * the key sort to the one that does not; excluded, `lantern` is correctly the
   * rarer term and its note wins outright.
   */
  const withIndex: Record<string, string> = {
    'MEMORY.md': ['# index', '- [lantern](note-z.md)', '- [lantern log](note-z.md)'].join('\n'),
    'note-a.md': 'The beacon is checked nightly.',
    'note-z.md': 'The lantern is checked nightly.',
    'filler-0.md': 'The beacon on the far ridge was replaced.',
  }
  for (let i = 1; i < 7; i++) withIndex[`filler-${i}.md`] = 'Unrelated notes about the weather.'

  /** Same corpus with the index removed outright: what the exclusion must equal. */
  const withoutIndex = Object.fromEntries(
    Object.entries(withIndex).filter(([k]) => k !== 'MEMORY.md'),
  )
  /** Same corpus with the index under an ordinary key: what it must NOT equal. */
  const indexCounted = Object.fromEntries(
    Object.entries(withIndex).map(([k, v]) => [k === 'MEMORY.md' ? 'notes/toc.md' : k, v]),
  )

  test('a term is rare when only the index made it look common', () => {
    const excluded = rankMemories('lantern beacon', withIndex, 10)
    const counted = rankMemories('lantern beacon', indexCounted, 10)
    const at = (r: typeof excluded, key: string) => r.find(x => x.key === key)
    // The ordering flip, which is the observable form of the denominator
    // change: with the index counted the two notes score identically and
    // `localeCompare` puts the wrong one first. (The index under an ordinary
    // key no longer beats them both, as it did before length normalization:
    // its two mentions of `lantern` sit in a body twice as long as either
    // note's, and BM25F counts that against it.)
    expect(excluded[0]?.key).toBe('note-z.md')
    expect(counted.map(r => r.key)).toContain('notes/toc.md')
    expect(counted.map(r => r.key).indexOf('note-a.md')).toBeLessThan(
      counted.map(r => r.key).indexOf('note-z.md'),
    )
    expect(at(counted, 'note-z.md')?.score).toBeCloseTo(at(counted, 'note-a.md')?.score ?? 0, 10)
    // And the note that answers scores strictly higher once the term stops
    // being double-counted.
    expect(at(excluded, 'note-z.md')?.score).toBeGreaterThan(at(counted, 'note-z.md')?.score ?? 0)
  })

  test('ranking with the index present equals ranking with it deleted', () => {
    // The whole property in one line: the index contributes to neither the
    // document frequency of the terms it lists nor the entry count they are
    // weighed against, so its presence cannot change a single score.
    for (const q of ['lantern beacon', 'lantern', 'beacon']) {
      const a = rankMemories(q, withIndex, 10).map(r => `${r.key}:${r.score.toFixed(6)}`)
      const b = rankMemories(q, withoutIndex, 10).map(r => `${r.key}:${r.score.toFixed(6)}`)
      expect(`${q} :: ${a.join(' | ')}`).toBe(`${q} :: ${b.join(' | ')}`)
      // Non-vacuous: a ranker that returned nothing would satisfy the equality.
      expect(a.length).toBeGreaterThan(0)
    }
  })
})

describe('near-cap scale', () => {
  // Ranking runs over everything the caller decrypted, so the cost scales with
  // the namespace, and U3 adds a document-frequency pass over the whole corpus.
  // 2000 entries is the size BASELINE_RANK_MS was measured at. This cannot go
  // through OpenRecallClient or the server: tests/setup.ts pins the caps at 5
  // entries and 5000 bytes, so the push would trip quota long before ranking.
  const corpus = nearCapCorpus(2000)
  const SEEDED = 'queue 1234'

  test('ranks the seeded entry first at 2000 entries', () => {
    expect(rankMemories(SEEDED, corpus, 5)[0]?.key).toBe('generated/queue-1234.md')
  })

  // BUDGET: 4x BASELINE_RANK_MS, the frozen pre-U2 literal in
  // tests/recall-corpus.ts. The multiple was fixed before U3 was implemented,
  // deliberately, so it could not be chosen to fit the result: it is generous
  // enough to absorb a shared CI runner and a cold JIT, and exceeding it fails
  // this unit rather than prompting a revision of the number. Measured
  // 2026-08-06 on the dev box: 59.8ms median against the 112ms budget, with the
  // pre-U3 ranker at 44.9ms on the same run, so the rarity pass costs ~33%.
  // Median of five, because one timed run on a loaded box measures the box.
  test('ranks a 2000-entry corpus within 4x the frozen baseline', () => {
    const times: number[] = []
    for (let i = 0; i < 5; i++) {
      const started = performance.now()
      rankMemories(SEEDED, corpus, 5)
      times.push(performance.now() - started)
    }
    times.sort((a, b) => a - b)
    const median = times[2]
    console.log(
      `[scale] rank of 2000 entries: ${median.toFixed(1)}ms (budget ${4 * BASELINE_RANK_MS}ms)`,
    )
    expect(`${median < 4 * BASELINE_RANK_MS} @ ${median.toFixed(1)}ms`).toBe(
      `true @ ${median.toFixed(1)}ms`,
    )
  })
})

describe('stemTerm', () => {
  // Table-driven, so the guards are readable as a contract rather than inferred
  // from an algorithm. Every row is a rule from D10 or a word the rule protects.
  test('normalizes word forms and honours the guards', () => {
    const cases: [string, string][] = [
      // Suffix stripping, the reason stemming is here at all.
      ['deployment', 'deploy'],
      ['deployments', 'deploy'],
      ['opening', 'open'],
      ['openings', 'open'],
      ['allowed', 'allow'],
      ['pushing', 'push'],
      ['actions', 'action'],
      ['validation', 'valid'],
      // ies -> y, so a plural noun meets its singular.
      ['queries', 'query'],
      ['entries', 'entry'],
      // A trailing s preceded by s is never stripped.
      ['process', 'process'],
      ['processes', 'process'],
      ['class', 'class'],
      ['classes', 'class'],
      ['address', 'address'],
      ['boss', 'boss'],
      // Minimum stem length 4: these would mangle without it.
      ['thing', 'thing'],
      ['king', 'king'],
      ['bring', 'bring'],
      ['sing', 'sing'],
      ['things', 'thing'],
      ['kings', 'king'],
      ['moment', 'moment'],
      ['need', 'need'],
      // Plurals of short words survive as their singular, not as a fragment.
      ['files', 'file'],
      ['rules', 'rule'],
    ]
    for (const [word, want] of cases) {
      expect(`${word} -> ${stemTerm(word)}`).toBe(`${word} -> ${want}`)
    }
  })

  // The two guard edges called out in D10, asserted as properties rather than
  // as single rows, because a rewrite of the rule table could satisfy any one
  // example while breaking the class.
  test('a word at exactly the minimum stem length is left intact', () => {
    const atMinimum = DAMAGE_VOCAB.filter(w => w.length === 4)
    expect(atMinimum.length).toBeGreaterThan(20)
    for (const w of atMinimum) expect(`${w} -> ${stemTerm(w)}`).toBe(`${w} -> ${w}`)
  })

  test('a word ending in ss keeps its trailing s', () => {
    const doubleS = DAMAGE_VOCAB.filter(w => w.endsWith('ss'))
    expect(doubleS.length).toBeGreaterThan(5)
    for (const w of doubleS) expect(`${w} -> ${stemTerm(w)}`).toBe(`${w} -> ${w}`)
  })

  // The damage test. An unguarded stripper was measured turning thing into th
  // and sing into s; a two-character stem matches half the corpus, which is how
  // a stemmer starts inventing answers.
  test('no word in the generated vocabulary stems below three characters', () => {
    expect(DAMAGE_VOCAB.length).toBeGreaterThan(1000)
    const short = DAMAGE_VOCAB.filter(w => stemTerm(w).length < 3).map(w => `${w}->${stemTerm(w)}`)
    expect(short).toEqual([])
  })

  test('the known-bad mangles do not occur', () => {
    for (const w of DAMAGE_WORDS) expect(`${w} -> ${stemTerm(w)}`).toBe(`${w} -> ${w}`)
    // And they stay distinct from one another: a stemmer that collapsed two of
    // them onto a shared fragment would pass the length property above.
    const stems = DAMAGE_WORDS.map(stemTerm)
    expect(new Set(stems).size).toBe(DAMAGE_WORDS.length)
  })

  test('stemming is idempotent over the whole vocabulary', () => {
    const unstable = DAMAGE_VOCAB.filter(w => stemTerm(stemTerm(w)) !== stemTerm(w))
    expect(unstable).toEqual([])
  })
})

describe('stemming does not manufacture matches', () => {
  // Written as an ordering assertion on purpose. "This query still matches
  // nothing" stops being expressible the moment U3's soft coverage removes the
  // zero-coverage drop, and U2/U3 can land in either order. What must hold
  // whichever lands first is that a query of unrelated short words never lifts
  // an entry over one that already outranked it.
  //
  // PIN: the pre-U2 ranking of this query over CORPUS, measured 2026-08-06
  // against the ranker at commit 02d2969 (no stemming). Only postgres-new
  // scored, on "process".
  const UNRELATED = 'sing this class of process'
  const PRE_U2_ORDER = ['project/postgres-new.md']

  test('an unrelated short query does not raise any entry over one it ranked below', () => {
    const ranked = rankMemories(UNRELATED, CORPUS, Object.keys(CORPUS).length).map(r => r.key)
    // Pinned entries keep their relative order...
    const pinnedInOrder = ranked.filter(k => PRE_U2_ORDER.includes(k))
    expect(pinnedInOrder).toEqual(PRE_U2_ORDER.filter(k => ranked.includes(k)))
    // ...and nothing that used to rank below them (i.e. did not rank at all)
    // may now sit above them: either the floor withholds everything, or the
    // pinned entry is first. The floor is allowed to empty this ranking
    // because that is a stricter answer, not a reordered one.
    const firstPinned = ranked.findIndex(k => PRE_U2_ORDER.includes(k))
    expect(`${UNRELATED} :: ${ranked.length === 0 ? 'empty' : firstPinned}`).toMatch(
      /:: (empty|0)$/,
    )
  })

  test('no pair of damage words becomes a match', () => {
    for (const a of DAMAGE_WORDS) {
      for (const b of DAMAGE_WORDS) {
        if (a === b) continue
        expect(`${a}/${b} :: ${stemTerm(a) === stemTerm(b)}`).toBe(`${a}/${b} :: false`)
        // And at the ranking layer: a corpus entry containing only `a` must not
        // surface for a query of only `b`.
        const ranked = rankMemories(b, { 'probe.md': `A note that mentions ${a} once.` })
        expect(`${a}/${b} :: ${ranked.length}`).toBe(`${a}/${b} :: 0`)
      }
    }
  })
})

/**
 * `tokenizeAll` is the region picker's word list: the ranker's tokenizer minus
 * the stoplist. Two layers ask different questions of the same text, so the two
 * functions have to differ in exactly one way and nowhere else.
 */
describe('tokenizeAll', () => {
  test('keeps function words and drops nothing else that tokenize keeps', () => {
    const s = 'Before you push, run the formatter. After I push, watch the pipelines.'
    const all = tokenizeAll(s)
    const topical = tokenize(s)

    // The one difference: the function words survive.
    expect(all).toContain('before')
    expect(all).toContain('after')
    expect(topical).not.toContain('before')
    expect(topical).not.toContain('after')

    // Everything else is identical: same stemming, same single-character drop,
    // and every term the ranker keeps is present here too.
    expect(all).toContain('pipeline')
    expect(topical).toContain('pipeline')
    expect(all).not.toContain('i')
    for (const t of topical)
      expect(`${t} in tokenizeAll: ${all.includes(t)}`).toBe(`${t} in tokenizeAll: true`)
  })
})

/**
 * Hidden keys: the bookkeeping entries under `sys.openrecall/` join the
 * indexes as non-candidates, and the tokens the save stamp writes into
 * every note's frontmatter (`agent: claude-code/…`, the session id) never
 * become ranking terms. The body field has been frontmatter-stripped since
 * the BM25F ranker; this pins that the stamp cannot undo it.
 */
describe('hidden keys and stamped frontmatter never rank', () => {
  const sidecar = JSON.stringify({ v: 1, keys: { 'deploy.md': '2026-11-05' } })

  test('sys.openrecall/* is never a candidate and is not counted in searched', () => {
    const notes = {
      'deploy.md': 'Deploys go to Fly in region sin.',
      'other.md': 'The weather is mild today.',
    }
    const withSystem = {
      ...notes,
      'sys.openrecall/accessed.json': sidecar,
      'sys.openrecall/trash/old-deploy.md': 'Deploys go to Fly in region sin.',
      'sys.openrecall/history/deploy.md.json': '{"deploy":"region sin"}',
    }
    const d = rankMemoriesDetailed('deploy region', withSystem)
    expect(d.searched).toBe(2)
    expect(d.results.map(r => r.key)).toEqual(['deploy.md'])
    // Not merely filtered out of the results: absent from the statistics too,
    // so the note that answers scores exactly what it scores without them.
    const alone = rankMemoriesDetailed('deploy region', notes)
    expect(d.results[0]?.score).toBe(alone.results[0]?.score as number)
    expect(rankMemories('accessed sidecar keys', withSystem)).toHaveLength(0)
  })

  test('tokens that occur only in the stamped frontmatter do not rank', () => {
    const stamped = stampForSave(null, 'Deploys go to Fly in region sin.\n', {
      now: '2026-11-05T10:00:00.000Z',
      agent: 'claude-code/2.1.284',
      session: 'sABCDEFGH',
      key: 'project/deploy.md',
    })
    expect(stamped.content).toContain('agent: claude-code/2.1.284')
    const entries = {
      'project/deploy.md': stamped.content,
      'other.md': 'The weather is mild today.',
    }
    for (const q of ['claude', 'claude code', 'sABCDEFGH', 'session sABCDEFGH', 'agent'])
      expect(
        `${q}: ${rankMemories(q, entries)
          .map(r => r.key)
          .join(',')}`,
      ).toBe(`${q}: `)
    // Control: the body still ranks, so the stamp cost the note nothing.
    expect(rankMemories('deploy region', entries)[0]?.key).toBe('project/deploy.md')
  })
})

describe('recency tiebreak', () => {
  // Long filler so that a one-word length difference between the two notes
  // of a pair lands within the band rather than outside it: the body's
  // length normalization reads `len / avg`, and against short filler one
  // extra word is a ten-percent score difference.
  const filler: Record<string, string> = {}
  for (let i = 0; i < 4; i++)
    filler[`filler-${i}.md`] =
      `Unrelated note ${i} about the weather, the garden, the kettle and the post, written at some length so the corpus has an ordinary average note size. `.repeat(
        2,
      )
  const OLD = 'The routing table lives in Postgres.'
  const NEW = 'The routing table now lives in SQLite.'
  const stamp = (updated: string, body: string) => `---\nupdated: ${updated}\n---\n${body}`

  test('two entries scoring within the band return the newer first, scores untouched', () => {
    // Control: undated, the shorter and older note wins on length alone and
    // the two sit within the band of each other.
    const undated = { 'project/db-a.md': OLD, 'project/db-b.md': NEW, ...filler }
    const control = rankMemoriesDetailed('routing table', undated).results
    expect(control.map(r => r.key)).toEqual(['project/db-a.md', 'project/db-b.md'])
    expect(control[1].score).toBeGreaterThanOrEqual(control[0].score * RECENCY_BAND)
    expect(control[1].score).toBeLessThan(control[0].score)

    const dated = {
      'project/db-a.md': stamp('2025-03-01T09:00:00.000Z', OLD),
      'project/db-b.md': stamp('2026-02-01T09:00:00.000Z', NEW),
      ...filler,
    }
    const r = rankMemoriesDetailed('routing table', dated).results
    expect(r.map(x => x.key)).toEqual(['project/db-b.md', 'project/db-a.md'])
    // The order moved and nothing else: the stamp is not a score term.
    expect(r[0].score).toBeCloseTo(control[1].score, 12)
    expect(r[1].score).toBeCloseTo(control[0].score, 12)
    expect(r[0].meta?.updated).toBe('2026-02-01T09:00:00.000Z')
  })

  test('outside the band the score order holds however old the winner is', () => {
    const entries = {
      'project/db-a.md': `---\ndescription: the routing table\nupdated: 2024-01-01\n---\n${OLD}`,
      'project/db-b.md': stamp('2026-02-01', NEW),
      ...filler,
    }
    const r = rankMemoriesDetailed('routing table', entries).results
    expect(r.map(x => x.key)).toEqual(['project/db-a.md', 'project/db-b.md'])
    expect(r[1].score).toBeLessThan(r[0].score * RECENCY_BAND)
  })

  test('entries without a date keep the key tiebreak, behind any dated one in the band', () => {
    const tied = { 'project/db-a.md': OLD, 'project/db-b.md': OLD, ...filler }
    expect(rankMemories('routing table', tied).map(r => r.key)).toEqual([
      'project/db-a.md',
      'project/db-b.md',
    ])
    const oneDated = { ...tied, 'project/db-b.md': stamp('2026-02-01', OLD) }
    expect(rankMemories('routing table', oneDated).map(r => r.key)).toEqual([
      'project/db-b.md',
      'project/db-a.md',
    ])
    const sameDate = {
      'project/db-a.md': stamp('2026-02-01', OLD),
      'project/db-b.md': stamp('2026-02-01', OLD),
      ...filler,
    }
    expect(rankMemories('routing table', sameDate).map(r => r.key)).toEqual([
      'project/db-a.md',
      'project/db-b.md',
    ])
  })

  test('the newest entry outside the band is not promoted into it', () => {
    const entries = {
      'project/db-a.md': stamp('2025-01-01', OLD),
      'project/db-b.md': stamp('2026-01-01', OLD),
      // Half the query, the newest date of the three.
      'project/db-c.md': stamp('2027-01-01', 'The table of contents.'),
      ...filler,
    }
    const r = rankMemoriesDetailed('routing table', entries).results
    expect(r.map(x => x.key)).toEqual(['project/db-b.md', 'project/db-a.md', 'project/db-c.md'])
    expect(r[2].score).toBeLessThan(r[0].score * RECENCY_BAND)
  })

  test('the manifest timestamp stands in for a missing stamp', () => {
    const r = rankEntriesDetailed('routing table', [
      { key: 'project/db-a.md', content: OLD, updatedAt: '2025-01-01T00:00:00Z' },
      { key: 'project/db-b.md', content: OLD, updatedAt: '2026-01-01T00:00:00Z' },
      ...Object.entries(filler).map(([key, content]) => ({ key, content })),
    ]).results
    expect(r.map(x => x.key)).toEqual(['project/db-b.md', 'project/db-a.md'])
    expect(r[0].meta?.updated).toBe('2026-01-01T00:00:00Z')
    // And the stamp wins over the manifest when both are present.
    const stamped = rankEntriesDetailed('routing table', [
      {
        key: 'project/db-a.md',
        content: stamp('2027-01-01', OLD),
        updatedAt: '2025-01-01T00:00:00Z',
      },
      { key: 'project/db-b.md', content: OLD, updatedAt: '2026-01-01T00:00:00Z' },
      ...Object.entries(filler).map(([key, content]) => ({ key, content })),
    ]).results
    expect(stamped.map(x => x.key)).toEqual(['project/db-a.md', 'project/db-b.md'])
  })

  test('a withheld entry is never promoted by its date', () => {
    const entries = {
      'project/db-a.md': stamp('2025-01-01', OLD),
      // Shares nothing with the query that the filler does not, and is newest.
      'project/db-z.md': stamp('2027-01-01', 'The weather is mild today.'),
      ...filler,
    }
    expect(rankMemories('routing table', entries).map(r => r.key)).toEqual(['project/db-a.md'])
  })
})

describe('inactive notes are not candidates unless asked', () => {
  const notes = {
    'project/db-new.md': 'The routing table lives in SQLite.',
    'other.md': 'The weather is mild today.',
  }
  const superseded =
    '---\nstatus: superseded\nsuperseded_by: project/db-new.md\n---\nThe routing table lives in Postgres.'

  test('a superseded note is excluded by default, counted apart, and included on request', () => {
    const all = { ...notes, 'project/db-old.md': superseded }
    const d = rankMemoriesDetailed('routing table', all)
    expect(d.searched).toBe(2)
    expect(d.inactive).toBe(1)
    expect(d.results.map(r => r.key)).toEqual(['project/db-new.md'])
    // Absent from the statistics too, like a hidden key: the note that answers
    // scores exactly what it scores with the superseded one deleted.
    expect(d.results[0].score).toBe(
      rankMemoriesDetailed('routing table', notes).results[0].score as number,
    )

    const inc = rankMemoriesDetailed('routing table', all, 5, { includeInactive: true })
    expect(inc.searched).toBe(3)
    expect(inc.inactive).toBe(0)
    expect(inc.results.map(r => r.key)).toEqual(['project/db-new.md', 'project/db-old.md'])
    expect(inc.results[1].meta).toEqual({
      status: 'superseded',
      supersededBy: 'project/db-new.md',
    })
  })

  test('a deleted note is treated the same', () => {
    const all = {
      ...notes,
      'sys.openrecall/trash/db-old.md':
        '---\nstatus: deleted\n---\nThe routing table lives in Postgres.',
      'project/db-gone.md':
        '---\nstatus: deleted\ndeleted: 2026-11-01\n---\nThe routing table lives in Postgres.',
    }
    const d = rankMemoriesDetailed('routing table', all)
    // The trashed copy is a hidden key and is not even counted as inactive.
    expect(`${d.searched}/${d.inactive}`).toBe('2/1')
    expect(d.results.map(r => r.key)).toEqual(['project/db-new.md'])
    const inc = rankMemoriesDetailed('routing table', all, 5, { includeInactive: true })
    expect(inc.results.map(r => r.key)).toEqual(['project/db-gone.md', 'project/db-new.md'])
  })

  test('a miss reports the inactive notes it did not search', () => {
    const all = { ...notes, 'project/db-old.md': superseded }
    const d = rankMemoriesDetailed('postgres', all)
    expect(d.results).toEqual([])
    expect(d.reason).toBe('below-floor')
    expect(`${d.searched}/${d.belowFloor}/${d.inactive}`).toBe('2/2/1')
    const inc = rankMemoriesDetailed('postgres', all, 5, { includeInactive: true })
    expect(inc.results.map(r => r.key)).toEqual(['project/db-old.md'])
  })

  test('an expired note is excluded from the day after its date, and included on request', () => {
    const all = {
      ...notes,
      'project/db-temp.md':
        '---\nexpires: 2026-11-04\n---\nThe routing table lives in a temp file.',
    }
    const onTheDay = rankMemoriesDetailed('routing table', all, 5, { today: '2026-11-04' })
    expect(`${onTheDay.searched}/${onTheDay.inactive}`).toBe('3/0')
    expect(onTheDay.results.map(r => r.key)).toContain('project/db-temp.md')
    const after = rankMemoriesDetailed('routing table', all, 5, { today: '2026-11-05' })
    expect(`${after.searched}/${after.inactive}`).toBe('2/1')
    expect(after.results.map(r => r.key)).toEqual(['project/db-new.md'])
    const asked = rankMemoriesDetailed('routing table', all, 5, {
      today: '2026-11-05',
      includeInactive: true,
    })
    expect(`${asked.searched}/${asked.inactive}`).toBe('3/0')
    expect(asked.results.map(r => r.key)).toContain('project/db-temp.md')
  })

  test('a long-lived index moves a note across the line the day it expires', () => {
    const idx = new RecallIndex()
    const all = {
      ...notes,
      'project/db-temp.md':
        '---\nexpires: 2026-11-04\n---\nThe routing table lives in a temp file.',
    }
    for (const [key, content] of Object.entries(all))
      idx.upsert({ id: key, key, content, fingerprint: key })
    expect(RecallIndex.rank([idx], 'routing table', 5, { today: '2026-11-04' }).searched).toBe(3)
    const expired = RecallIndex.rank([idx], 'routing table', 5, { today: '2026-11-05' })
    expect(`${expired.searched}/${expired.inactive}`).toBe('2/1')
    // The statistics followed it: same score as an index never holding it.
    expect(expired.results[0].score).toBe(
      rankMemoriesDetailed('routing table', notes).results[0].score as number,
    )
    // And back, for a clock that is behind.
    expect(RecallIndex.rank([idx], 'routing table', 5, { today: '2026-11-03' }).searched).toBe(3)
  })

  test('an expires that is not a calendar date never expires', () => {
    const all = { ...notes, 'project/db-temp.md': '---\nexpires: soon\n---\nThe routing table.' }
    const d = rankMemoriesDetailed('routing table', all, 5, { today: '2099-01-01' })
    expect(`${d.searched}/${d.inactive}`).toBe('3/0')
    expect(isInactive({ expires: 'soon' }, '2099-01-01')).toBe(false)
    expect(isInactive({ expires: '2026-11-04' }, '2026-11-05')).toBe(true)
    expect(isInactive({ expires: '2026-11-04' }, '2026-11-04')).toBe(false)
    expect(isInactive({ status: 'active' }, '2026-11-04')).toBe(false)
  })

  test('noteMeta reads the six fields and nothing else', () => {
    expect(
      noteMeta(
        '---\nid: 01X\ntype: feedback\ndescription: d\nupdated: 2026-11-05T10:00:00.000Z\nagent: claude-code/2.1.284\nstatus: superseded\nsuperseded_by: a/b.md\nexpires: 2027-01-01\nlocked: true\n---\nbody',
      ),
    ).toEqual({
      type: 'feedback',
      updated: '2026-11-05T10:00:00.000Z',
      agent: 'claude-code/2.1.284',
      status: 'superseded',
      supersededBy: 'a/b.md',
      expires: '2027-01-01',
    })
    expect(noteMeta('no frontmatter')).toEqual({})
    expect(noteMeta('---\nupdated:\n---\nbody')).toEqual({})
  })
})
