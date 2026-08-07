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
 * Each of those checks is a composite of several rules, and each rule is a
 * function over source text (or a capture, or a directory) with its own
 * positive control in `guard positive controls` at the foot of this file. That
 * shape is not incidental: the guards were previously tested only by planting a
 * violation and watching the composite go red, and five different sub-checks
 * were later found to be neuterable one at a time with the suite still green.
 * A rule added here without a control is a rule nobody can tell is alive. What
 * each guard does and does not claim to catch is written on the rule functions
 * themselves (`moduleRisks`, `corpusRisks`).
 *
 * Explicit non-guarantee: the held-out pass rate printed here is a baseline for
 * comparison inside this repo only. It is not a relevance benchmark, it is not
 * asserted all-green during phase 1, and a run that improves it has not thereby
 * proven the ranker good in general.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { ciphertextHash, MemlawbClient } from '../client/index.ts'
import { rankMemories, stemTerm } from '../src/mcp/relevance.ts'
import { makeTools } from '../src/mcp/tools.ts'
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
import { makeStubClient } from './stub-client.ts'

// Real path, not the lexical one: every boundary decision below compares a
// resolved path against this prefix, so a repo reached through a symlinked
// parent would otherwise classify every file in it as outside the repo.
const REPO_ROOT = realpathSync(resolve(import.meta.dir, '..'))
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
 * shared stub; each reached `makeTools` behind an `as unknown as MemlawbClient`
 * cast, which is precisely what let them disagree. `makeTools` now takes the
 * structural `MemoryClient`, so this is type-checked. It comes from
 * `tests/stub-client.ts`, a plain module: importing it out of a test file
 * booted that file's real HTTP server as a side effect of wanting a stub.
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
  // `#name` is an ES private field, which is always a member of the enclosing
  // class and can never be a global. Without this arm the `#` is skipped and
  // the bare name reads as an undeclared callee, so an ordinary class writing
  // `this.#cache.get(k)` is reported as calling an unvetted global `cache`.
  // A guard that fires on a standard language feature gets deleted by the
  // first contributor it blocks, which costs more than the hole it closes.
  return i >= 0 && (code[i] === '.' || code[i] === '#')
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
 * Identifiers in callee or receiver position: `x(`, `new x(`, `x.y(`, `x<T>(`.
 * Every way of loading a module is one of these, so this is the position where
 * an unaccounted-for capability shows up, and restricting to it keeps object
 * keys out of the way.
 *
 * `<` is in the lookahead because leaving it out made the classification depend
 * on type arguments: `new Map()` was reported and `new Map<K, V>()` was not, so
 * the guard fired on one of the two spellings of ordinary code and stayed quiet
 * on the other. A guard that red-flags `new Map()` gets weakened by the first
 * contributor it inconveniences, which costs more than the hole it closed.
 */
function calleeRoots(code: string): string[] {
  const out: string[] = []
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*(?=[(.<])/g)) {
    if (isMemberAccess(code, m.index)) continue
    if (KEYWORDS.has(m[1])) continue
    out.push(m[1])
  }
  return out
}

/** From the `(` at `open`, the index one past its matching `)`, or -1. */
function afterParens(code: string, open: number): number {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++
    else if (code[i] === ')') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/**
 * True when the paren group opening at `open` is a parameter list rather than
 * an argument list: a body follows it, or a return-type annotation and then a
 * body, or (in an interface or a type literal) a return-type annotation alone.
 *
 * This is the whole fix for the hole that let a call in statement position be
 * read as a declaration. `Function('s', 'return imp' + 'ort(s)')(spec)` on its
 * own line matched the method-definition regex below, registered `Function` as
 * a name the file declares, and skipped the global allowlist entirely — while
 * bun ran it and loaded client/crypto.ts. An argument list is followed by the
 * rest of an expression, never by `{`, `=>` or `:`.
 */
function isParameterList(code: string, open: number): boolean {
  const end = afterParens(code, open)
  return end >= 0 && /^\s*(?::|\{|=>)/.test(code.slice(end, end + 160))
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
  // The paren group must be a parameter list: without that test any call in
  // statement position registered its callee as locally declared, which is the
  // hole `isParameterList` exists to close.
  for (const m of code.matchAll(
    /^[ \t]*(?:export\s+|async\s+|static\s+|private\s+|public\s+|protected\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/gm,
  ))
    if (isParameterList(code, m.index + m[0].length - 1)) names.add(m[1])
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
function edgesOfSource(raw: string): { specs: string[]; opaque: number } {
  const src = stripComments(raw)
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

/**
 * Property names the fixture may not reach, on anything.
 *
 * Pinning identifiers without pinning property names allowlists the whole
 * language: `String` is on the list above and `String.constructor` IS
 * `Function`, so `String.constructor('return Bu' + 'n')()` names only vetted
 * identifiers, and `stripToCode` blanks the string so the `Bun` token inside it
 * is invisible to a code-only scan. That route was verified to reach 39,724
 * bytes of a real file. Both spellings are checked, plain and computed.
 */
const BANNED_PROPERTIES = ['__proto__', 'apply', 'bind', 'call', 'constructor', 'prototype']

/**
 * Tokens swept for over source with STRING LITERALS INTACT, because a fixture
 * that has to spell a capability inside a string to reach it is exactly the
 * case a code-only scan cannot see. None of these is a word English prose uses,
 * which is what makes the strings-intact sweep safe on a file that is almost
 * entirely prose. Comments are still stripped: the module's own doc comment
 * discusses importing, and a guard that fires on prose about itself is a guard
 * somebody deletes.
 */
const CORPUS_STRING_TOKENS = [
  'Bun',
  'Function',
  'Proxy',
  'Reflect',
  'WebAssembly',
  'Worker',
  'eval',
  'globalThis',
  'import',
  'node:',
  'require',
]

/**
 * The same idea for hooks whose names are ordinary English ("the deployment
 * process", "we call the on-call engineer"), so these run over code alone and
 * match on word boundaries. Substring matching here read `processedRoots` as a
 * violation, which is the cry-wolf failure that gets a guard weakened.
 */
const CORPUS_CODE_HOOKS = [/\bprocess\b/, /\breadFile/, /\bfetch\s*\(/]

/** Free identifiers of the corpus module: named but not declared by it. */
function corpusFreeIdentifiers(raw: string): string[] {
  const code = stripToCode(raw)
  const declared = declaredNames(code)
  return [...new Set(freeIdentifiers(code))].filter(n => !declared.has(n)).sort()
}

/**
 * Corpus provenance rules over source text. One violation string per rule
 * instance, so every rule below can be driven from a fixture on its own.
 *
 * WHAT THIS CATCHES: content arriving in the fixture by machinery. A read at
 * import time (of a path, an env var, a subprocess, a socket), any route to one
 * through an identifier or a property nobody vouched for, and — through the
 * reproducibility check that runs alongside it — anything whose value differs
 * between two machines.
 *
 * WHAT THIS EXPLICITLY DOES NOT CATCH: real content pasted into the fixture as
 * a string literal. Pasted text is perfectly reproducible, names no identifier,
 * reaches no property and uses no capability, so no check here can see it. The
 * guard therefore defends against ACCIDENTAL and PROGRAMMATIC ingestion, which
 * is what both real incidents were, and NOT against a person who means to put
 * someone's notes in the corpus. The control for that is human diff review, and
 * a corpus edit is exactly the diff a reviewer should read as content rather
 * than as code.
 */
function corpusRisks(raw: string): string[] {
  const out: string[] = []
  const code = stripToCode(raw)
  // Comments removed, string bodies kept: the sweep below needs to read inside
  // the literals, and must not read the file's own prose about itself.
  const literals = stripComments(raw)

  const declared = declaredNames(code)
  for (const n of [...new Set(freeIdentifiers(code))].sort())
    if (!declared.has(n) && !CORPUS_IDENTIFIERS.includes(n))
      out.push(`names unvetted identifier \`${n}\``)

  const properties = [
    ...[...code.matchAll(/\.\s*([A-Za-z_$][\w$]*)/g)].map(m => m[1]),
    // Computed access with a literal key, read off the unblanked source: after
    // `stripToCode`, `String['constructor']` is `String[ 0 ]`.
    ...[...literals.matchAll(/\[\s*['"]([^'"]+)['"]\s*\]/g)].map(m => m[1]),
  ]
  for (const p of new Set(properties))
    if (BANNED_PROPERTIES.includes(p)) out.push(`reaches property \`${p}\``)

  // The module system, in one rule that names no loader form: a synthetic
  // fixture loads nothing, so neither token may appear in its code at all. This
  // covers `import(...)`, `import.meta.*`, `require(...)` and `createRequire`
  // together.
  const leftover = code.match(/\b(?:import|require)\b/g)
  if (leftover) out.push(`${leftover.length} module-system reference(s)`)
  const { specs, opaque } = edgesOfSource(raw)
  for (const s of specs) out.push(`imports \`${s}\``)
  if (opaque > 0) out.push(`${opaque} unresolvable import()/require()`)

  for (const t of CORPUS_STRING_TOKENS) {
    // Whole words for identifiers, literal for `node:`. Substring matching read
    // "required" in an entry description as a `require` violation.
    const hit = /^\w+$/.test(t) ? new RegExp(`\\b${t}\\b`).test(literals) : literals.includes(t)
    if (hit) out.push(`carries capability token \`${t}\``)
  }
  for (const re of CORPUS_CODE_HOOKS)
    if (re.test(code)) out.push(`carries input hook \`${re.source}\``)

  return out
}

/**
 * Runs `program` twice, in two working directories and two environments, and
 * reports what stopped the two runs from agreeing.
 *
 * This is the property the token lists were always a proxy for: the module's
 * exports do not depend on the machine it runs on. Anything read from outside
 * itself — an env var, a relative path, a subprocess, a socket — differs across
 * these two runs or fails outright in one of them. A crashed run is reported
 * rather than compared, because two crashes also produce equal (empty) output.
 */
function reproducibility(program: string): { risks: string[]; out: string } {
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

  const risks: string[] = []
  for (const [name, r] of [
    ['a', a],
    ['b', b],
  ] as const)
    if (r.exitCode !== 0)
      risks.push(`run ${name} exit:${r.exitCode} ${r.stderr.toString().slice(0, 200)}`)
  const outA = a.stdout.toString()
  if (!risks.length && outA !== b.stdout.toString())
    risks.push('exports differ across cwd and environment')
  return { risks, out: outA }
}

describe('corpus provenance', () => {
  const CORPUS_MODULE = join(REPO_ROOT, 'tests/recall-corpus.ts')

  test('the corpus module names nothing it does not declare, and loads nothing', () => {
    const raw = readFileSync(CORPUS_MODULE, 'utf8')
    expect(corpusRisks(raw)).toEqual([])
    // The allowlist pinned in both directions, which the violation list alone
    // does not do: an entry left behind after the last use of the name it
    // vouches for is a stale vouch, and stale vouches are how a list stops
    // meaning anything.
    expect(corpusFreeIdentifiers(raw)).toEqual(CORPUS_IDENTIFIERS)
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
    const { risks, out } = reproducibility(corpusProbe(CORPUS_MODULE))
    // Non-vacuous: the payload must actually carry the corpus, not an empty
    // array that two runs would agree on trivially.
    expect(out.length).toBeGreaterThan(50_000)
    expect(out).toContain('project/deploy.md')
    expect(out).toContain('BASELINE_RANK_MS')
    expect(risks).toEqual([])
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

/** Resolved path, falling back to the lexical one when the link is broken. */
const realPath = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * Everything under `dir` split into modules bun would execute and entries the
 * classifier cannot vouch for.
 *
 * Symlinks are reported rather than followed, and that is the fix for a
 * demonstrated escape: the boundary test classifies by lexical path
 * (`relative(REPO_ROOT, abs).startsWith('client/')`), so `src/shim.ts` pointing
 * at `client/crypto.ts` reads as an ordinary `src/` module that imports
 * nothing, and giving the same link a `.json` suffix got it skipped as inert on
 * top of that. Deciding which links are benign is a judgement the walk is in no
 * position to make, so it makes none: a link under `src/` is a violation until
 * a human accounts for it. Files that survive are returned as real paths, so
 * the prefix tests the caller runs are over resolved locations.
 */
function classifyTree(dir: string): { files: string[]; unclassified: string[] } {
  const files: string[] = []
  const unclassified: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name)
      // Before the directory test: a dirent for a symlink reports isDirectory()
      // false even when it points at one, and a link to a directory would
      // otherwise be classified by its own (usually absent) extension.
      if (e.isSymbolicLink()) {
        unclassified.push(`${relative(REPO_ROOT, full)} (symlink)`)
        continue
      }
      if (e.isDirectory()) {
        walk(full)
        continue
      }
      const ext = extOf(e.name)
      if (EXEC_EXTS.includes(ext)) files.push(realPath(full))
      else if (!INERT_EXTS.includes(ext)) unclassified.push(relative(REPO_ROOT, full))
    }
  }
  walk(dir)
  return { files, unclassified }
}

/**
 * Globals a module under `src/` may call, in two lists that are read the same
 * way but mean different things.
 *
 * `PURE_BUILTINS` is language and platform furniture that cannot load a module,
 * spawn anything, or touch the outside world: `Map`, `RegExp`, a timer, a type
 * utility. Using one is not a decision anybody needs to vouch for, and a guard
 * that made a contributor justify `new Map()` would be edited out of the way
 * within a week.
 *
 * `VETTED_GLOBALS` is the capability roots — the handful of names that can
 * reach the module graph, the filesystem or the network, each vouched for by
 * name for `src/`. This is the list that carries the security meaning, and it
 * is an allowlist for the same reason the corpus identifier pin is one:
 * enumerating loader forms (`createRequire`, `new Worker(`, `Bun.plugin(`,
 * `import.meta.resolve(`) only ever refuses the ones somebody listed, and that
 * list has now been holed twice. Every way of loading a module is a call or a
 * construction, so requiring the callee to be declared in the file or named in
 * one of these two lists refuses all of them at once.
 *
 * `Function`, `eval`, `globalThis`, `Reflect`, `Proxy`, `Worker` and friends
 * are in neither list, and `CAPABILITY_ROOTS` below pins that they can never be
 * quietly demoted into the pure list.
 */
const PURE_BUILTINS = new Set([
  // Type-position names. `<` is in the callee lookahead so that `new Map<K,V>()`
  // and `new Map()` classify alike, which brings type references along with it;
  // none of these exists at run time at all.
  'Array',
  'ArrayLike',
  'Awaited',
  'Exclude',
  'Extract',
  'InstanceType',
  'Iterable',
  'NonNullable',
  'Omit',
  'Parameters',
  'Partial',
  'Pick',
  'Readonly',
  'Record',
  'Required',
  'ReturnType',
  'AbortController',
  'Array',
  'ArrayBuffer',
  'BigInt',
  'Blob',
  'Boolean',
  'Buffer',
  'Date',
  'Error',
  'FormData',
  'Headers',
  'Infinity',
  'Intl',
  'JSON',
  'Map',
  'Math',
  'NaN',
  'NodeJS',
  'Number',
  'Object',
  'Promise',
  'RegExp',
  'Request',
  'Response',
  'Set',
  'String',
  'Symbol',
  'TextDecoder',
  'TextEncoder',
  'URL',
  'URLSearchParams',
  'Uint8Array',
  'WeakMap',
  'WeakSet',
  'clearInterval',
  'clearTimeout',
  'decodeURIComponent',
  'encodeURIComponent',
  'isNaN',
  'parseFloat',
  'parseInt',
  'queueMicrotask',
  'setInterval',
  'setTimeout',
  'structuredClone',
])

const VETTED_GLOBALS = new Set(['Bun', 'console', 'fetch', 'process'])

/**
 * Names that must never be treated as harmless. Splitting the allowlist in two
 * created a way to weaken the guard that reads as housekeeping — move a name
 * into the "cannot load a module" list and nobody looks twice — so the split
 * comes with a pin that the capability roots are in neither the pure list nor,
 * unless somebody vouches for them by name, anywhere else.
 */
const CAPABILITY_ROOTS = [
  'Function',
  'Proxy',
  'Reflect',
  'SharedArrayBuffer',
  'WebAssembly',
  'Worker',
  'eval',
  'globalThis',
  'import',
  'importScripts',
  'require',
]

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
 * Everything in one module's source that touches the module system, or the
 * outside world, in a way the walk below cannot follow. Returns human-readable
 * violations, one per rule instance, and takes source text rather than a path
 * so every rule in it can be driven from a fixture string.
 *
 * WHAT THIS CATCHES: module loading the walk cannot account for. An `import()`
 * or `require()` whose argument is not a literal; any `import` / `require`
 * token still standing after the statically resolved forms are removed
 * (`createRequire`, `require.resolve`, `import.meta.resolve`, `module.require`,
 * and any future spelling, none of them named here); a call to a global that
 * the file does not declare and nobody vouched for; a `Bun` member outside the
 * vetted set; a bare specifier the resolver cannot follow into the repo.
 *
 * WHAT THIS IS NOT: a sandbox. It reads source text, so it constrains what a
 * module can be seen to do, not what a module can do. A file that obtains a
 * loader through a value the scanner cannot name statically, or that reaches
 * plaintext through a route that is not a module edge at all, is outside its
 * reach by construction. The property it does deliver is that every module
 * edge under `src/` is either resolved and followed, or reported — which is
 * what the two demonstrated escapes (a `.mjs` the walk never seeded, and
 * `createRequire`) both broke.
 *
 * The module-system rule is subtractive rather than enumerated for the same
 * reason: remove every statically resolved import form, and any surviving
 * token is an edge nobody can follow.
 */
function moduleRisks(raw: string): string[] {
  const code = stripToCode(raw)
  let residue = stripComments(raw)
  for (const re of ACCOUNTED_LOADS) residue = residue.replace(re, ' ')
  const residueCode = stripToCode(residue)

  const out: string[] = []
  const { specs, opaque } = edgesOfSource(raw)
  // Fail closed. A dynamic import through a template literal or a variable,
  // like a require() call, runs under bun exactly as well as a literal one, and
  // none of them can be followed from here. An edge that cannot be resolved
  // cannot be shown not to reach plaintext code.
  if (opaque > 0) out.push(`${opaque} unresolvable import()/require()`)

  const leftover = residueCode.match(/\b(?:import|require)\b/g)
  if (leftover)
    out.push(`${leftover.length} unaccounted module-system reference(s): ${leftover.join(', ')}`)

  const declared = declaredNames(code)
  for (const root of new Set(calleeRoots(code)))
    if (!declared.has(root) && !PURE_BUILTINS.has(root) && !VETTED_GLOBALS.has(root))
      out.push(`calls unvetted global \`${root}\``)

  for (const m of code.matchAll(/\bBun\s*\.\s*([A-Za-z_$][\w$]*)/g))
    if (!VETTED_BUN_MEMBERS.has(m[1])) out.push(`uses unvetted \`Bun.${m[1]}\``)

  for (const spec of specs)
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
    const { files, unclassified } = classifyTree(join(REPO_ROOT, 'src'))

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
      const raw = readFileSync(current, 'utf8')
      // Everything the walk cannot follow: an unresolvable dynamic import, a
      // module-system token left over after the resolved imports are removed, a
      // call to a global nobody vouched for, an unvetted `Bun` member, a bare
      // specifier that resolves nowhere the walker can read.
      for (const risk of moduleRisks(raw))
        violations.push(`${relative(REPO_ROOT, current)} -> ${risk}`)
      for (const spec of edgesOfSource(raw).specs) {
        // Relative first, then this package's own name through `exports`: a bare
        // `@gitlawb/memlawb/crypto` resolves to client/crypto.ts and bun runs it,
        // so skipping every non-relative specifier left the boundary wide open.
        const lexical = spec.startsWith('.') ? resolve(dirname(current), spec) : resolveSelf(spec)
        if (!lexical) continue
        // Resolved, not lexical: a symlink is exactly how an edge into client/
        // presents itself as an edge to somewhere harmless.
        const target = realPath(lexical)
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
    // A Request carries its own body, and `fetch(new Request(url, { body }))`
    // is a call the client could make tomorrow with no other change. Reading
    // only `init.body` meant that request went out with the interceptor
    // recording the empty string for it, so "no body carried plaintext" held
    // for a body that plainly did. Clone, so the real send still has its body.
    const body =
      init?.body !== undefined && init?.body !== null
        ? await bodyText(init.body, cap)
        : input instanceof Request
          ? await input.clone().text()
          : ''
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

/**
 * What one captured conversation got wrong: an off-origin request, the sentinel
 * in a URL, a header or a body, or a body the normalizer could not read.
 *
 * The unreadable case is a violation rather than a skip on purpose. The old
 * capture was `typeof body === 'string' ? body : (body ?? '').toString()`,
 * which renders a Blob as `[object Blob]`, so "the sentinel is in no body" held
 * for a body that contained it. An unreadable body is an unchecked body.
 */
function wireRisks(cap: Capture, sentinel: string, origin: string): string[] {
  const out: string[] = []
  for (const t of cap.unrecognised) out.push(`unreadable body type ${t}`)
  for (const h of cap.hrefs) {
    if (h.includes(sentinel)) out.push('plaintext in url')
    if (new URL(h).origin !== origin) out.push(`off-origin request to ${new URL(h).origin}`)
  }
  for (const h of cap.headers) if (h.includes(sentinel)) out.push('plaintext in header')
  for (const b of cap.bodies) if (b.includes(sentinel)) out.push('plaintext in body')
  return out
}

describe('single-origin tool traffic', () => {
  const realFetch = globalThis.fetch
  const url = 'http://recall-r18.test'
  const sentinel = 'ZQXJ-recall-r18-plaintext-sentinel-ZQXJ'
  afterAll(() => {
    globalThis.fetch = realFetch
  })

  const assertNoPlaintext = (cap: Capture) => expect(wireRisks(cap, sentinel, url)).toEqual([])

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

/**
 * Positive controls: one per rule, each proving that ITS rule is what fires.
 *
 * The guards above were inverted to fail closed after a denylist was holed
 * twice, and the inversion was then tested the way the denylists had been: by
 * planting a violation and watching the suite go red. That only ever proves the
 * composite is alive. Five separate sub-checks were neutered one at a time
 * inside the inverted guards and the suite stayed green through every one of
 * them, because some other rule in the same test was still doing the work.
 *
 * So each rule below gets a fixture that should trip exactly it, and the
 * assertion is the exact violation list rather than "something was reported".
 * Delete a rule and its control is the test that goes red, by name. The rules
 * take source text (or a Capture, or a directory) rather than reading the repo,
 * which is the refactor that makes this possible at all.
 */
describe('guard positive controls', () => {
  const tmp = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'memlawb-guard-'))
    for (const [name, body] of Object.entries(files)) {
      const full = join(dir, name)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, body)
    }
    return dir
  }

  describe('import boundary', () => {
    test('an ordinary module trips nothing', () => {
      // The false-positive control, and the reason PURE_BUILTINS exists: a
      // guard that fires on `new Map()` is a guard the next contributor
      // weakens. Five shapes of unremarkable code, all silent.
      const ordinary = [
        "import { join } from 'node:path'\nexport const under = (a: string) => join('x', a)\n",
        'export const seen = new Map()\nseen.set(1, 2)\n',
        'export const typed = new Map<string, number>()\ntyped.set("a", 1)\n',
        'export class Store {\n  constructor(private root: string) {}\n  path() {\n    return this.root\n  }\n}\n',
        "export { helper } from './helper.ts'\n",
        'export function first<T>(xs: T[]): T | undefined {\n  return xs[0]\n}\n',
        'export const counts = new Map<string, Set<string>>()\nconst now = Date.now()\nexport const at = String(now)\n',
        // ES private fields. Without the `#` arm in isMemberAccess the name is
        // read as an undeclared callee and an ordinary class is reported as
        // calling an unvetted global `m`. Found by planting ordinary code
        // rather than by planting an attack, which is the only way this class
        // of defect surfaces.
        'export class Cache<T> {\n  readonly #m = new Map<string, T>()\n  get(k: string) {\n    return this.#m.get(k)\n  }\n}\n',
      ]
      for (const src of ordinary)
        expect(`${src.slice(0, 24)} :: ${moduleRisks(src).join(' | ')}`).toBe(
          `${src.slice(0, 24)} :: `,
        )
    })

    test('an opaque import() is reported', () => {
      // Three rules see it, which is the point of layering them: the edge is
      // unresolvable, the token survives the accounted-load subtraction, and
      // the callee is a global nobody vouched for.
      expect(moduleRisks("const spec = './x.ts'\nawait import(spec)\n")).toEqual([
        '1 unresolvable import()/require()',
        '1 unaccounted module-system reference(s): import',
        'calls unvetted global `import`',
      ])
    })

    test('a leftover import.meta.resolve is reported', () => {
      expect(moduleRisks("export const p = import.meta.resolve('./x.ts')\n")).toEqual([
        '1 unaccounted module-system reference(s): import',
        'calls unvetted global `import`',
      ])
    })

    test('a call to an unvetted global is reported, including in statement position', () => {
      // The round-1 hole, as its own control. `declaredNames` used to treat any
      // line-leading `ident(...)` as a method definition, so this exact line
      // registered `Function` as locally declared and skipped the allowlist,
      // and a src/ module carrying it loaded client/crypto.ts with the whole
      // suite green.
      expect(
        moduleRisks(
          "export function warm(spec: string) {\nFunction('s', 'return imp' + 'ort(s)')(spec)\n}\n",
        ),
      ).toEqual(['calls unvetted global `Function`'])
      // And the same callee where it always was caught, so the control cannot
      // pass on the declaration path alone.
      expect(moduleRisks('export const warm = (s: string) => Function(s)()\n')).toEqual([
        'calls unvetted global `Function`',
      ])
    })

    test('an unvetted Bun member is reported', () => {
      expect(moduleRisks("export const out = Bun.spawnSync(['cat', '/etc/hostname'])\n")).toEqual([
        'uses unvetted `Bun.spawnSync`',
      ])
    })

    test('an unvetted bare specifier is reported', () => {
      expect(
        moduleRisks(
          "import { createRequire } from 'node:module'\nexport const r = createRequire('.')\n",
        ),
      ).toEqual(['imports unvetted bare specifier `node:module`'])
    })

    test('an unclassified extension is reported', () => {
      const dir = tmp({ 'a.ts': 'export const a = 1\n', 'b.rs': 'fn main() {}\n' })
      try {
        const { files, unclassified } = classifyTree(dir)
        expect(unclassified.map(u => u.split('/').pop())).toEqual(['b.rs'])
        expect(files.map(f => f.split('/').pop())).toEqual(['a.ts'])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test('a symlink is reported rather than followed, whatever it is named', () => {
      const dir = tmp({ 'real.ts': 'export const a = 1\n' })
      try {
        // Both demonstrated shapes: an executable-looking link, and a
        // `.json`-suffixed one that the extension lists would wave through as
        // inert. Neither may be classified by its lexical name.
        symlinkSync(join(REPO_ROOT, 'client/crypto.ts'), join(dir, 'shim.ts'))
        symlinkSync(join(REPO_ROOT, 'client'), join(dir, 'vendor.json'))
        const { files, unclassified } = classifyTree(dir)
        expect(unclassified.map(u => u.split('/').pop()).sort()).toEqual([
          'shim.ts (symlink)',
          'vendor.json (symlink)',
        ])
        expect(files.map(f => f.split('/').pop())).toEqual(['real.ts'])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('corpus provenance', () => {
    test('an identifier the fixture does not declare is reported', () => {
      expect(corpusRisks("export const CORPUS = { 'a.md': WeakRef }\n")).toEqual([
        'names unvetted identifier `WeakRef`',
      ])
    })

    test('a banned property is reported in both spellings', () => {
      // `String` is on the identifier allowlist and `String.constructor` IS
      // `Function`, so the identifier pin alone allowlists the whole language.
      expect(
        corpusRisks("export const CORPUS = { 'a.md': String.constructor('return 1')() }\n"),
      ).toEqual(['reaches property `constructor`'])
      // Computed access with a literal key: `stripToCode` blanks the string, so
      // this spelling is invisible to a code-only scan.
      expect(
        corpusRisks("export const CORPUS = { 'a.md': String['constructor']('return 1')() }\n"),
      ).toEqual(['reaches property `constructor`'])
    })

    test('a capability token inside a string literal is reported', () => {
      // The verified evasion, whole: allowlisted identifier, banned property,
      // and the capability named only inside a string. Both rules must fire.
      expect(
        corpusRisks(
          "export const CORPUS = { 'a.md': String.constructor('return Bun.file(\"/etc/hostname\")')() }\n",
        ),
      ).toEqual(['reaches property `constructor`', 'carries capability token `Bun`'])
    })

    test('a module-system reference is reported', () => {
      expect(corpusRisks('export const dir = import.meta.dir\n')).toEqual([
        'names unvetted identifier `import`',
        '1 module-system reference(s)',
        'carries capability token `import`',
      ])
    })

    test('an input hook is reported, and an identifier that merely contains one is not', () => {
      expect(corpusRisks('export const home = process.env.HOME\n')).toEqual([
        'names unvetted identifier `process`',
        'carries input hook `\\bprocess\\b`',
      ])
      // Substring matching read this as a violation, which is the cry-wolf
      // failure that gets a guard deleted rather than fixed.
      expect(
        corpusRisks("const processedRoots = 1\nexport const CORPUS = { 'a.md': processedRoots }\n"),
      ).toEqual([])
    })

    test('a module whose exports depend on the environment is reported', () => {
      const dir = tmp({ 'env.ts': 'export const WHERE = process.env.HOME ?? "none"\n' })
      try {
        const probe = `
const m = await import(${JSON.stringify(join(dir, 'env.ts'))})
process.stdout.write(JSON.stringify(Object.keys(m).sort().map(k => [k, m[k]])))
`
        expect(reproducibility(probe).risks).toEqual(['exports differ across cwd and environment'])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test('a self-contained module is reproducible', () => {
      // The other direction, so the control above cannot pass by reporting
      // every module as non-reproducible.
      const dir = tmp({ 'flat.ts': 'export const WHERE = "fixed"\n' })
      try {
        const probe = `
const m = await import(${JSON.stringify(join(dir, 'flat.ts'))})
process.stdout.write(JSON.stringify(Object.keys(m).sort().map(k => [k, m[k]])))
`
        const { risks, out } = reproducibility(probe)
        expect(risks).toEqual([])
        expect(out).toContain('fixed')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('wire checks', () => {
    const sentinel = 'ZQXJ-control-sentinel-ZQXJ'
    const origin = 'http://recall-r18.test'
    const empty = (): Capture => ({ hrefs: [], headers: [], bodies: [], unrecognised: [] })

    test('an off-origin request is reported', () => {
      const cap = empty()
      cap.hrefs.push(`${origin}/v1/x`, 'http://elsewhere.test/v1/x')
      expect(wireRisks(cap, sentinel, origin)).toEqual([
        'off-origin request to http://elsewhere.test',
      ])
    })

    test('plaintext in a url is reported', () => {
      const cap = empty()
      cap.hrefs.push(`${origin}/v1/x?key=${sentinel}`)
      expect(wireRisks(cap, sentinel, origin)).toEqual(['plaintext in url'])
    })

    test('plaintext in a header is reported', () => {
      const cap = empty()
      cap.headers.push(`x-note: ${sentinel}`)
      expect(wireRisks(cap, sentinel, origin)).toEqual(['plaintext in header'])
    })

    test('plaintext in a body is reported', () => {
      const cap = empty()
      cap.bodies.push(`{"entries":{"a.md":"${sentinel}"}}`)
      expect(wireRisks(cap, sentinel, origin)).toEqual(['plaintext in body'])
    })

    test('an unreadable body type is reported rather than scanned as empty', async () => {
      const cap = empty()
      const stream = new Response(sentinel).body as ReadableStream
      expect(await bodyText(stream as unknown as BodyInit, cap)).toBe('')
      expect(wireRisks(cap, sentinel, origin)).toEqual([
        'unreadable body type [object ReadableStream]',
      ])
    })

    test('a body carried on a Request object is captured, not missed', async () => {
      // `fetch(new Request(url, { method: 'PUT', body }))` puts the body
      // somewhere `init.body` does not appear, so the interceptor recorded the
      // empty string and "no body carried plaintext" held for a body that did.
      const { cap, fn } = intercept(async () => new Response(null, { status: 204 }))
      const res = await fn(new Request(`${origin}/v1/x`, { method: 'PUT', body: sentinel }))
      expect(res.status).toBe(204)
      expect(cap.bodies).toEqual([sentinel])
      expect(wireRisks(cap, sentinel, origin)).toEqual(['plaintext in body'])
    })

    test('a clean capture reports nothing', () => {
      const cap = empty()
      cap.hrefs.push(`${origin}/v1/x`)
      cap.headers.push('content-type: application/json')
      cap.bodies.push('{"entries":{"a.md":"Y2lwaGVydGV4dA=="}}')
      expect(wireRisks(cap, sentinel, origin)).toEqual([])
    })
  })

  test('no capability root is hiding in the pure-builtin list', () => {
    // The split into PURE_BUILTINS and VETTED_GLOBALS created a way to weaken
    // the boundary that reads as tidying: move a name into the list nobody
    // reviews. These are the names that must never be in it.
    expect(CAPABILITY_ROOTS.filter(n => PURE_BUILTINS.has(n))).toEqual([])
    expect(CAPABILITY_ROOTS.filter(n => VETTED_GLOBALS.has(n))).toEqual([])
    // And the pure list must not be empty of the names it exists to permit,
    // which is how "just delete the list" would otherwise pass.
    for (const n of ['Map', 'Set', 'RegExp', 'Date', 'Promise', 'setTimeout'])
      expect(`${n}:${PURE_BUILTINS.has(n)}`).toBe(`${n}:true`)
  })
})
