/**
 * The save gate (`src/mcp/gate.ts`): each detector with a positive and a
 * negative control, the short-text fallback, and the corpus check that the
 * thresholds are documented against. The thresholds in the module are
 * literals with measured numbers in their comments; the corpus block here is
 * what keeps those numbers honest, because it re-measures them on every run
 * and prints them next to the assertion.
 *
 * The gate takes parsed metadata, so this file carries a deliberately tiny
 * frontmatter reader of its own (`toGateNote`) for the fixture corpus. It is
 * not the project's parser and must not grow into one.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildIdf,
  type Candidate,
  CONTRADICTION_CUES,
  contradiction,
  contradictionCues,
  DEFAULT_LIMIT,
  DESCRIPTION_CLIP,
  DUP,
  descriptionCosine,
  descriptionVector,
  estimatedJaccard,
  exactTokenJaccard,
  findCandidates,
  type GateNote,
  idfWeight,
  isShortText,
  labelledValues,
  MINHASH_PERMS,
  minhashSignature,
  NEAR_DUP,
  type NoteProfile,
  profileNote,
  RESAVE_MODES_LINE,
  renderNeedsDecision,
  SAME_TOPIC,
  SHORT_TEXT_TOKENS,
} from '../src/mcp/gate.ts'
import { tokenize, tokenizeAll } from '../src/mcp/relevance.ts'
import { CORPUS, nearCapCorpus } from './recall-corpus.ts'

const TYPES = new Set(['user', 'feedback', 'project', 'reference'])

/** Fixture-only reader: `name:` and `description:` out of `---` frontmatter, body after it. */
function toGateNote(key: string, content: string): GateNote {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  const fm = m ? m[1] : ''
  const body = m ? content.slice(m[0].length) : content
  const field = (name: string) => {
    const r = new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(fm)
    return r ? r[1].trim() : undefined
  }
  const seg = key.slice(0, key.indexOf('/'))
  const note: GateNote = { key, description: field('description') ?? '', body }
  if (TYPES.has(seg)) note.type = seg
  const title = field('name')
  if (title !== undefined) note.title = title
  return note
}

const CORPUS_NOTES: GateNote[] = Object.entries(CORPUS)
  .filter(([key]) => key !== 'MEMORY.md')
  .map(([key, content]) => toGateNote(key, content))

const note = (key: string, description: string, body: string, extra: Partial<GateNote> = {}) => ({
  key,
  description,
  body,
  ...extra,
})

/** 62 words: long enough for MinHash on both sides. Invented, like the corpus. */
const LONG_A =
  'The dispatcher reads every queued order from the regional table and routes it to the ' +
  'nearest shop that has the right paper stock loaded, retrying twice on a timeout before it ' +
  'shelves the order and pages the on-call engineer. Shelved orders are listed on the morning ' +
  'handoff sheet so the day shift can release them by hand once the shop confirms stock.'

/** LONG_A with four edits. */
const LONG_A_EDITED = LONG_A.replace('nearest', 'closest')
  .replace('twice', 'three times')
  .replace('morning', 'daily')
  .replace('by hand', 'manually')

/** Same length, nothing in common. */
const LONG_B =
  'A storefront token bucket refills on a fixed interval and each refill grants a burst that ' +
  'one noisy caller can spend in seconds, after which further calls wait rather than fail. ' +
  'The interval is tuned per region because inland sites see slower links, and the bucket ' +
  'depth is published on the status page so a shop can plan its batch uploads around it.'

function shingleSet(body: string): Set<string> {
  const w = tokenizeAll(body)
  const out = new Set<string>()
  for (let i = 0; i + 3 <= w.length; i++) out.add(w.slice(i, i + 3).join(' '))
  return out
}

function exactShingleJaccard(a: string, b: string): number {
  const sa = shingleSet(a)
  const sb = shingleSet(b)
  let inter = 0
  for (const s of sa) if (sb.has(s)) inter++
  return inter / (sa.size + sb.size - inter)
}

describe('description TF-IDF', () => {
  const corpus = [
    note('project/a.md', 'how we deploy Quillrun', ''),
    note('project/b.md', 'where the code goes live', ''),
    note('project/c.md', 'runtime and language choices', ''),
  ]

  test('idf is ln(1 + N/df), never zero, and treats an unseen term as seen once', () => {
    const idf = buildIdf(corpus)
    expect(idf.n).toBe(3)
    expect(idfWeight(idf, 'deploy')).toBeCloseTo(Math.log(1 + 3 / 1), 10)
    expect(idfWeight(idf, 'nowhere')).toBeCloseTo(Math.log(1 + 3 / 1), 10)
    const all = buildIdf([...corpus, note('project/d.md', 'deploy deploy deploy', '')])
    expect(idfWeight(all, 'deploy')).toBeCloseTo(Math.log(1 + 4 / 2), 10)
  })

  test('the vector counts terms and includes the title', () => {
    const idf = buildIdf(corpus)
    const v = descriptionVector(
      note('project/x.md', 'deploy twice', 'ignored body', { title: 'deploy' }),
      idf,
    )
    expect(v.get('deploy')).toBeCloseTo(2 * idfWeight(idf, 'deploy'), 10)
    expect(v.has('twice')).toBe(true)
    expect(v.has('ignored')).toBe(false)
  })

  test('cosine: identical 1, disjoint 0, restatement high, loose rewording lower', () => {
    const idf = buildIdf(corpus)
    expect(descriptionCosine(corpus[0], corpus[0], idf)).toBeCloseTo(1, 10)
    expect(descriptionCosine(corpus[0], corpus[2], idf)).toBe(0)
    const restated = note('project/x.md', 'how Quillrun gets deployed', '')
    expect(descriptionCosine(corpus[0], restated, idf)).toBeGreaterThan(SAME_TOPIC)
    expect(descriptionCosine(corpus[0], note('project/y.md', 'how', ''), idf)).toBe(0)
  })
})

describe('MinHash', () => {
  test('signatures are 64 slots and deterministic across runs', () => {
    const sig = minhashSignature(LONG_A)
    expect(sig).toHaveLength(MINHASH_PERMS)
    expect(sig).toEqual(minhashSignature(LONG_A))
    // Pinned from the first run: the permutation seeds are fixed, so a change
    // to the hash, the seed, or the shingling breaks every cached signature
    // and must be a deliberate, versioned change. (Re-pinned once, when the
    // tokenizer gained compound tokens for code identifiers: shingles are
    // built from `tokenizeAll`, so that change moved the digest on purpose.)
    expect(Array.from(sig.slice(0, 4))).toEqual([9330135, 23946345, 15212012, 1720666])
    let sum = 0
    for (const v of sig) sum = (sum + v) % 1000000007
    expect(sum).toBe(875660784)
  })

  test('estimate tracks the exact shingle Jaccard', () => {
    const self = estimatedJaccard(minhashSignature(LONG_A), minhashSignature(LONG_A))
    expect(self).toBe(1)
    const exact = exactShingleJaccard(LONG_A, LONG_A_EDITED)
    const est = estimatedJaccard(minhashSignature(LONG_A), minhashSignature(LONG_A_EDITED))
    console.log(
      `[gate] LONG_A vs edited: exact shingle Jaccard ${exact.toFixed(3)}, estimated ${est.toFixed(3)}`,
    )
    expect(Math.abs(est - exact)).toBeLessThan(0.15)
    expect(est).toBeGreaterThanOrEqual(NEAR_DUP)
    expect(est).toBeLessThan(DUP)
    expect(estimatedJaccard(minhashSignature(LONG_A), minhashSignature(LONG_B))).toBeLessThan(0.1)
  })

  test('an empty body resembles nothing, including another empty body', () => {
    expect(estimatedJaccard(minhashSignature(''), minhashSignature(''))).toBe(0)
    expect(estimatedJaccard(minhashSignature('one two'), minhashSignature('one two'))).toBe(0)
    expect(estimatedJaccard(minhashSignature(LONG_A), new Uint32Array(3))).toBe(0)
  })
})

describe('short-text fallback', () => {
  const short = note(
    'feedback/a.md',
    'how tests are written',
    'Every rule gets a table case with a sample order.',
  )

  test('short is fewer than SHORT_TEXT_TOKENS content tokens', () => {
    expect(tokenize(short.body).length).toBeLessThan(SHORT_TEXT_TOKENS)
    expect(isShortText(short)).toBe(true)
    expect(isShortText(note('x/y.md', '', LONG_A))).toBe(false)
  })

  test('exact Jaccard over description + body sets', () => {
    expect(exactTokenJaccard(short, short)).toBe(1)
    expect(
      exactTokenJaccard(short, note('feedback/b.md', 'deploy region', 'Ashfield cluster.')),
    ).toBe(0)
    const half = note('feedback/c.md', 'how tests are written', 'Every rule gets a table case.')
    const j = exactTokenJaccard(short, half)
    expect(j).toBeGreaterThan(0.5)
    expect(j).toBeLessThan(1)
  })

  test('a short pair never computes a signature', () => {
    const signatures = new Map<string, Uint32Array>()
    const profiles = new Map<string, NoteProfile>()
    const copy = note('feedback/copy.md', short.description, short.body)
    const found = findCandidates(copy, [short], { signatures, profiles })
    expect(found).toEqual([
      { key: short.key, description: short.description, similarity: 1, reason: 'duplicate' },
    ])
    expect(signatures.size).toBe(0)
    expect(profiles.get(short.key)?.signature).toBeUndefined()
  })

  test('a long target against a short note still uses the exact path', () => {
    const long = note('feedback/long.md', 'how tests are written', `${short.body} ${LONG_B}`)
    const found = findCandidates(long, [short])
    // The short note's tokens are a subset of the long one's, so the exact
    // Jaccard is |short| / |long|, well below the near-duplicate bar.
    expect(
      found.find(c => c.reason === 'near-duplicate' || c.reason === 'duplicate'),
    ).toBeUndefined()
  })
})

describe('contradiction heuristic', () => {
  const squash = note(
    'feedback/commits.md',
    'commit squashing before a merge',
    'Always squash commits before merging a branch.',
    {
      type: 'feedback',
    },
  )
  const noSquash = note(
    'feedback/merge.md',
    'commit squashing policy',
    'Never squash commits; merge with a merge commit.',
    {
      type: 'feedback',
    },
  )
  const idf = buildIdf([squash, noSquash])

  test('cue sets differing on overlapping topics in the same prefix and type', () => {
    const r = contradiction(squash, noSquash, idf)
    expect(r.contradicts).toBe(true)
    expect(r.overlap).toBeGreaterThanOrEqual(0.3)
    expect(r.reason).toContain('always')
    expect(r.reason).toContain('never')
    // Symmetric in the verdict and the overlap.
    const back = contradiction(noSquash, squash, idf)
    expect(back.contradicts).toBe(true)
    expect(back.overlap).toBe(r.overlap)
  })

  test('the same cues on both sides are agreement, not contradiction', () => {
    const also = note(
      'feedback/also.md',
      'commit squashing before a merge',
      'Always squash commits before merging.',
      { type: 'feedback' },
    )
    expect(contradiction(squash, also, idf).contradicts).toBe(false)
  })

  test('a label with a different value', () => {
    const fra = note(
      'project/region.md',
      'default deploy region',
      'region: fra\nWhy: closest to the shops.',
    )
    const sin = note(
      'project/deploy-region.md',
      'deploy region for Quillrun',
      'region: sin\nWhy: cheapest.',
    )
    const r = contradiction(fra, sin, buildIdf([fra, sin]))
    expect(r.contradicts).toBe(true)
    expect(r.reason).toBe('"region" is "fra" here and "sin" there')
    // Same value, case and punctuation aside: no contradiction.
    const same = note(
      'project/deploy-region.md',
      'deploy region for Quillrun',
      'Region: FRA.\nWhy: cheapest.',
    )
    expect(contradiction(fra, same, buildIdf([fra, same])).contradicts).toBe(false)
  })

  test('a Why: line is prose, so two different reasons do not contradict', () => {
    const a = note(
      'feedback/a.md',
      'review rules for money',
      'Two reviewers on anything that touches money.\nWhy: a pricing slip is costly.',
      { type: 'feedback' },
    )
    const b = note(
      'feedback/b.md',
      'review rules for money paths',
      'Two reviewers on anything that touches money.\nWhy: shops notice before we do.',
      { type: 'feedback' },
    )
    expect(contradiction(a, b, buildIdf([a, b])).contradicts).toBe(false)
    expect(labelledValues(a.body).size).toBe(0)
  })

  test('structural gates: prefix, type and topic overlap', () => {
    const other = { ...noSquash, key: 'project/merge.md' }
    expect(contradiction(squash, other, idf)).toEqual({ contradicts: false, overlap: 0 })
    const typed = { ...noSquash, type: 'project' }
    expect(contradiction(squash, typed, idf)).toEqual({ contradicts: false, overlap: 0 })
    // Untyped on one side is compatible with any type on the other.
    const untyped = { ...noSquash, type: undefined }
    expect(contradiction(squash, untyped, idf).contradicts).toBe(true)
    const unrelated = note(
      'feedback/tone.md',
      'register for shop copy',
      'Never use jargon in copy shops read.',
      { type: 'feedback' },
    )
    const r = contradiction(squash, unrelated, buildIdf([squash, unrelated]))
    expect(r.contradicts).toBe(false)
    expect(r.overlap).toBeLessThan(0.3)
  })

  test('cues: stopwords are not dropped, apostrophes fold, counts do not matter', () => {
    const cues = contradictionCues(note('x/y.md', '', "Do not do this. Don't ever. Not again."))
    expect(cues).toEqual(new Set(['not', 'dont']))
    expect(CONTRADICTION_CUES.has('not')).toBe(true)
    expect(CONTRADICTION_CUES.has('parked')).toBe(true)
  })

  test('labelled values: bullets, case folding, long values and URLs', () => {
    const labels = labelledValues(
      [
        '- Editor: Nova',
        'Default Region: fra',
        'Docs: https://example.invalid/x',
        'Summary: this is a long sentence that is not a fact at all and should be skipped',
        'editor: Vim',
      ].join('\n'),
    )
    expect(labels.get('editor')).toBe('Nova')
    expect(labels.get('default region')).toBe('fra')
    expect(labels.get('docs')).toBe('https://example.invalid/x')
    expect(labels.has('summary')).toBe(false)
  })
})

describe('findCandidates', () => {
  const corpusLong = note('project/dispatch.md', 'how the dispatcher routes orders', LONG_A, {
    type: 'project',
  })

  test('key twin: same normalized key, different raw key', () => {
    const existing = note(
      'feedback/testing.md',
      'how tests are written',
      'Every rule gets a table case.',
    )
    const twin = note(
      'feedback/Testing.md',
      'what the smoke run checks',
      'The smoke run replays yesterday.',
    )
    expect(findCandidates(twin, [existing])).toEqual([
      { key: existing.key, description: existing.description, similarity: 1, reason: 'key-twin' },
    ])
    // The same raw key is an update, never a candidate.
    expect(findCandidates({ ...twin, key: existing.key }, [existing])).toEqual([])
  })

  test('duplicate and near-duplicate over long bodies via MinHash', () => {
    const copy = note('project/dispatch-copy.md', 'routing notes', LONG_A, { type: 'project' })
    expect(findCandidates(copy, [corpusLong])[0]).toMatchObject({
      key: corpusLong.key,
      reason: 'duplicate',
      similarity: 1,
    })
    const edited = note('project/dispatch-edited.md', 'routing notes', LONG_A_EDITED, {
      type: 'project',
    })
    const near = findCandidates(edited, [corpusLong])[0]
    expect(near).toMatchObject({ key: corpusLong.key, reason: 'near-duplicate' })
    expect(near.similarity).toBeGreaterThanOrEqual(NEAR_DUP)
    expect(near.similarity).toBeLessThan(DUP)
    const unrelated = note('project/ratelimit.md', 'throttling noisy callers', LONG_B, {
      type: 'project',
    })
    expect(findCandidates(unrelated, [corpusLong])).toEqual([])
  })

  test('same-topic on description cosine alone', () => {
    // Same stems as corpusLong's description, unrelated body, no cue words.
    const restated = note('project/routing.md', 'where the dispatcher routes an order', LONG_B, {
      type: 'project',
    })
    const found = findCandidates(restated, [...CORPUS_NOTES, corpusLong])
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ key: corpusLong.key, reason: 'same-topic' })
    expect(found[0].similarity).toBeGreaterThanOrEqual(SAME_TOPIC)
    // The stemmer splits `routes` from `routed`, and a two-note idf gives the
    // shared terms the lowest weight, so this looser restatement sits under
    // the bar against the fixture corpus: reported as nothing, not as a twin.
    const looser = note('project/routing.md', 'how orders are routed by the dispatcher', LONG_B, {
      type: 'project',
    })
    expect(findCandidates(looser, [...CORPUS_NOTES, corpusLong])).toEqual([])
  })

  test('possible-contradiction carries the overlap as similarity', () => {
    const fra = note('project/region.md', 'default deploy region', 'region: fra')
    const sin = note('project/deploy-region.md', 'deploy region for Quillrun', 'region: sin')
    const found = findCandidates(sin, [fra])
    expect(found).toHaveLength(1)
    expect(found[0].reason).toBe('possible-contradiction')
    expect(found[0].similarity).toBe(contradiction(sin, fra, buildIdf([sin, fra])).overlap)
  })

  test('hidden keys and the target key are never candidates', () => {
    const target = note(
      'feedback/testing.md',
      'how tests are written',
      'Every rule gets a table case.',
    )
    const corpus = [
      note('MEMORY.md', target.description, target.body),
      note('project/MEMORY.md', target.description, target.body),
      note('sys.openrecall/trash/feedback/testing.md', target.description, target.body),
      note('feedback/testing.md', target.description, target.body),
    ]
    expect(findCandidates(target, corpus)).toEqual([])
  })

  test('one reason per note, by priority', () => {
    const existing = note('feedback/testing.md', 'how tests are written', LONG_A)
    // Twin key AND verbatim body: duplicate outranks key-twin.
    const both = note('feedback/Testing.md', 'how tests are written', LONG_A)
    expect(findCandidates(both, [existing])).toEqual([
      { key: existing.key, description: existing.description, similarity: 1, reason: 'duplicate' },
    ])
    // Same description AND edited body: near-duplicate outranks same-topic.
    const near = note('feedback/tests.md', 'how tests are written', LONG_A_EDITED)
    expect(findCandidates(near, [existing])[0].reason).toBe('near-duplicate')
  })

  test('sorted by similarity, capped at limit (default 5)', () => {
    const target = note(
      'feedback/t.md',
      'how tests are written',
      'Every rule gets a table case with a sample order attached.',
    )
    const corpus = Array.from({ length: 8 }, (_, i) =>
      note(
        `feedback/t${i}.md`,
        'how tests are written',
        `Every rule gets a table case with a sample order attached${' and more words'.repeat(i)}.`,
      ),
    )
    const found = findCandidates(target, corpus)
    expect(found).toHaveLength(DEFAULT_LIMIT)
    for (let i = 1; i < found.length; i++)
      expect(found[i - 1].similarity).toBeGreaterThanOrEqual(found[i].similarity)
    expect(found[0].key).toBe('feedback/t0.md')
    expect(findCandidates(target, corpus, { limit: 2 })).toHaveLength(2)
    expect(findCandidates(target, corpus, { limit: 0 })).toEqual([])
  })

  test('the signature cache is consulted, not merely filled', () => {
    const copy = note('project/dispatch-copy.md', 'routing notes', LONG_A, { type: 'project' })
    const signatures = new Map<string, Uint32Array>()
    expect(findCandidates(copy, [corpusLong], { signatures })[0].reason).toBe('duplicate')
    expect(signatures.get(corpusLong.key)).toHaveLength(MINHASH_PERMS)
    expect(signatures.get(copy.key)).toHaveLength(MINHASH_PERMS)
    // A planted signature for the corpus note changes the verdict: the gate
    // trusted the cache instead of recomputing from the body.
    signatures.set(corpusLong.key, new Uint32Array(MINHASH_PERMS))
    expect(findCandidates(copy, [corpusLong], { signatures })).toEqual([])
  })

  test('the profile cache is consulted, not merely filled', () => {
    const existing = note(
      'feedback/testing.md',
      'how tests are written',
      'Every rule gets a table case.',
    )
    const copy = note('feedback/copy.md', existing.description, existing.body)
    const profiles = new Map<string, NoteProfile>()
    expect(findCandidates(copy, [existing], { profiles })[0].reason).toBe('duplicate')
    expect(profiles.has(existing.key)).toBe(true)
    // A stale profile under the same key is what the caller sees if it forgets
    // to invalidate: the verdict follows the cache, which is why the contract
    // says to drop the entry when the note changes.
    profiles.set(
      existing.key,
      profileNote(note(existing.key, 'deploy region', 'Ashfield cluster.')),
    )
    expect(findCandidates(copy, [existing], { profiles })).toEqual([])
  })
})

describe('corpus check', () => {
  const idf = buildIdf(CORPUS_NOTES)

  test('the measured numbers the thresholds are documented against', () => {
    let topCos: [number, string] = [0, '']
    let topJac: [number, string] = [0, '']
    for (let i = 0; i < CORPUS_NOTES.length; i++) {
      for (let j = i + 1; j < CORPUS_NOTES.length; j++) {
        const a = CORPUS_NOTES[i]
        const b = CORPUS_NOTES[j]
        const cos = descriptionCosine(a, b, idf)
        if (cos > topCos[0]) topCos = [cos, `${a.key} / ${b.key}`]
        const jac = exactTokenJaccard(a, b)
        if (jac > topJac[0]) topJac = [jac, `${a.key} / ${b.key}`]
      }
    }
    console.log(
      `[gate] corpus top description cosine ${topCos[0].toFixed(3)} (${topCos[1]}); top exact Jaccard ${topJac[0].toFixed(3)} (${topJac[1]})`,
    )
    // The comments on SAME_TOPIC / NEAR_DUP quote 0.33 and 0.11; a corpus edit
    // that moves either past a threshold must move the threshold's comment too.
    expect(topCos[1]).toBe('project/postgres-old.md / project/postgres-new.md')
    expect(topCos[0]).toBeLessThan(SAME_TOPIC)
    expect(topJac[0]).toBeLessThan(NEAR_DUP)
  })

  test('saving every corpus note against the rest flags only the superseded pair', () => {
    const flagged: Record<string, Candidate[]> = {}
    for (const target of CORPUS_NOTES) {
      const rest = CORPUS_NOTES.filter(n => n.key !== target.key)
      const found = findCandidates(target, rest)
      if (found.length > 0) flagged[target.key] = found
    }
    for (const [key, found] of Object.entries(flagged))
      console.log(
        `[gate] ${key} -> ${found.map(c => `${c.key} (${c.reason} ${c.similarity.toFixed(2)})`).join(', ')}`,
      )
    expect(Object.keys(flagged).sort()).toEqual([
      'project/postgres-new.md',
      'project/postgres-old.md',
    ])
    expect(flagged['project/postgres-old.md']).toHaveLength(1)
    expect(flagged['project/postgres-old.md'][0]).toMatchObject({
      key: 'project/postgres-new.md',
      reason: 'possible-contradiction',
    })
    expect(flagged['project/postgres-new.md']).toHaveLength(1)
    expect(flagged['project/postgres-new.md'][0]).toMatchObject({
      key: 'project/postgres-old.md',
      reason: 'possible-contradiction',
    })
    // And the reason is the one the cue list was extended for.
    const old = CORPUS_NOTES.find(n => n.key === 'project/postgres-old.md')!
    const current = CORPUS_NOTES.find(n => n.key === 'project/postgres-new.md')!
    expect(contradiction(old, current, idf).reason).toBe(
      'negation cues differ: superseded here, parked there',
    )
  })

  test('a light paraphrase of feedback/testing.md scores at or above NEAR_DUP', () => {
    const original = CORPUS_NOTES.find(n => n.key === 'feedback/testing.md')!
    const paraphrase = note(
      'feedback/test-rules.md',
      'how tests should be written',
      'Each routing rule needs a table case with a sample order attached.\nWhy: a rule without a sample order is untestable once the author forgets it.',
      { type: 'feedback', title: 'test-rules' },
    )
    const jac = exactTokenJaccard(original, paraphrase)
    const cos = descriptionCosine(original, paraphrase, buildIdf([...CORPUS_NOTES, paraphrase]))
    console.log(
      `[gate] paraphrase of feedback/testing.md: exact Jaccard ${jac.toFixed(3)}, description cosine ${cos.toFixed(3)}`,
    )
    expect(jac).toBeGreaterThanOrEqual(NEAR_DUP)
    const found = findCandidates(paraphrase, CORPUS_NOTES)
    expect(found[0]).toMatchObject({ key: 'feedback/testing.md', reason: 'near-duplicate' })
    expect(found).toHaveLength(1)

    // A copy with one content word changed clears DUP; two changed does not.
    const oneWord = note(
      'feedback/testing-copy.md',
      original.description,
      original.body.replace('forgets', 'leaves'),
      {
        type: 'feedback',
      },
    )
    const twoWords = note(
      'feedback/testing-copy.md',
      original.description,
      original.body.replace('forgets', 'leaves').replace('table', 'tabular'),
      {
        type: 'feedback',
      },
    )
    const j1 = exactTokenJaccard(original, oneWord)
    const j2 = exactTokenJaccard(original, twoWords)
    console.log(
      `[gate] copy of feedback/testing.md: one word changed ${j1.toFixed(3)}, two words ${j2.toFixed(3)}`,
    )
    expect(j1).toBeGreaterThanOrEqual(DUP)
    expect(j2).toBeLessThan(DUP)
    expect(j2).toBeGreaterThanOrEqual(NEAR_DUP)
    expect(findCandidates(oneWord, CORPUS_NOTES)[0].reason).toBe('duplicate')
  })

  // The twelve off-domain probes the recall floor was measured against. Five
  // are named in the floor comment in src/mcp/relevance.ts; the rest were
  // written for this file in the same five domains (cooking, geography,
  // sport, gardening, music), since the original list was never committed.
  const OFF_DOMAIN = [
    'how long should I braise short ribs in red wine',
    'which key is the moonlight sonata written in',
    'which river runs through Budapest',
    'when should I repot an orchid',
    'who won the 1994 world cup final',
    'what temperature do I bake sourdough at',
    'what is the capital of Mongolia',
    'how many players are on a rugby union side',
    'how often should tomatoes be watered in summer',
    'what tuning do most guitars use',
    'how do I keep basil from bolting',
    'which mountain range separates France and Spain',
  ]

  test('the 12 off-domain probes saved as notes flag nothing', () => {
    expect(OFF_DOMAIN).toHaveLength(12)
    const prefixes = ['user', 'feedback', 'project', 'reference', 'agent']
    OFF_DOMAIN.forEach((probe, i) => {
      const prefix = prefixes[i % prefixes.length]
      const probeNote = note(
        `${prefix}/probe-${i + 1}.md`,
        probe,
        `${probe}? Nobody on the team knows.`,
        {
          ...(TYPES.has(prefix) ? { type: prefix } : {}),
          title: `probe-${i + 1}`,
        },
      )
      expect(`${probe} -> ${JSON.stringify(findCandidates(probeNote, CORPUS_NOTES))}`).toBe(
        `${probe} -> []`,
      )
    })
  })
})

describe('scale', () => {
  const big = Object.entries(nearCapCorpus(2000)).map(([key, content]) => toGateNote(key, content))
  const target = big[1234]

  test('a gate call over 2,000 cached notes stays under 20 ms', () => {
    const profiles = new Map<string, NoteProfile>()
    const signatures = new Map<string, Uint32Array>()
    findCandidates(target, big, { profiles, signatures }) // warm the caches
    expect(profiles.size).toBe(1999)
    const times: number[] = []
    for (let i = 0; i < 5; i++) {
      const started = performance.now()
      findCandidates(target, big, { profiles, signatures })
      times.push(performance.now() - started)
    }
    times.sort((a, b) => a - b)
    const median = times[2]
    console.log(`[gate] 2000 notes, cached profiles: ${median.toFixed(1)}ms (budget 20ms)`)
    expect(`${median < 20} @ ${median.toFixed(1)}ms`).toBe(`true @ ${median.toFixed(1)}ms`)
  })

  test('the generated filler is not reported as the same topic as itself', () => {
    // Generated notes share "generated note N about the X layer", which is
    // exactly the shape of a namespace full of similar-looking notes. The
    // body check still fires on the near-identical filler bodies, which is
    // correct; the description cosine must not, because only the number
    // differs and idf has learned the rest is boilerplate.
    const profiles = new Map<string, NoteProfile>()
    const found = findCandidates(target, big, { profiles, limit: 2000 })
    expect(found.some(c => c.reason === 'same-topic')).toBe(false)
  })
})

describe('renderNeedsDecision', () => {
  const candidates: Candidate[] = [
    {
      key: 'feedback/testing.md',
      description: 'how tests are expected to be written',
      similarity: 0.8125,
      reason: 'near-duplicate',
    },
    {
      key: 'project/postgres-old.md',
      description: 'superseded note about the datastore',
      similarity: 0.4,
      reason: 'possible-contradiction',
    },
  ]

  test('the protocol text', () => {
    const text = renderNeedsDecision(
      'feedback/test-rules.md',
      'repo:quillrun/dispatch',
      candidates,
      {},
    )
    const lines = text.split('\n')
    expect(lines[0]).toBe(
      'needs_decision: "feedback/test-rules.md" was NOT saved; 2 existing entries look related in repo:quillrun/dispatch:',
    )
    expect(lines[1]).toBe(
      '1. feedback/testing.md — how tests are expected to be written (similarity 0.81, near-duplicate)',
    )
    expect(lines[2]).toBe(
      '2. project/postgres-old.md — superseded note about the datastore (similarity 0.40, possible-contradiction)',
    )
    expect(lines[3]).toBe(RESAVE_MODES_LINE)
    expect(lines).toHaveLength(4)
    for (const mode of ['"update"', '"supersede"', '"add"', '"noop"', 'supersedes: "<old key>"'])
      expect(lines[3]).toContain(mode)
  })

  test('singular for one candidate', () => {
    const text = renderNeedsDecision('k.md', 'user:x', candidates.slice(0, 1), {})
    expect(
      text.startsWith(
        'needs_decision: "k.md" was NOT saved; 1 existing entry looks related in user:x:',
      ),
    ).toBe(true)
  })

  test('descriptions are clipped to 120 characters on one line', () => {
    const long = { ...candidates[0], description: `${'word '.repeat(40)}\nsecond line` }
    const line = renderNeedsDecision('k.md', 'user:x', [long], {}).split('\n')[1]
    const shown = /— (.*) \(similarity/.exec(line)![1]
    expect(shown.length).toBeLessThanOrEqual(DESCRIPTION_CLIP)
    expect(shown.endsWith('…')).toBe(true)
    expect(shown).not.toContain('\n')
  })

  test('bounded to maxChars by dropping candidates from the end, with a count', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      ...candidates[0],
      key: `feedback/note-${i}.md`,
      description: 'x'.repeat(DESCRIPTION_CLIP),
    }))
    const full = renderNeedsDecision('k.md', 'user:x', many, {})
    expect(full.length).toBeGreaterThan(600)
    const bounded = renderNeedsDecision('k.md', 'user:x', many, { maxChars: 600 })
    expect(bounded.length).toBeLessThanOrEqual(600)
    expect(bounded).toContain('feedback/note-0.md')
    expect(bounded).toMatch(/… \d+ more not shown/)
    expect(bounded.endsWith(RESAVE_MODES_LINE)).toBe(true)
    // Default bound is 4,000 and holds for a full page of candidates.
    expect(
      renderNeedsDecision('k.md', 'user:x', [...many, ...many, ...many], {}).length,
    ).toBeLessThanOrEqual(4000)
  })
})
