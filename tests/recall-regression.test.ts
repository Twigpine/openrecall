/**
 * Recall regression harness.
 *
 * This suite is the evidence trail for the recall work: it pins what the ranker
 * does today so every later unit has a mechanical flip to point at instead of an
 * impression. Pairs the current ranker already answers are hard assertions and
 * must stay green forever. Pairs it got wrong that phase 1 was to fix carried a
 * `test.failing` marker naming the unit set that closes them; bun runs a failing
 * test's body under plain `bun test`, so a marker turns red the moment its body
 * starts passing, which is exactly the signal we want. That is how the push pair
 * was promoted to a hard assertion once U2 and U3 landed, and no marker is
 * outstanding now. `test.todo` is deliberately not used: its body never executes
 * under the bare `bun test` that CI runs, so it would prove nothing. Pairs phase
 * 1 does not close are reported rather than marked, because a marker that can
 * never flip is noise.
 *
 * Match arity is pinned separately, below the tuning set: a corpus edit that
 * quietly drops how many query terms a target carries breaks these pairs in a
 * way the pair assertions themselves cannot name.
 *
 * The suite also carries the two boundary checks that have no other home: the
 * crypto-blind import rule (nothing under `src/` outside `src/mcp/` may reach
 * plaintext code) and the wire rule (the tools talk to exactly one host, and
 * nothing they send it carries plaintext). Corpus and probes live in
 * `tests/recall-corpus.ts`.
 *
 * Explicit non-guarantee: the held-out pass rate printed here is a baseline for
 * comparison inside this repo only. It is not a relevance benchmark, it is not
 * asserted all-green during phase 1, and a run that improves it has not thereby
 * proven the ranker good in general.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { ciphertextHash, MemlawbClient } from '../client/index.ts'
import { rankMemories, stemTerm } from '../src/mcp/relevance.ts'
import { makeTools } from '../src/mcp/tools.ts'
import { makeStubClient } from './mcp-tools.test.ts'
import {
  BASELINE_RANK_MS,
  CORPUS,
  contentTerms,
  HELD_OUT,
  nearCapCorpus,
  STOPWORDS,
  sharedTerms,
  TUNING,
} from './recall-corpus.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')
const NS = 'user:recall-fixture'

const pairFor = (query: string) => {
  const p = TUNING.find(t => t.query === query)
  if (!p) throw new Error(`no tuning pair for ${query}`)
  return p
}

/** Same lookup, narrowed to the pairs that name an expected entry (all but the tie residual). */
const keyPairFor = (query: string) => {
  const p = pairFor(query)
  if (p.expect === null) throw new Error(`tuning pair has no expected entry: ${query}`)
  return { query: p.query, expect: p.expect }
}

/**
 * The one stub, imported rather than re-declared. A second hand-rolled stand-in
 * lived here and answered `push` differently from both the real client and the
 * stub in tests/mcp-tools.test.ts; each reached `makeTools` behind an
 * `as unknown as MemlawbClient` cast, which is precisely what let them disagree.
 * `makeTools` now takes the structural `MemoryClient`, so this is type-checked.
 * The corpus still never goes near the wire.
 */
const stubClient = (entries: Record<string, string>) => makeStubClient(entries)

describe('recall tuning set (current ranker)', () => {
  // Guard for the markers below, and the reason it is a plain test: bun's
  // `test.failing` accepts ANY throw as the expected failure, and every marker
  // resolves its query through keyPairFor inside the failing body. A
  // one-character edit to a TUNING query would therefore leave the suite green
  // while permanently decoupling that marker from the ranker. Resolving every
  // literal this file hands to keyPairFor makes that drift a hard red here.
  test('every query literal a test looks up still exists in the tuning set', () => {
    const src = readFileSync(join(REPO_ROOT, 'tests/recall-regression.test.ts'), 'utf8')
    const literals = [...src.matchAll(/keyPairFor\(\s*'([^']*)'/g)].map(m => m[1])
    // Non-vacuous: the four hard-asserted pairs, one lookup each.
    expect(literals.length).toBeGreaterThanOrEqual(4)
    for (const q of literals) {
      expect(`${q} :: ${TUNING.some(p => p.query === q)}`).toBe(`${q} :: true`)
    }
  })

  // The control pair. An exact-term query against the entry whose description
  // carries those exact terms is the one shape today's ranker handles well, so
  // this is green before U2 and must stay green after every later unit.
  test('an exact-term query ranks its own entry first', () => {
    const p = keyPairFor('namespace validation rules')
    expect(rankMemories(p.query, CORPUS)[0].key).toBe(p.expect)
  })

  // Today "deployment" matches no entry (no stemming) while "process" matches
  // the in-process lock note, so the ranker answers a deployment question with
  // a datastore note. A wrong answer delivered confidently is worse than none.
  test('closed by {U2}: "deployment process" ranks the deploy note first', () => {
    const p = keyPairFor('deployment process')
    expect(rankMemories(p.query, CORPUS)[0]?.key).toBe(p.expect)
  })

  // The rule says "opening PRs"; the query says "open a pull request". Unstemmed
  // those are different tokens and no entry in the corpus carries "open", so the
  // query returned nothing at all and the rule that answers it was never seen.
  test('closed by {U2}: "am I allowed to open a pull request" finds the rule', () => {
    const p = keyPairFor('am I allowed to open a pull request')
    expect(rankMemories(p.query, CORPUS)[0]?.key).toBe(p.expect)
  })

  // The rule covers three of the query's four content terms ("needs", "push",
  // "work"); the competitors reach one each. Unstemmed, "push" does not meet
  // "Pushing" and the entry falls back to a one-term tie the key sort decides,
  // so stemming is what lifts it and rarity weighting is what keeps a common
  // term from pulling a competitor level again.
  test('closed by {U2, U3}: the push query beats the one-term tie', () => {
    const p = keyPairFor('what do I need to do before I push my work to the remote')
    expect(rankMemories(p.query, CORPUS)[0]?.key).toBe(p.expect)
  })
})

/**
 * Match arity: how many of a query's content terms its expected entry actually
 * carries. Nothing pinned this, and three separate units have now each lost a
 * day to the same failure. The corpus was rewritten into fiction under a brief
 * that named its load-bearing properties (shared tokens, the repeated "Why:"
 * lines, one unstemmed token) and preserved every one of them, while silently
 * dropping targets from three matched terms to one. A pair whose target and
 * competitors all match a single term is not the pair that was measured: it is
 * decided by `localeCompare` on the key, so it passes or fails on alphabetical
 * accident and no ranking unit can move it.
 *
 * The pin is the count, never the score. Scores move every time a weight is
 * tuned, which is the work these units exist to do; the number of query terms a
 * target carries is a property of the fixture text alone, so pinning it turns a
 * silent corpus rewrite into a red test naming the exact pair it damaged.
 *
 * Terms come from `contentTerms` with the ranker's own `stemTerm` injected, over
 * the stoplist the suite already asserts equal to the ranker's. A private
 * tokenizer here would drift from the ranker exactly the way the corpus module's
 * own stemmer did before it was deleted, and would then measure something else
 * while still reading as if it did the job.
 */
describe('tuning-pair match arity', () => {
  /**
   * Query -> how many of its content terms the expected entry carries. Measured,
   * not chosen: these are the arities the original probe run recorded. Raising
   * one is a corpus improvement and needs the number here updated with it;
   * a drop is the defect this guard exists to catch.
   */
  const TARGET_ARITY: Record<string, number> = {
    'namespace validation rules': 3,
    'deployment process': 1,
    'am I allowed to open a pull request': 2,
    'what do I need to do before I push my work to the remote': 3,
  }

  /**
   * The one pair allowed to tie a competitor on term count. "deployment process"
   * is the stemming trap: the deploy note deliberately never carries the query's
   * own token "process" (the datastore note's "in-process" lock does), which is
   * the whole reason the pair returned a datastore answer before stemming. It
   * wins on field weighting instead, with "deploy" in its key, its description
   * and its body against a bare link in the index. Writing "process" into it
   * would both destroy the trap and copy the query into its own answer.
   */
  const TIE_ALLOWED = new Set(['deployment process'])

  /** Non-residual pairs that name an expected entry: everything this guard covers. */
  const pairs = TUNING.filter(p => !p.residual && p.expect !== null).map(p => ({
    query: p.query,
    expect: p.expect as string,
  }))

  /**
   * Where each matched term sits, per pair. A count alone is blind to the field
   * a match came from, and the ranker is not: a description match is worth 3, a
   * key match 2, a body match 1 plus its term frequency. So an entry that loses
   * its frontmatter `description:` line keeps every one of its matched terms —
   * the words are still in the body — while its score collapses and the pair it
   * anchors starts passing or failing on something else. Recording placement
   * turns that into a red naming the term and the field it fell out of.
   */
  const TARGET_PLACEMENT: Record<string, string[]> = {
    'namespace validation rules': [
      'namespace=description+key+body',
      'rule=description+body',
      'valid=description+body',
    ],
    // The one description-only anchor among the four: "deploy" is the whole
    // reason this pair beats the datastore note without ever carrying the
    // query's own token "process", so losing the description line is exactly
    // the damage that the arity count alone would not show.
    'deployment process': ['deploy=description+key+body'],
    'am I allowed to open a pull request': ['open=body', 'request=body'],
    'what do I need to do before I push my work to the remote': [
      'need=body',
      'push=body',
      'work=body',
    ],
  }

  /**
   * The ranker's own frontmatter extraction, lifted out of its source. Same
   * reason the stoplist is parsed rather than imported: `frontmatterDescription`
   * is not exported from src/mcp/relevance.ts and this unit may not change
   * src/. A second hand-written copy here would drift from the ranker exactly
   * the way the corpus module's private stemmer did, and would then measure a
   * description the ranker never saw.
   */
  const FM_SOURCE = /function frontmatterDescription\([\s\S]*?\n}/.exec(
    readFileSync(join(REPO_ROOT, 'src/mcp/relevance.ts'), 'utf8'),
  )
  const FM_LITERALS = [
    ...(FM_SOURCE?.[0] ?? '').matchAll(/\/((?:\\.|\[[^\]]*\]|[^/\\\n])+)\/([gimsuy]*)/g),
  ].map(m => new RegExp(m[1], m[2]))

  const descriptionOf = (content: string): string => {
    const block = FM_LITERALS[0].exec(content)
    if (!block) return ''
    const d = FM_LITERALS[1].exec(block[1])
    return d ? d[1] : ''
  }

  /** The three fields the ranker scores separately, as the ranker splits them. */
  const fieldsOf = (key: string) => ({
    description: contentTerms(descriptionOf(CORPUS[key]), stemTerm),
    key: contentTerms(key, stemTerm),
    body: contentTerms(CORPUS[key], stemTerm),
  })

  /** `term=field[+field]` for every query term this entry carries, sorted. */
  const placementOf = (query: string, key: string): string[] => {
    const f = fieldsOf(key)
    const out: string[] = []
    for (const t of [...contentTerms(query, stemTerm)].sort()) {
      const where = (['description', 'key', 'body'] as const).filter(w => f[w].has(t))
      if (where.length) out.push(`${t}=${where.join('+')}`)
    }
    return out
  }

  /**
   * Matched-term counts for one pair: the target's, and the best any other
   * entry reaches. MEMORY.md is not in the competitor set because it is not in
   * the ranker's candidate set either (U4 drops the namespace-root index before
   * anything is scored), so counting it here measured a competitor that can
   * never win.
   */
  function arityOf(query: string, expected: string) {
    const qTerms = contentTerms(query, stemTerm)
    const matched = (key: string) => placementOf(query, key).length
    const others = Object.keys(CORPUS).filter(k => k !== expected && k !== 'MEMORY.md')
    return {
      qTerms: qTerms.size,
      target: matched(expected),
      best: Math.max(...others.map(matched)),
    }
  }

  test('the ranker frontmatter extraction was found and does extract a description', () => {
    // Fail loudly rather than vacuously: an unparseable extraction must not read
    // as "no entry has a description", which would make every placement `body`.
    expect(`frontmatter extraction found:${FM_SOURCE !== null}`).toBe(
      'frontmatter extraction found:true',
    )
    expect(FM_LITERALS.length).toBe(2)
    expect(descriptionOf(CORPUS['project/deploy.md'])).toContain('deploy')
    expect(descriptionOf('no frontmatter here')).toBe('')
  })

  test('each expected entry carries its query terms in the pinned fields', () => {
    expect(Object.keys(TARGET_PLACEMENT).sort()).toEqual(pairs.map(p => p.query).sort())
    for (const p of pairs) {
      const got = placementOf(p.query, p.expect)
      expect(`${p.query} :: ${got.join(' ')}`).toBe(
        `${p.query} :: ${TARGET_PLACEMENT[p.query].join(' ')}`,
      )
    }
  })

  // Non-vacuity, both directions: the pin table must cover exactly the pairs the
  // assertions below iterate, so a pair added to TUNING cannot slip past
  // unpinned and a pin cannot survive the pair it describes being deleted.
  test('every non-residual tuning pair is pinned, and every pin has a pair', () => {
    expect(pairs.length).toBeGreaterThanOrEqual(4)
    expect(pairs.map(p => p.query).sort()).toEqual(Object.keys(TARGET_ARITY).sort())
    // The exemption is a single named pair, not a list that can grow quietly.
    expect([...TIE_ALLOWED]).toEqual(['deployment process'])
  })

  test('each expected entry carries the pinned number of query content terms', () => {
    for (const p of pairs) {
      const a = arityOf(p.query, p.expect)
      expect(`${p.query} :: arity=${a.target}`).toBe(`${p.query} :: arity=${TARGET_ARITY[p.query]}`)
      // A pair whose query tokenizes to nothing would pin an arity of 0 happily.
      expect(`${p.query} :: qterms=${a.qTerms > 0} arity=${a.target > 0}`).toBe(
        `${p.query} :: qterms=true arity=true`,
      )
    }
  })

  test('each expected entry outmatches every competitor on matched terms', () => {
    for (const p of pairs) {
      const a = arityOf(p.query, p.expect)
      const beats = TIE_ALLOWED.has(p.query) ? a.target >= a.best : a.target > a.best
      expect(`${p.query} :: target=${a.target} best-other=${a.best} beats=${beats}`).toBe(
        `${p.query} :: target=${a.target} best-other=${a.best} beats=true`,
      )
    }
  })
})

describe('recall residuals (not closed by phase 1)', () => {
  // These three are reported, never marked. Phase 1 adds stemming, rarity
  // weighting, soft coverage and index exclusion; none of that bridges a
  // synonym ("response" vs "answers"), collapses a tie every entry is equally
  // entitled to, or knows that one note supersedes another. Asserting them
  // would be asserting work nobody planned; marking them test.failing would
  // promise a flip that phase 1 cannot deliver.
  test('reports each accepted residual and its current top hits', () => {
    const residuals = TUNING.filter(p => p.residual)
    for (const p of residuals) {
      const top = rankMemories(p.query, CORPUS, 3)
        .map(r => `${r.key}:${r.score.toFixed(3)}`)
        .join(' | ')
      console.log(
        `[residual] ${JSON.stringify(p.query)} want=${p.expect ?? '(a clear winner)'} got=${top || '(nothing)'} (${p.note})`,
      )
    }
    // The pin is that residuals are declared and enumerated, not their count or
    // their outcome: a later unit closing one early is good news, not a
    // regression, and the postgres pair is a tie rather than a wrong top-1, so
    // a top-1 assertion would misreport it either way.
    expect(residuals.length).toBeGreaterThan(0)
  })

  // The "Why:" line repeated across notes is the tie generator. Report its
  // width so U3's effect on tie breadth is visible run over run.
  //
  // The assertion moved at U3, and upward rather than downward. It used to be
  // `tied.length > 1`, a non-vacuity guard on a tie that existed at the time.
  // U3's floor cuts the whole 18-wide tie: every tied entry matched one common
  // term at a score far below the query's own weak top, so the ranking is now
  // empty. That is this pair's declared expectation (`expect: null`, "nothing
  // should rank"), so the pin is the pair's own contract instead of the width
  // of a tie that no longer reaches the caller. The width log stays, because
  // the tie is still there underneath the floor and later units can move it.
  test('reports the width of the conventions tie', () => {
    const p = pairFor('why do we hold these conventions')
    expect(p.expect).toBeNull()
    const ranked = rankMemories(p.query, CORPUS, Object.keys(CORPUS).length)
    const topScore = ranked[0]?.score ?? 0
    const tied = ranked.filter(r => r.score === topScore)
    console.log(`[residual] conventions tie width=${tied.length} at score ${topScore.toFixed(3)}`)
    expect(ranked.map(r => r.key)).toEqual([])
  })
})

describe('held-out set (paraphrase probes)', () => {
  // The floor is what makes the set held out in any meaningful sense: a query
  // that restates a sentence from its target passes for any lexical ranker and
  // tests nothing. At most one shared content term post-stemming forces every
  // pair to be a genuine paraphrase, and asserting it here means the property
  // is machine-enforced rather than a matter of authoring discipline.
  test('every pair shares at most one content term with its target', () => {
    for (const p of HELD_OUT) {
      const body = CORPUS[p.expect]
      expect(body).toBeDefined()
      const shared = sharedTerms(p.query, p.expect, body, stemTerm)
      expect(`${p.query} :: ${shared.join(',')}`).toBe(
        `${p.query} :: ${shared.slice(0, 1).join(',')}`,
      )
    }
  })

  test('has at least ten pairs', () => {
    expect(HELD_OUT.length).toBeGreaterThanOrEqual(10)
  })

  // Printed, because the number itself is what later units are compared
  // against, and ratcheted, because a printed number gates nothing: a ranker
  // that regressed to returning nothing at all used to produce an identical
  // green run here.
  //
  // BASELINE: 4 of 12 top-1 correct, measured 2026-08-06 against the current
  // ranker and the corpus in its present (fictional Quillrun) form. This is a
  // FLOOR. Later units raise it as they land. It is never lowered to let a
  // regression through: if a change drops the rate, the change is what is
  // wrong, not this number. Still not asserted all-green, because phase 1 is
  // not expected to close every pair.
  const HELD_OUT_BASELINE = 4

  test('reports the held-out pass rate and holds it at or above the baseline', () => {
    const passed = HELD_OUT.filter(p => rankMemories(p.query, CORPUS)[0]?.key === p.expect)
    const rate = ((passed.length / HELD_OUT.length) * 100).toFixed(0)
    console.log(`[held-out] ${passed.length}/${HELD_OUT.length} (${rate}%) top-1 correct`)
    expect(HELD_OUT.length).toBeGreaterThan(0)
    expect(passed.length).toBeGreaterThanOrEqual(HELD_OUT_BASELINE)
  })
})

describe('index exclusion at the recall surface', () => {
  // The ranker-level cases live in tests/relevance.test.ts; these two are here
  // because they are about what the caller sees. The first is the degenerate
  // namespace: the index is the only entry, ranking is empty, and recall has to
  // render that as its no-match message rather than throw or hand back an empty
  // success. The second is the layer constraint: the exclusion belongs to the
  // ranker alone, and `search` is a substring tool that must go on finding the
  // index (the exact-output pin below is the byte-level half of that).
  test('a namespace holding only the index recalls as no-match, not an error', async () => {
    const tools = makeTools(stubClient({ 'MEMORY.md': CORPUS['MEMORY.md'] }), NS)
    const r = await tools.recall('roadmap onboarding escalation')
    expect(r.isError).toBeUndefined()
    // The index is not a candidate, so nothing was searched. Reporting that as
    // "0 entries searched, 0 below the relevance floor" read as an empty
    // namespace, which this is not: the one entry here is the table of contents
    // naming everything that was ever written, and recall has to say so and
    // name the tool that reads it.
    expect(r.text).toBe(
      `(nothing in ${NS} was searched for "roadmap onboarding escalation": ` +
        'the namespace holds only its MEMORY.md index, which recall does not rank. ' +
        'Call memory_get with key "MEMORY.md" to read the index itself.)',
    )
    // Distinct from the empty-namespace message, which this is not.
    expect(r.text).not.toContain('no memory stored')
    // And distinct from a real miss: nothing was searched, so nothing was
    // withheld and nothing licenses concluding the fact is unrecorded.
    expect(r.text).not.toContain('0 entries searched')
    expect(r.text).not.toContain('unrecorded')
  })

  test('recall never returns the index while search still finds it', async () => {
    const tools = makeTools(stubClient(CORPUS), NS)
    const recalled = await tools.recall('commit style tone planning review', undefined, 20)
    expect(recalled.text).not.toContain('### MEMORY.md')
    const searched = await tools.search('MEMORY.md')
    expect(searched.text).toContain('- MEMORY.md:')
  })
})

describe('recall returns a region, not a body', () => {
  // The must-pass shape for U6 against the real fixture corpus: a one-line fact
  // comes back as the matching region, with the entry key intact and the
  // frontmatter (which the ranker reads but the caller never asked for) gone.
  test('a one-line fact comes back as its region, key kept and frontmatter dropped', async () => {
    const tools = makeTools(stubClient(CORPUS), NS)
    const r = await tools.recall('deployment process')
    expect(r.isError).toBeUndefined()
    expect(r.text).toContain('### project/deploy.md')
    expect(r.text).toContain('Ashfield cluster')
    expect(r.text).not.toContain('description: how we deploy')
    expect(r.text).not.toContain('name: deploy')
  })

  // Aggregate bound at the surface, over the fixture corpus rather than a
  // synthetic one: 20 hits of real entries still fit the recall budget.
  test('a broad limit-20 recall over the corpus stays bounded', async () => {
    const tools = makeTools(stubClient(CORPUS), NS)
    const r = await tools.recall('commit style tone planning review', undefined, 20)
    expect(r.text.length).toBeLessThan(6000)
  })
})

describe('search output (pinned baseline)', () => {
  // Exact output, not toContain. U6 changes what recall returns and must leave
  // search byte-identical; a loose assertion would let a shared formatting
  // helper drift under it unnoticed. tests/mcp-tools.test.ts covers search
  // against a real server, so this one runs over a stub client: the corpus is
  // far past the caps tests/setup.ts pins, and it must never reach the wire.
  test('search over the corpus returns exactly the pinned string', async () => {
    const tools = makeTools(stubClient(CORPUS), NS)
    const r = await tools.search('postgres')
    expect(r.isError).toBeUndefined()
    expect(r.text).toBe(
      '3 match(es) for "postgres" in user:recall-fixture:\n' +
        '- MEMORY.md: # index - [deploy](project/deploy.md) - [datastore, current](project/postgres-new.md) - [datastore, superseded](project/postgres-old.md) - [stack](project/stack.md) - [ci](project/ci.md) - [release](p…\n' +
        '- project/postgres-old.md: --- name: postgres-old description: superseded note about the datastore --- Dated 2026-01-04. We are planning to move the routing table into Postgres so two dispatchers can share it.\n' +
        '- project/postgres-new.md: --- name: postgres-new description: current decision about the datastore --- The Postgres migration is parked. A single dispatcher with an in-process lock is correct for now, and we revisit it when a …',
    )
  })
})

/** package.json, read once so a self-referencing bare specifier can be resolved. */
const PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  name: string
  exports: Record<string, string>
  /** Never present: a subpath-imports map is a second way a bare specifier
   * resolves into the repo, and `resolveSelf` only follows `exports`. */
  imports?: unknown
}

/**
 * Source with comments removed and strings, templates and regex literals left
 * intact. Both source scans below fail closed on a suspicious token, so a doc
 * comment that merely *discusses* `import(` or `process.env` would otherwise
 * turn a guard red for prose. Stripping first means the guards read code only.
 */
function stripComments(src: string): string {
  // A `/` after a value is division; after an operator or an opener it starts a
  // regex literal. Tracking the previous significant character is enough to tell
  // them apart here, and getting it wrong would let a regex body be re-read as a
  // string or a comment.
  const regexCanStart = /[=(,:[!&|?{};+\-*%~^<>]/
  let out = ''
  let prev = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (
      c === "'" ||
      c === '"' ||
      c === '`' ||
      (c === '/' && (prev === '' || regexCanStart.test(prev)))
    ) {
      const closer = c === '/' ? '/' : c
      out += c
      i++
      while (i < src.length) {
        if (src[i] === '\\') {
          out += src.slice(i, i + 2)
          i += 2
          continue
        }
        out += src[i]
        i++
        if (src[i - 1] === closer) break
      }
      prev = closer
      continue
    }
    out += c
    if (!/\s/.test(c)) prev = c
    i++
  }
  return out
}

/**
 * Source reduced to code alone: comments removed, string / template / regex
 * bodies blanked, `${...}` interpolations kept because they are code.
 *
 * `stripComments` above deliberately keeps string bodies, because the import
 * scan needs the specifiers out of them. The guards below need the opposite:
 * they read identifiers, and fixture prose, tool descriptions and error
 * messages legitimately contain any word at all. Scanning identifiers over
 * un-blanked strings would make them fire on text and, worse, would let a
 * violation hide inside a string that a later `eval` reads back.
 */
function stripToCode(src: string): string {
  const regexCanStart = /[=(,:[!&|?{};+\-*%~^<>]/
  let out = ''
  let prev = ''
  let i = 0
  // Template nesting: an entry per `${` currently open, so the closing `}`
  // returns to template text rather than being read as a block end.
  let interpolations = 0
  // Scan template text from `i`, stopping at the closing backtick or at `${`.
  const scanTemplate = () => {
    while (i < src.length) {
      if (src[i] === '\\') {
        i += 2
        continue
      }
      if (src[i] === '`') {
        i++
        return
      }
      if (src[i] === '$' && src[i + 1] === '{') {
        i += 2
        interpolations++
        return
      }
      i++
    }
  }
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === '}' && interpolations > 0) {
      interpolations--
      i++
      scanTemplate()
      out += ' 0 '
      prev = 'x'
      continue
    }
    if (c === "'" || c === '"') {
      const q = c
      i++
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2
          continue
        }
        const ch = src[i]
        i++
        if (ch === q) break
      }
      out += ' 0 '
      prev = 'x'
      continue
    }
    if (c === '`') {
      i++
      scanTemplate()
      out += ' 0 '
      prev = 'x'
      continue
    }
    if (c === '/' && (prev === '' || regexCanStart.test(prev))) {
      i++
      let inClass = false
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2
          continue
        }
        if (src[i] === '\n') break
        if (src[i] === '[') inClass = true
        else if (src[i] === ']') inClass = false
        else if (src[i] === '/' && !inClass) {
          i++
          break
        }
        i++
      }
      while (i < src.length && /[a-z]/.test(src[i])) i++
      out += ' 0 '
      prev = 'x'
      continue
    }
    out += c
    if (!/\s/.test(c)) prev = c
    i++
  }
  return out
}

/**
 * Reserved words and type-position words, excluded from identifier scanning.
 * `import` and `require` are deliberately absent from every allowlist below and
 * are checked separately: the module graph is the one thing no file is allowed
 * to reach for in a way the walker cannot follow.
 */
const KEYWORDS = new Set(
  (
    'abstract any as asserts async await bigint boolean break case catch class const constructor ' +
    'continue declare default delete do else enum export extends false finally for function get ' +
    'if implements in infer instanceof interface is keyof let new null number object of out ' +
    'override package private protected public readonly return satisfies set static string super ' +
    'switch symbol this throw true try type typeof undefined unique unknown var void while with ' +
    'yield never global'
  ).split(' '),
)

/** True when the identifier starting at `at` is a property access (`x.y`, `x?.y`). */
function isMemberAccess(code: string, at: number): boolean {
  let i = at - 1
  while (i >= 0 && /\s/.test(code[i])) i--
  return i >= 0 && code[i] === '.'
}

/** Every identifier in `code` that is not a property name and not a keyword. */
function freeIdentifiers(code: string): string[] {
  const out: string[] = []
  for (const m of code.matchAll(/[A-Za-z_$][\w$]*/g)) {
    if (isMemberAccess(code, m.index)) continue
    if (KEYWORDS.has(m[0])) continue
    out.push(m[0])
  }
  return out
}

/**
 * Identifiers in callee or receiver position: `x(`, `new x(`, `x.y(`. Every way
 * of loading a module is one of these, so this is the position where an
 * unaccounted-for capability shows up, and restricting to it keeps object keys
 * and type names out of the way.
 */
function calleeRoots(code: string): string[] {
  const out: string[] = []
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*(?=[(.])/g)) {
    if (isMemberAccess(code, m.index)) continue
    if (KEYWORDS.has(m[1])) continue
    out.push(m[1])
  }
  return out
}

/**
 * Names a file binds itself: imports, declarations, destructuring, parameters,
 * method names. Deliberately generous — a name wrongly counted as local only
 * costs a missed report, while a name wrongly counted as global would turn the
 * guard red on ordinary code and get it weakened. Whatever this misses lands in
 * the pinned allowlists below, where it is visible.
 */
function declaredNames(code: string): Set<string> {
  const names = new Set<string>()
  const add = (s: string) => {
    for (const n of s.match(/[A-Za-z_$][\w$]*/g) ?? []) names.add(n)
  }
  for (const m of code.matchAll(
    /\b(?:const|let|var|function|class|enum|interface|type)\s+([A-Za-z_$][\w$]*)/g,
  ))
    names.add(m[1])
  for (const m of code.matchAll(/\b(?:const|let|var)\s*([{[][^=]*?[}\]])\s*=/g)) add(m[1])
  for (const m of code.matchAll(/\bimport\s+([\s\S]*?)\s+from\b/g))
    add(m[1].replace(/\btype\b/g, ''))
  for (const m of code.matchAll(/\(([^()]*)\)\s*(?::[^=({]*)?=>/g)) add(m[1].replace(/:[^,]*/g, ''))
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1])
  for (const m of code.matchAll(
    /\b(?:function\s*[A-Za-z_$\w]*|[A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*(?::[^{]*)?\{/g,
  ))
    add(m[1].replace(/:[^,]*/g, ''))
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([^;]*?)\s+of\b/g)) add(m[1])
  // Method and standalone function definitions, plus every `name:` binding at
  // the head of a line (parameter lists whose types carry their own parens).
  for (const m of code.matchAll(
    /^[ \t]*(?:export\s+|async\s+|static\s+|private\s+|public\s+|protected\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/gm,
  ))
    names.add(m[1])
  for (const m of code.matchAll(/^[ \t]*([A-Za-z_$][\w$]*)\s*\??\s*:/gm)) names.add(m[1])
  // Parameter lists whose own type annotations carry parens (`fn: () => T`),
  // which the flat regexes above cannot span. A paren group counts only when a
  // body or an arrow follows it, so an argument list is never mistaken for one
  // — treating `getStore(Bun.file(p))` as a declaration site would hand back
  // exactly the free-global blindness this guard exists to remove.
  let depth = 0
  let start = 0
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '(') {
      if (depth === 0) start = i + 1
      depth++
    } else if (code[i] === ')') {
      depth = Math.max(0, depth - 1)
      if (depth === 0 && /^\s*(?::[^{;=]*)?(?:\{|=>)/.test(code.slice(i + 1, i + 160)))
        add(code.slice(start, i).replace(/:[^,]*/g, ''))
    }
  }
  return names
}

const DYNAMIC_CALL = /\b(?:import|require)\s*\(/g
const DYNAMIC_LITERAL = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g

/**
 * Static import / export-from / bare-import / literal-`import()` forms, matched
 * whole so they can be removed before the module-graph token sweep below. An
 * accounted-for edge is one the walker resolved; anything else naming the module
 * system is an edge nobody can follow.
 */
const ACCOUNTED_LOADS = [
  /\bimport\s+type\s+[\s\S]*?\bfrom\s*['"][^'"]+['"]/g,
  /\bimport\s+[\s\S]*?\bfrom\s*['"][^'"]+['"]/g,
  /\bexport\s+[\s\S]*?\bfrom\s*['"][^'"]+['"]/g,
  /\bimport\s*\(\s*['"][^'"]+['"]\s*\)/g,
  /\bimport\s*['"][^'"]+['"]/g,
]

/**
 * Import edges of one module, plus the count of `import(` / `require(` calls
 * whose argument is not a quoted literal. A template-literal argument, a
 * variable argument and a `require` call all execute fine under bun, so the
 * caller treats an unresolvable edge as a violation: an edge nobody can follow
 * cannot be proven not to reach plaintext code.
 */
function edgesOf(abs: string): { specs: string[]; opaque: number } {
  const src = stripComments(readFileSync(abs, 'utf8'))
  const specs: string[] = []
  // static `from '...'` and bare `import '...'`
  for (const re of [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s+['"]([^'"]+)['"]/g]) {
    for (const m of src.matchAll(re)) specs.push(m[1])
  }
  const literalAt = new Set<number>()
  for (const m of src.matchAll(DYNAMIC_LITERAL)) {
    literalAt.add(m.index)
    specs.push(m[1])
  }
  const opaque = [...src.matchAll(DYNAMIC_CALL)].filter(m => !literalAt.has(m.index)).length
  return { specs, opaque }
}

/**
 * A bare specifier naming this package resolves back into the repo through the
 * `exports` map, so `@gitlawb/memlawb/crypto` from a server module is a real
 * edge to `client/crypto.ts` that bun executes. Returns null for a third-party
 * specifier, which has no path into this repo's source.
 */
function resolveSelf(spec: string): string | null {
  if (spec !== PKG.name && !spec.startsWith(`${PKG.name}/`)) return null
  const subpath = spec === PKG.name ? '.' : `.${spec.slice(PKG.name.length)}`
  const target = PKG.exports[subpath]
  return target ? resolve(REPO_ROOT, target) : null
}

/**
 * Corpus provenance, as a reproducibility property rather than a token hunt.
 *
 * The rule is that the fixture is self-contained synthetic text: if it could
 * read a path, an env var or the network, pointing it at a real memory
 * directory would be one line away and the suite would silently start ranking
 * someone's actual notes. Two generations of denylist have now been holed by
 * somebody finding a route the list did not enumerate — first a helper module
 * doing the `readFileSync` behind an import, then
 * `Bun.spawnSync(['cat', path]).stdout.toString()`, which pulled 39,724 bytes
 * of a real instruction file into the ranked corpus with every listed token
 * absent. Adding the newly-found route to the list would be the third instance
 * of the same mistake, so the guards below are inverted to fail closed: they
 * flag everything they cannot positively account for.
 *
 * `program` serializes every export, plus the results of calling the exported
 * functions, so the comparison covers what the module computes and not only
 * what it stores.
 */
const corpusProbe = (abs: string) => `
const m = await import(${JSON.stringify(abs)})
const norm = v =>
  v instanceof Set ? { set: [...v] } : typeof v === 'function' ? { fn: String(v) } : v
const payload = Object.keys(m).sort().map(k => [k, norm(m[k])])
payload.push(['nearCapCorpus(64)', m.nearCapCorpus(64)])
payload.push(['nearCapCorpus(2000)', m.nearCapCorpus(2000)])
payload.push(['contentTerms', [...m.contentTerms('routing keys deployment notes', t => t)]])
payload.push([
  'sharedTerms',
  m.sharedTerms('deployment process', 'project/deploy.md', m.CORPUS['project/deploy.md'], t => t),
])
process.stdout.write(JSON.stringify(payload))
`

describe('corpus provenance', () => {
  const CORPUS_MODULE = join(REPO_ROOT, 'tests/recall-corpus.ts')

  /**
   * Every identifier the corpus module names that it does not itself declare.
   * An allowlist, pinned exactly, and that is the whole point: a denylist can
   * only ever refuse the routes somebody thought of, while this refuses
   * everything nobody vouched for. `Bun`, `process`, `globalThis`, `fetch`,
   * `eval`, `Function`, `Reflect` and every other capability root are absent
   * from it without being named, which is what makes it fail closed. A legal
   * new name here is a one-line edit made on purpose; an illegal one is red.
   */
  const CORPUS_IDENTIFIERS = ['Boolean', 'Record', 'Set', 'String']

  test('the corpus module names nothing it does not declare, and loads nothing', () => {
    const code = stripToCode(readFileSync(CORPUS_MODULE, 'utf8'))
    const declared = declaredNames(code)
    const free = [...new Set(freeIdentifiers(code))].filter(n => !declared.has(n)).sort()
    expect(free).toEqual(CORPUS_IDENTIFIERS)

    // The module system, separately: a synthetic fixture loads nothing, so
    // neither token may appear in the code at all. This covers `import(...)`,
    // `import.meta.*`, `require(...)` and `createRequire` in one rule, without
    // naming any of them.
    expect(code.match(/\b(?:import|require)\b/g)).toBeNull()
    const edges = edgesOf(CORPUS_MODULE)
    expect(edges.specs).toEqual([])
    expect(edges.opaque).toBe(0)

    // Cheap fast-fail kept underneath, widened to the whole `Bun` namespace and
    // to any bare `process`, neither of which has a legitimate use in a static
    // fixture. This is no longer the load-bearing check; it just names the
    // likely mistake in one line when it happens.
    for (const hook of ['Bun.', 'Bun[', 'process', 'readFile', 'node:', 'fetch('])
      expect(`${hook}:${code.includes(hook)}`).toBe(`${hook}:false`)
  })

  /**
   * The property the token list was always a proxy for: the module's exports do
   * not depend on the machine it runs on. Two fresh subprocesses import it with
   * different working directories and different environments, and their
   * serialized exports must be byte-identical. Anything the module reads from
   * outside itself — an env var, a relative path, a subprocess, a socket —
   * differs across those two runs or fails outright in one of them.
   */
  test('the corpus module exports the same bytes under a different cwd and environment', () => {
    const program = corpusProbe(CORPUS_MODULE)
    const run = (cwd: string, env: Record<string, string>) =>
      Bun.spawnSync({ cmd: [process.execPath, '-e', program], cwd, env, stderr: 'pipe' })

    const a = run(REPO_ROOT, { ...process.env } as Record<string, string>)
    const b = run(tmpdir(), {
      PATH: process.env.PATH ?? '',
      HOME: tmpdir(),
      PWD: tmpdir(),
      TZ: 'UTC',
      LANG: 'C',
      MEMLAWB_CORPUS_PROBE: 'second-run',
    })

    // Fail loudly rather than vacuously: two crashed runs also produce equal
    // (empty) output, which would make the comparison below meaningless.
    for (const [name, r] of [
      ['a', a],
      ['b', b],
    ] as const)
      expect(`${name} exit:${r.exitCode} ${r.stderr.toString().slice(0, 400)}`).toBe(
        `${name} exit:0 `,
      )

    const outA = a.stdout.toString()
    const outB = b.stdout.toString()
    // Non-vacuous: the payload must actually carry the corpus, not an empty
    // array that two runs would agree on trivially.
    expect(outA.length).toBeGreaterThan(50_000)
    expect(outA).toContain('project/deploy.md')
    expect(outA).toContain('BASELINE_RANK_MS')
    expect(`identical:${outA === outB}`).toBe('identical:true')
  })

  // Asserts the property its name claims. The previous body only checked that
  // BASELINE_RANK_MS was positive and never called the generator at all, which
  // left the function U3's latency comparison rests on with zero callers in the
  // repo: it could have been deleted, or made to vary run over run, in silence.
  test('the near-cap generator is deterministic', () => {
    expect(nearCapCorpus(64)).toEqual(nearCapCorpus(64))
  })

  test('the near-cap generator produces exactly the requested number of entries', () => {
    // Keys are built from a topic and an index, so a formatting mistake could
    // collide two indices and hand U3 a corpus quietly smaller than it asked
    // for. A Record dedups silently, so the entry count IS the collision check;
    // 2000 is the size the baseline was measured at, where zero-padding to four
    // digits is the part most likely to break.
    for (const n of [64, 2000]) {
      expect(`${n}:${Object.keys(nearCapCorpus(n)).length}`).toBe(`${n}:${n}`)
    }
  })

  test('the recorded baseline latency is a positive number of milliseconds', () => {
    expect(BASELINE_RANK_MS).toBeGreaterThan(0)
  })

  // The corpus module carries its own stoplist for the held-out overlap floor,
  // and a comment used to be all that kept it in step with the ranker's. If
  // they drift, the floor measures different terms than the ranker sees and the
  // held-out set stops meaning what it says. `STOP` is not exported from
  // src/mcp/relevance.ts and this unit may not change src/, so the ranker's list
  // is parsed out of its source instead of imported. That is the whole reason
  // for the regex: it is not preference.
  test('the corpus stoplist matches the ranker stoplist exactly', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/mcp/relevance.ts'), 'utf8')
    const m = /const STOP = new Set\(\s*'([^']*)'/.exec(src)
    // Fail loudly rather than vacuously if the ranker's declaration is
    // reshaped: an unparseable list must not read as an empty one.
    expect(`STOP literal found:${m !== null}`).toBe('STOP literal found:true')
    const ranker = (m as RegExpExecArray)[1].split(' ').filter(Boolean)
    expect(ranker.length).toBeGreaterThan(20)
    expect([...new Set(ranker)].sort()).toEqual([...STOPWORDS].sort())

    // Reading the declaration is only half of it: a `Set` is mutable, so an
    // `add` / `delete` / `clear` anywhere later in the file would change the
    // list the ranker actually uses while this parse kept reporting the literal.
    // An allowlist of the one method the ranker may call, rather than a list of
    // the three mutators, so a future `STOP[Symbol.iterator]` reassignment or
    // any other member is red too.
    const code = stripToCode(src)
    const members = [...code.matchAll(/\bSTOP\s*\.\s*([A-Za-z_$][\w$]*)/g)].map(x => x[1])
    expect(members.length).toBeGreaterThan(0)
    expect([...new Set(members)].sort()).toEqual(['has'])
  })

  // Same failure mode as the stoplist, one layer worse. The corpus module used
  // to carry its own suffix stripper for the held-out overlap floor, and once
  // the ranker grew one they were free to disagree: the corpus stemmer mangled
  // `boss` to `bos` and `this` to `thi`, exactly the shapes D10's guards exist
  // to prevent. The floor is only meaningful if it measures the terms the ranker
  // actually sees, so the duplication is gone rather than checked for equality,
  // and the ranker's stemmer is injected by the caller. Two guards, because
  // "we deleted it" is not a property:
  test('the overlap floor takes the ranker stemmer as a required argument', () => {
    // A default value would drop the arity to 3 and let a local stemmer back in
    // silently, which is how the first copy survived unnoticed.
    expect(`sharedTerms arity:${sharedTerms.length}`).toBe('sharedTerms arity:4')
    // And it must be the argument that does the work: a body ignoring its stem
    // parameter would still have arity 4.
    const shout = (t: string) => `${t}-STEMMED`
    expect([...contentTerms('routing keys', shout)]).toEqual(['routing-STEMMED', 'keys-STEMMED'])
  })

  test('the corpus module declares no stemmer of its own', () => {
    const source = stripComments(readFileSync(join(REPO_ROOT, 'tests/recall-corpus.ts'), 'utf8'))
    // Matches a declaration, not a mention: `stem` as a parameter or a type
    // annotation is the supported shape and stays legal here.
    const declared = [...source.matchAll(/\b(?:function|const|let|var)\s+(\w*[sS]tem\w*)/g)].map(
      m => m[1],
    )
    expect(declared).toEqual([])
  })
})

/** Extensions bun will execute as a module. A file with one of these is walked. */
const EXEC_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

/**
 * Extensions that carry no executable module. Everything under `src/` must be
 * in one list or the other: an unrecognised extension is a violation rather
 * than a skip, because the walk seeding only `.ts` is exactly how a `.mjs`
 * under `src/` importing `client/crypto.ts` stayed invisible while bun loaded
 * it happily.
 */
const INERT_EXTS = ['.json', '.md', '.txt', '.sql', '.yml', '.yaml', '.toml', '.lock']

const extOf = (name: string) => {
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i)
}

/**
 * Globals a module under `src/` may call. An allowlist, for the same reason the
 * corpus identifier pin is one: enumerating loader forms (`createRequire`,
 * `new Worker(`, `Bun.plugin(`, `import.meta.resolve(`) only ever refuses the
 * ones somebody listed, and that list has now been holed twice. Every way of
 * loading a module is a call or a construction, so requiring the callee to be
 * either declared in the file or named here refuses all of them at once,
 * including the ones nobody has thought of.
 */
const VETTED_GLOBALS = new Set([
  'Array',
  'Buffer',
  'Bun',
  'Date',
  'Error',
  'JSON',
  'Math',
  'NodeJS',
  'Number',
  'Object',
  'Promise',
  'Response',
  'String',
  'TextDecoder',
  'TextEncoder',
  'URL',
  'Uint8Array',
  'console',
  'decodeURIComponent',
  'fetch',
  'process',
])

/** Members of `Bun` a module under `src/` may reach. Allowlist, same reasoning. */
const VETTED_BUN_MEMBERS = new Set(['serve', 'S3Client'])

/**
 * Bare specifiers a module under `src/` may import. The walker resolves
 * relative paths and this package's own `exports`, and returns null for
 * everything else — so an import of a module that can itself load code
 * (`node:module`, `node:worker_threads`, `node:vm`) is an edge it reads as
 * nothing at all. Pinning the set means the walker only ignores specifiers
 * somebody vouched for, instead of ignoring every one it cannot follow.
 */
const VETTED_BARE_SPECIFIERS = new Set(['node:crypto', 'node:fs/promises', 'node:path'])

/**
 * Everything in one module that touches the module system, or the outside
 * world, in a way this walk cannot follow. Returns human-readable violations.
 *
 * The module-system rule is subtractive: remove every statically resolved
 * import form from the source, and any surviving `import` or `require` token is
 * an edge nobody can follow. That covers `createRequire`, `require.resolve`,
 * `import.meta.resolve`, `module.require` and any future spelling, without
 * naming one of them.
 */
function unresolvableLoads(abs: string): string[] {
  const raw = readFileSync(abs, 'utf8')
  const code = stripToCode(raw)
  let residue = stripComments(raw)
  for (const re of ACCOUNTED_LOADS) residue = residue.replace(re, ' ')
  const residueCode = stripToCode(residue)

  const out: string[] = []
  const leftover = residueCode.match(/\b(?:import|require)\b/g)
  if (leftover)
    out.push(`${leftover.length} unaccounted module-system reference(s): ${leftover.join(', ')}`)

  const declared = declaredNames(code)
  for (const root of new Set(calleeRoots(code)))
    if (!declared.has(root) && !VETTED_GLOBALS.has(root))
      out.push(`calls unvetted global \`${root}\``)

  for (const m of code.matchAll(/\bBun\s*\.\s*([A-Za-z_$][\w$]*)/g))
    if (!VETTED_BUN_MEMBERS.has(m[1])) out.push(`uses unvetted \`Bun.${m[1]}\``)

  for (const spec of edgesOf(abs).specs)
    if (!spec.startsWith('.') && !resolveSelf(spec) && !VETTED_BARE_SPECIFIERS.has(spec))
      out.push(`imports unvetted bare specifier \`${spec}\``)

  return out
}

describe('crypto-blind import boundary', () => {
  // A deny rule over the whole boundary, not an allowlist of known-good module
  // names. An allowlist goes green the day a new src/ module reaches plaintext
  // through src/mcp/tools.ts (which imports client/index.ts) or through a
  // dynamic import of the kind bin/memlawb.ts already uses, which is precisely
  // the regression worth catching. Resolution is transitive for the same reason.
  //
  // Two ways past it have been demonstrated and are closed here rather than
  // patched: the walk seeded only `.ts`, so a `.mjs` under `src/` was invisible,
  // and it enumerated loader forms, so `createRequire` and friends were not
  // looked for. Both are now allowlists (extensions, callable globals), which
  // fail closed on the route nobody listed.
  test('no module under src/ outside src/mcp/ can reach client/ or src/mcp/', () => {
    const files: string[] = []
    const unclassified: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name)
        if (e.isDirectory()) {
          walk(full)
          continue
        }
        const ext = extOf(e.name)
        if (EXEC_EXTS.includes(ext)) files.push(full)
        else if (!INERT_EXTS.includes(ext)) unclassified.push(relative(REPO_ROOT, full))
      }
    }
    walk(join(REPO_ROOT, 'src'))

    // Fail closed on an extension neither list knows: a new one is either
    // executable (and must be walked) or inert (and must be declared so).
    expect(unclassified).toEqual([])

    // Non-vacuity per extension: every executable extension present under src/
    // has at least one seeded file. Shrinking EXEC_EXTS to hide a file cannot
    // pass either check — the file drops out of `files` and lands in
    // `unclassified` instead.
    const present = [...new Set(files.map(f => extOf(f)))].sort()
    expect(present.length).toBeGreaterThan(0)
    for (const ext of present)
      expect(`${ext}:${files.filter(f => f.endsWith(ext)).length > 0}`).toBe(`${ext}:true`)

    // A bare specifier resolves into this repo only through the package's own
    // `exports` map, which `resolveSelf` follows. Either of these would open a
    // second route the self-resolver returns null for, leaving the walker to
    // skip a live edge.
    const tsconfig = JSON.parse(readFileSync(join(REPO_ROOT, 'tsconfig.json'), 'utf8')) as {
      compilerOptions?: { paths?: unknown }
    }
    expect(tsconfig.compilerOptions?.paths).toBeUndefined()
    expect(PKG.imports).toBeUndefined()

    const isMcp = (abs: string) => relative(REPO_ROOT, abs).startsWith('src/mcp/')
    const forbidden = (abs: string) => {
      const rel = relative(REPO_ROOT, abs)
      return rel.startsWith('client/') || rel.startsWith('src/mcp/')
    }

    const violations: string[] = []
    const seen = new Set<string>()
    // Every edge the traversal actually resolved, as `from -> to`. `seen` cannot
    // stand in for this: it is seeded from the directory walk, so stubbing the
    // edge extraction to return nothing leaves seen.size unchanged and a dead
    // walk looks identical to a live one.
    const resolvedEdges: string[] = []
    const queue = files.filter(f => !isMcp(f))
    for (const f of queue) seen.add(f)
    while (queue.length) {
      const current = queue.shift() as string
      const { specs, opaque } = edgesOf(current)
      // Fail closed. A dynamic import through a template literal or a variable,
      // like a require() call, runs under bun exactly as well as a literal one,
      // and none of them can be followed from here. An edge that cannot be
      // resolved cannot be shown not to reach plaintext code.
      if (opaque > 0) {
        violations.push(
          `${relative(REPO_ROOT, current)} -> ${opaque} unresolvable import()/require()`,
        )
      }
      // Everything else the walk cannot follow: a module-system token left over
      // after the resolved imports are removed, a call to a global nobody
      // vouched for, an unvetted `Bun` member.
      for (const risk of unresolvableLoads(current))
        violations.push(`${relative(REPO_ROOT, current)} -> ${risk}`)
      for (const spec of specs) {
        // Relative first, then this package's own name through `exports`: a bare
        // `@gitlawb/memlawb/crypto` resolves to client/crypto.ts and bun runs it,
        // so skipping every non-relative specifier left the boundary wide open.
        const target = spec.startsWith('.') ? resolve(dirname(current), spec) : resolveSelf(spec)
        if (!target) continue
        resolvedEdges.push(`${relative(REPO_ROOT, current)} -> ${relative(REPO_ROOT, target)}`)
        if (forbidden(target)) {
          violations.push(`${relative(REPO_ROOT, current)} -> ${relative(REPO_ROOT, target)}`)
          continue
        }
        if (!seen.has(target)) {
          seen.add(target)
          queue.push(target)
        }
      }
    }

    // Non-vacuous, in the only way that catches a dead walk. The old check was
    // `seen.size > 5`, which the directory walk satisfies on its own: an edge
    // extractor returning nothing scored identically. These two assert that
    // edges were read out of the sources and followed.
    //
    // 20 is a floor, not a pin: the traversal resolves 33 edges today, and a
    // module gaining or losing an import must not turn this red. Raise it only
    // if the real number moves far above it.
    expect(resolvedEdges.length).toBeGreaterThanOrEqual(20)
    // One named edge, so the count cannot be met by some other set of edges.
    // src/handler.ts imports ./memory.ts (verified against the source); it is
    // produced by reading handler.ts, never by the directory walk.
    expect(resolvedEdges).toContain('src/handler.ts -> src/memory.ts')

    // The walk itself must still have found the server modules.
    expect(seen.size).toBeGreaterThan(5)
    expect(violations).toEqual([])
  })
})

/**
 * Everything one intercepted request put on the wire. Headers are captured
 * because a body-and-URL scan is blind to them, and a client that moved
 * plaintext into a header would have satisfied the old check exactly.
 */
type Capture = { hrefs: string[]; headers: string[]; bodies: string[]; unrecognised: string[] }

/**
 * A request body as the bytes that actually leave the machine.
 *
 * The old capture was `typeof body === 'string' ? body : (body ?? '').toString()`,
 * which turns a Blob into `[object Blob]` and a typed array into a comma-joined
 * list of code points — so "the sentinel is in no body" held for a body that
 * plainly contained it. Anything the normalizer does not recognise (a
 * ReadableStream, say) is recorded as unrecognised and asserted on, rather than
 * scanned as the empty string: an unreadable body must fail the check, not pass it.
 */
async function bodyText(body: BodyInit | null | undefined, cap: Capture): Promise<string> {
  if (body === null || body === undefined) return ''
  if (typeof body === 'string') return body
  if (body instanceof Blob) return await body.text()
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body)
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof FormData) {
    const parts: string[] = []
    for (const [k, v] of body) parts.push(`${k}=${typeof v === 'string' ? v : await v.text()}`)
    return parts.join('&')
  }
  cap.unrecognised.push(Object.prototype.toString.call(body))
  return ''
}

/** Install a fetch that records every request and answers it with `respond`. */
function intercept(
  respond: (req: { href: string; method: string; body: string }) => Promise<Response>,
) {
  const cap: Capture = { hrefs: [], headers: [], bodies: [], unrecognised: [] }
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}))
    const body = await bodyText(init?.body, cap)
    cap.hrefs.push(href)
    cap.headers.push([...headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n'))
    cap.bodies.push(body)
    return await respond({ href, method, body })
  }) as typeof fetch
  return { cap, fn }
}

/**
 * An in-memory stand-in for the sync server that speaks the real wire contract
 * over real ciphertext: the client encrypts before it ever reaches here, so
 * what this stores is exactly what a live server would store. It exists because
 * a stub that 404s every GET leaves recall, search and get running against an
 * empty namespace, and a check whose whole purpose is "no plaintext on the
 * wire" then never once exercises a namespace that holds any.
 */
function ciphertextServer() {
  const entries = new Map<string, string>()
  let version = 0
  return async ({ href, method, body }: { href: string; method: string; body: string }) => {
    const u = new URL(href)
    if (method === 'PUT') {
      let payload: { entries?: Record<string, string>; deletions?: string[] }
      try {
        payload = JSON.parse(body)
      } catch {
        return new Response(null, { status: 400 })
      }
      for (const [k, v] of Object.entries(payload.entries ?? {})) entries.set(k, v)
      const deleted = (payload.deletions ?? []).filter(k => entries.delete(k))
      version++
      return Response.json({ version, deleted })
    }
    if (method === 'DELETE') {
      entries.delete(u.searchParams.get('key') ?? '')
      version++
      return new Response(null, { status: 204 })
    }
    if (entries.size === 0) return new Response(null, { status: 404 })
    if (u.searchParams.get('view') === 'hashes')
      return Response.json({
        version,
        entryChecksums: Object.fromEntries([...entries].map(([k, v]) => [k, ciphertextHash(v)])),
      })
    return Response.json({ version, content: { entries: Object.fromEntries(entries) } })
  }
}

describe('single-origin tool traffic', () => {
  const realFetch = globalThis.fetch
  const url = 'http://recall-r18.test'
  const sentinel = 'ZQXJ-recall-r18-plaintext-sentinel-ZQXJ'
  afterAll(() => {
    globalThis.fetch = realFetch
  })

  /** The sentinel must be in no URL, no header and no body, and every body must be readable. */
  const assertNoPlaintext = (cap: Capture) => {
    expect(cap.unrecognised).toEqual([])
    expect(cap.hrefs.filter(h => h.includes(sentinel))).toEqual([])
    expect(cap.headers.filter(h => h.includes(sentinel))).toEqual([])
    expect(cap.bodies.filter(b => b.includes(sentinel))).toEqual([])
  }

  // Runnable, not static: server.ts is import-unsafe here (it exits the process
  // at module scope when MEMLAWB_PASSPHRASE is unset, as it is under
  // tests/setup.ts, and connects a stdio transport), so the check runs at the
  // tools/client layer and drives every tool through a stubbed fetch.
  //
  // Origins alone were never the requirement. A client that uploaded plaintext
  // to the configured host would satisfy a single-origin check exactly, so the
  // interceptor captures the full URL, the headers and the request body too,
  // and a sentinel string is driven through save so there is something specific
  // to look for.
  test('every tool request goes to the configured origin carrying no plaintext', async () => {
    // Requests attributable to `get` alone. The total-count guard below is not
    // enough to prove get is covered: the other four tools already clear it
    // between them, so dropping the get call would leave the check silently
    // green over five tools.
    let getHrefs: string[] = []
    const { cap, fn } = intercept(async ({ method }) => {
      if (method === 'PUT') return Response.json({ version: 1, deleted: [] })
      if (method === 'DELETE') return new Response(null, { status: 204 })
      // 404 is the empty-namespace path: pull returns no entries, hashes {}.
      return new Response(null, { status: 404 })
    })
    globalThis.fetch = fn

    try {
      const client = new MemlawbClient({ url, passphrase: 'test-passphrase' })
      const tools = makeTools(client, NS)
      await tools.save('notes/plain.md', `An ordinary sentence with ${sentinel} inside it.`)
      await tools.recall('anything at all')
      await tools.search('anything at all')
      await tools.list()
      // get returns whole entry bodies, so it is the surface where a leak would
      // be worth the most; it is driven here rather than left as the one tool
      // outside the boundary check.
      const beforeGet = cap.hrefs.length
      await tools.get('notes/plain.md')
      getHrefs = cap.hrefs.slice(beforeGet)
      await tools.delete('notes/plain.md')
    } finally {
      globalThis.fetch = realFetch
    }

    // Non-vacuous: six tool calls must have produced traffic before the
    // all-equal assertion means anything.
    expect(cap.hrefs.length).toBeGreaterThanOrEqual(6)
    expect(getHrefs.length).toBeGreaterThanOrEqual(1)
    expect([...new Set(cap.hrefs.map(h => new URL(h).origin))]).toEqual([url])
    expect([...new Set(getHrefs.map(h => new URL(h).origin))]).toEqual([url])

    // Non-vacuous the other way: at least one request must have carried a body
    // and at least one a header, or the absence assertions are statements about
    // nothing.
    expect(cap.bodies.filter(b => b.length > 0).length).toBeGreaterThan(0)
    expect(cap.headers.filter(h => h.length > 0).length).toBeGreaterThan(0)
    assertNoPlaintext(cap)

    // And what did go out in place of the plaintext: the single PUT's entry
    // values must be base64 envelopes. Absence of the sentinel on its own would
    // also hold for a body that never contained the entry at all.
    const puts = cap.bodies
      .filter(b => b.startsWith('{'))
      .map(b => JSON.parse(b) as { entries?: Record<string, string> })
      .filter(b => b.entries !== undefined)
    expect(puts.length).toBe(1)
    const values = Object.values(puts[0].entries ?? {})
    expect(values.length).toBe(1)
    for (const v of values) {
      expect(`base64:${/^[A-Za-z0-9+/]+={0,2}$/.test(v)}`).toBe('base64:true')
    }
  })

  // The same rule against a namespace that actually holds something. Above, the
  // stub 404s every GET, so recall, search and get all ran over an empty
  // namespace: the read tools never had any plaintext available to leak, which
  // is the one condition under which "no plaintext on the wire" is free. Here
  // the entries are pushed through the real client first, so the store holds
  // genuine ciphertext, and every read is answered from it.
  test('no plaintext reaches the wire from a namespace that holds some', async () => {
    const { cap, fn } = intercept(ciphertextServer())
    globalThis.fetch = fn
    let recalled = ''
    let got = ''
    let searched = ''
    let listed = ''
    try {
      const client = new MemlawbClient({ url, passphrase: 'test-passphrase' })
      const tools = makeTools(client, NS)
      await tools.save(
        'notes/ledger.md',
        `---\ndescription: the quokka ledger note\n---\nThe quokka ledger records ${sentinel} in full.`,
      )
      await tools.save('notes/other.md', `A second note also carrying ${sentinel}.`)
      recalled = (await tools.recall('quokka ledger records')).text
      searched = (await tools.search('quokka')).text
      got = (await tools.get('notes/ledger.md')).text
      listed = (await tools.list()).text
    } finally {
      globalThis.fetch = realFetch
    }

    // Non-vacuous, and the part that makes this test different from the one
    // above: the namespace really was populated, the ciphertext really did
    // decrypt, and the reads really did return the sentinel to the caller.
    expect(got).toContain(sentinel)
    expect(recalled).toContain('notes/ledger.md')
    expect(searched).toContain('notes/ledger.md')
    expect(listed).toContain('notes/other.md')
    // Reads against a populated namespace, so the GET bodies carry real entries.
    expect(cap.bodies.filter(b => b.includes('"entries"')).length).toBeGreaterThan(1)
    expect([...new Set(cap.hrefs.map(h => new URL(h).origin))]).toEqual([url])
    assertNoPlaintext(cap)
  })
})
