/**
 * Relevance ranker. Asserts ordering and the description/key weighting, plus
 * the empty-query and no-overlap guards.
 */

import { describe, expect, test } from 'bun:test'
import { rankMemories, stemTerm } from '../src/mcp/relevance.ts'
import { CORPUS, DAMAGE_VOCAB, DAMAGE_WORDS } from './recall-corpus.ts'

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
    // may now sit above them.
    const firstPinned = ranked.findIndex(k => PRE_U2_ORDER.includes(k))
    expect(`${UNRELATED} :: ${firstPinned}`).toBe(`${UNRELATED} :: 0`)
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
