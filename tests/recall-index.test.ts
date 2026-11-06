/**
 * The incremental recall index. What `tests/relevance.test.ts` pins about
 * scoring holds here by construction, because `rankEntriesDetailed` is a
 * transient index; this file pins what the index adds on top: that updating
 * it one entry at a time gives the same answer as building it from scratch,
 * that an unchanged fingerprint costs nothing, that several indexes rank as
 * one corpus, that every `MEMORY.md` is excluded from the statistics, that
 * code identifiers are findable whole and by part, that a short note beats a
 * long one with the same counts, and what a warm query costs.
 */

import { describe, expect, test } from 'bun:test'
import {
  type IndexDoc,
  isIndexKey,
  type MemoryEntry,
  type RankedResult,
  RecallIndex,
  rankEntriesDetailed,
  rankMemoriesDetailed,
  tokenize,
} from '../src/mcp/relevance.ts'
import { nearCapCorpus } from './recall-corpus.ts'

/** Deterministic PRNG (mulberry32), so a failing sequence is reproducible from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A fingerprint that follows the content, the way the tools' fallback one does. */
const fingerprintOf = (content: string) =>
  `${content.length}|${content.slice(0, 40)}|${content.slice(-40)}`

const docOf = (key: string, content: string, namespace?: string): IndexDoc => ({
  id: key,
  key,
  ...(namespace === undefined ? {} : { namespace }),
  content,
  fingerprint: fingerprintOf(content),
})

/** What two rankings have to agree on, as one comparable string. */
const shape = (r: RankedResult) =>
  [
    `searched=${r.searched} below=${r.belowFloor} trimmed=${r.trimmedByLimit} reason=${r.reason ?? ''}`,
    ...r.results.map(
      x => `${x.namespace ?? ''}|${x.key}:${x.score.toFixed(9)}:${(x.norm ?? 0).toFixed(9)}`,
    ),
  ].join('\n')

const QUERIES = [
  'queue 1234',
  'cache layer revision 3',
  'worker transport once',
  'generated filler',
  'router',
  'nothing here at all',
]

describe('incremental parity', () => {
  // Random sequences of upsert (new and changed content), remove and retain
  // over slices of the near-cap corpus. After every step the incremental
  // index must agree with one built from scratch over the same entries, and
  // with the pure ranker, on size and on every ranking.
  const corpus = nearCapCorpus(240)
  const keys = Object.keys(corpus)

  for (const seed of [1, 2, 3]) {
    test(`random upsert/remove/retain sequence (seed ${seed}) matches a fresh build`, () => {
      const random = rng(seed)
      const pick = (n: number) => Math.floor(random() * n)
      const truth = new Map<string, string>()
      const incremental = new RecallIndex()
      let edits = 0
      for (let step = 0; step < 60; step++) {
        const op = random()
        if (op < 0.5) {
          // Add or replace a slice of entries, some with their content changed.
          const start = pick(keys.length)
          for (const key of keys.slice(start, start + 1 + pick(12))) {
            const content = random() < 0.3 ? `${corpus[key]}\nEdit ${++edits}.` : corpus[key]
            truth.set(key, content)
            incremental.upsert(docOf(key, content))
          }
        } else if (op < 0.8 && truth.size > 0) {
          const victims = [...truth.keys()].filter(() => random() < 0.2)
          for (const key of victims) {
            truth.delete(key)
            expect(incremental.remove(key)).toBe(true)
          }
        } else if (truth.size > 0) {
          const keep = [...truth.keys()].filter(() => random() < 0.7)
          const removed = incremental.retain(keep)
          const expected = [...truth.keys()].filter(k => !keep.includes(k))
          expect(removed.sort()).toEqual(expected.sort())
          for (const key of expected) truth.delete(key)
        }

        const fresh = new RecallIndex()
        for (const [key, content] of truth) fresh.upsert(docOf(key, content))
        const entries: MemoryEntry[] = [...truth].map(([key, content]) => ({ key, content }))
        expect(incremental.size).toBe(fresh.size)
        expect(incremental.size).toBe(truth.size)
        for (const q of QUERIES) {
          const a = shape(RecallIndex.rank([incremental], q, 10))
          expect(a).toBe(shape(RecallIndex.rank([fresh], q, 10)))
          expect(a).toBe(shape(rankEntriesDetailed(q, entries, 10)))
        }
      }
      // Non-vacuous: the sequence ranked something at some point.
      expect(truth.size).toBeGreaterThan(0)
    })
  }

  test('sync makes the index hold exactly the given documents and reports the counts', () => {
    const idx = new RecallIndex()
    const first = keys.slice(0, 20).map(k => docOf(k, corpus[k]))
    expect(idx.sync(first)).toEqual({ added: 20, updated: 0, unchanged: 0, removed: 0 })
    const second = [
      ...keys.slice(5, 15).map(k => docOf(k, corpus[k])),
      ...keys.slice(15, 20).map(k => docOf(k, `${corpus[k]} changed`)),
      ...keys.slice(20, 23).map(k => docOf(k, corpus[k])),
    ]
    expect(idx.sync(second)).toEqual({ added: 3, updated: 5, unchanged: 10, removed: 5 })
    expect(idx.size).toBe(18)
    for (const k of keys.slice(0, 5)) expect(idx.has(k)).toBe(false)
    for (const k of keys.slice(5, 23)) expect(idx.has(k)).toBe(true)
  })
})

describe('fingerprints', () => {
  test('an unchanged fingerprint skips tokenizing and keeps the stored term maps', () => {
    const idx = new RecallIndex()
    const content = corpusEntry()
    expect(idx.upsert(docOf('a.md', content))).toBe('added')
    const before = idx.doc('a.md')
    expect(before).toBeDefined()
    // Same fingerprint, different content object: nothing is re-read. The
    // carried fields are refreshed, the statistics are not touched.
    expect(idx.upsert({ ...docOf('a.md', content), content: `${content}`, updatedAt: 'now' })).toBe(
      'unchanged',
    )
    const after = idx.doc('a.md')
    expect(after?.tf).toBe(before?.tf as Map<string, number | number[]>)
    expect(after?.len).toBe(before?.len as number[])
    expect(after?.updatedAt).toBe('now')
  })

  test('a changed fingerprint re-tokenizes and replaces the term maps', () => {
    const idx = new RecallIndex()
    idx.upsert(docOf('a.md', 'The lantern is checked nightly.'))
    const before = idx.doc('a.md')?.tf
    expect(idx.upsert(docOf('a.md', 'The beacon is checked nightly.'))).toBe('updated')
    expect(idx.doc('a.md')?.tf).not.toBe(before as Map<string, number | number[]>)
    expect(RecallIndex.rank([idx], 'lantern').results).toEqual([])
    expect(RecallIndex.rank([idx], 'beacon').results.map(r => r.key)).toEqual(['a.md'])
  })

  test('an empty fingerprint never matches, so a caller without one always re-tokenizes', () => {
    const idx = new RecallIndex()
    const doc = { id: 'a.md', key: 'a.md', content: 'lantern', fingerprint: '' }
    expect(idx.upsert(doc)).toBe('added')
    expect(idx.upsert({ ...doc, content: 'beacon' })).toBe('updated')
    expect(RecallIndex.rank([idx], 'beacon').results.map(r => r.key)).toEqual(['a.md'])
  })

  function corpusEntry() {
    return Object.values(nearCapCorpus(1))[0]
  }
})

describe('several indexes rank as one corpus', () => {
  const corpus = nearCapCorpus(150)
  const keys = Object.keys(corpus)
  const parts = [keys.slice(0, 50), keys.slice(50, 100), keys.slice(100)]
  const namespaces = ['user:me', 'user:me/projects/a', 'user:me/projects/b']

  test('ranking three indexes equals the pure ranker over the concatenation', () => {
    const indexes = parts.map((slice, i) => {
      const idx = new RecallIndex()
      for (const key of slice) idx.upsert(docOf(key, corpus[key], namespaces[i]))
      return idx
    })
    const entries: MemoryEntry[] = parts.flatMap((slice, i) =>
      slice.map(key => ({ key, content: corpus[key], namespace: namespaces[i] })),
    )
    for (const q of QUERIES) {
      const multi = RecallIndex.rank(indexes, q, 10)
      expect(shape(multi)).toBe(shape(rankEntriesDetailed(q, entries, 10)))
      // And the statistics are the union's: the searched count spans all three.
      expect(multi.searched).toBe(keys.length)
    }
  })

  test('a term rare in one namespace and common in another is weighed over the union', () => {
    // `kestrel` once in a, forty times in b. Alone, a's note is a sole
    // carrier; together, the term is common and a's note scores less.
    const a = new RecallIndex()
    a.upsert(docOf('a.md', 'A kestrel was watched at dusk.', 'ns:a'))
    for (let i = 0; i < 5; i++)
      a.upsert(docOf(`fill-${i}.md`, 'Unrelated notes about the weather.', 'ns:a'))
    const b = new RecallIndex()
    for (let i = 0; i < 40; i++)
      b.upsert(docOf(`k-${i}.md`, 'The kestrel hunts the verge.', 'ns:b'))
    const alone = RecallIndex.rank([a], 'kestrel').results[0]
    const together = RecallIndex.rank([a, b], 'kestrel').results.find(r => r.namespace === 'ns:a')
    expect(alone?.key).toBe('a.md')
    expect(together?.key).toBe('a.md')
    expect(together?.score as number).toBeLessThan(alone?.score as number)
  })
})

describe('every MEMORY.md is an index', () => {
  test('isIndexKey names the root and any nested MEMORY.md and nothing else', () => {
    for (const key of ['MEMORY.md', 'project/MEMORY.md', 'a/b/MEMORY.md'])
      expect(`${key}:${isIndexKey(key)}`).toBe(`${key}:true`)
    for (const key of ['memory.md', 'MEMORY.md.bak', 'notes/MEMORY.txt', 'MEMORY', 'xMEMORY.md'])
      expect(`${key}:${isIndexKey(key)}`).toBe(`${key}:false`)
  })

  // Excluded from `searched` and from the document frequencies: the note that
  // answers scores exactly what it scores with the indexes deleted outright.
  const withIndexes: Record<string, string> = {
    'MEMORY.md': '- [lantern](note-z.md)',
    'project/MEMORY.md': '- [lantern log](note-z.md)',
    'a/b/MEMORY.md': 'lantern lantern lantern',
    'note-z.md': 'The lantern is checked nightly.',
    'note-a.md': 'The beacon is checked nightly.',
  }
  for (let i = 0; i < 6; i++) withIndexes[`filler-${i}.md`] = 'Unrelated notes about the weather.'
  const withoutIndexes = Object.fromEntries(
    Object.entries(withIndexes).filter(([k]) => !isIndexKey(k)),
  )

  test('nested indexes are tracked but neither searched nor counted in df', () => {
    const idx = new RecallIndex()
    for (const [key, content] of Object.entries(withIndexes)) idx.upsert(docOf(key, content))
    expect(idx.size).toBe(Object.keys(withIndexes).length)
    expect(idx.has('a/b/MEMORY.md')).toBe(true)
    const r = RecallIndex.rank([idx], 'lantern beacon', 10)
    expect(r.searched).toBe(Object.keys(withoutIndexes).length)
    expect(r.results.map(x => x.key)).not.toContain('project/MEMORY.md')
    expect(r.results.map(x => x.key)).not.toContain('a/b/MEMORY.md')
    expect(shape(r)).toBe(shape(rankMemoriesDetailed('lantern beacon', withoutIndexes, 10)))
    // Both notes answer half the query and nothing else carries either word,
    // so they tie and key order decides; the indexes' three extra mentions of
    // `lantern` did not make it look more common than `beacon`.
    expect(r.results.map(x => x.key)).toEqual(['note-a.md', 'note-z.md'])
    expect(r.results[0].score).toBeCloseTo(r.results[1].score, 10)
  })

  test('removing an index entry changes no statistic', () => {
    const idx = new RecallIndex()
    for (const [key, content] of Object.entries(withIndexes)) idx.upsert(docOf(key, content))
    const before = shape(RecallIndex.rank([idx], 'lantern', 10))
    expect(idx.remove('a/b/MEMORY.md')).toBe(true)
    expect(shape(RecallIndex.rank([idx], 'lantern', 10))).toBe(before)
  })
})

describe('code identifiers', () => {
  const notes: Record<string, string> = {
    'tooling/pm.md': 'Install with pnpm, never with the other package managers.',
    'ci/release.md': 'Versions are cut by release-please from conventional commits.',
    'runtime/node.md': 'The pinned Node is 24.22.1 on every runner.',
    'locking/lock.md': 'The lock file is opened with O_EXCL so a second writer fails.',
    'ranker/api.md': 'Call rankEntriesDetailed to rank a combined corpus.',
  }
  for (let i = 0; i < 6; i++) notes[`filler-${i}.md`] = 'Unrelated notes about the weather.'

  test('the tokenizer emits a compound verbatim beside its parts, and splits camelCase', () => {
    expect(tokenize('release-please')).toEqual(['release-please', 'release', 'please'])
    expect(tokenize('24.22.1')).toEqual(['24.22.1', '24', '22'])
    expect(tokenize('O_EXCL')).toEqual(['o_excl', 'excl'])
    expect(tokenize('rankEntriesDetailed')).toEqual(['rank', 'entry', 'detail'])
    expect(tokenize('pnpm')).toEqual(['pnpm'])
    // A key is split on `/` first, so the compound is one segment.
    expect(tokenize('src/mcp/relevance.ts')).toContain('src/mcp/relevance.ts')
  })

  const cases: [string, string][] = [
    ['pnpm', 'tooling/pm.md'],
    ['release-please', 'ci/release.md'],
    ['release please', 'ci/release.md'],
    ['please', 'ci/release.md'],
    ['24.22.1', 'runtime/node.md'],
    ['node 24', 'runtime/node.md'],
    ['O_EXCL', 'locking/lock.md'],
    ['excl', 'locking/lock.md'],
    ['rankEntriesDetailed', 'ranker/api.md'],
    ['entries detailed', 'ranker/api.md'],
    ['rank entries', 'ranker/api.md'],
  ]

  test('each identifier is findable by the whole token and by a part', () => {
    for (const [query, want] of cases) {
      const got = rankMemoriesDetailed(query, notes, 3).results[0]?.key
      expect(`${query} -> ${got}`).toBe(`${query} -> ${want}`)
    }
  })

  test('a note holding the exact identifier beats one holding only its parts', () => {
    const pair = {
      'exact.md': 'The tag is cut by release-please.',
      'parts.md': 'We release the tag when you please.',
      'filler.md': 'Unrelated notes about the weather.',
    }
    const r = rankMemoriesDetailed('release-please', pair, 3).results
    expect(r.map(x => x.key)).toEqual(['exact.md', 'parts.md'])
    expect(r[0].score).toBeGreaterThan(r[1].score)
  })

  test('a compound does not count in the coverage denominator', () => {
    // One note, two words covered, no compound: full coverage. Had the
    // compound counted, the note would cover two of three and its norm would
    // sit at two thirds of this.
    const only = { 'parts.md': 'We release the tag when you please.' }
    const norm = rankMemoriesDetailed('release-please', only, 3).results[0]?.norm ?? 0
    expect(norm).toBeGreaterThan(0.4)
    // And a compound alone is still a query: its parts are what have to be covered.
    const r = rankMemoriesDetailed('release-please', only, 3)
    expect(r.reason).toBeUndefined()
  })
})

describe('length normalization', () => {
  test('a 150-char fact beats a 1,500-char note with the same term counts', () => {
    const fact = 'Quarry ships from the release branch; the smoke run must be green first.'
    const padding = Array.from(
      { length: 24 },
      (_, i) => `Context sentence ${i} about an unrelated matter that fills the note out.`,
    ).join(' ')
    const long = `${fact} ${padding}`
    expect(fact.length).toBeLessThanOrEqual(150)
    expect(long.length).toBeGreaterThanOrEqual(1500)
    const entries = { 'long.md': long, 'short.md': fact }
    for (let i = 0; i < 4; i++)
      (entries as Record<string, string>)[`filler-${i}.md`] = 'Unrelated notes about the weather.'
    const r = rankMemoriesDetailed('release branch smoke', entries, 5).results
    expect(r.map(x => x.key)).toEqual(['short.md', 'long.md'])
    expect(r[0].score).toBeGreaterThan(r[1].score)
  })
})

describe('warm query cost', () => {
  // The number the index exists for: once a namespace has been synced, a
  // query is N x |q| map lookups plus a sort. The bound is generous so a
  // shared runner passes; the measured value is printed for the record.
  test('a warm query over 2,000 synced entries is a few milliseconds', () => {
    const idx = new RecallIndex()
    const built = performance.now()
    idx.sync(Object.entries(nearCapCorpus(2000)).map(([key, content]) => docOf(key, content)))
    const buildMs = performance.now() - built
    const times: number[] = []
    for (let i = 0; i < 21; i++) {
      const started = performance.now()
      RecallIndex.rank([idx], 'cache layer revision 3', 5)
      times.push(performance.now() - started)
    }
    times.sort((a, b) => a - b)
    const resync = performance.now()
    const counts = idx.sync(
      Object.entries(nearCapCorpus(2000)).map(([key, content]) => docOf(key, content)),
    )
    const resyncMs = performance.now() - resync
    console.log(
      `[index] build 2000: ${buildMs.toFixed(1)}ms, warm query median ${times[10].toFixed(2)}ms, unchanged resync ${resyncMs.toFixed(1)}ms`,
    )
    expect(counts).toEqual({ added: 0, updated: 0, unchanged: 2000, removed: 0 })
    expect(`${times[10] < 20} @ ${times[10].toFixed(2)}ms`).toBe(`true @ ${times[10].toFixed(2)}ms`)
  })
})
