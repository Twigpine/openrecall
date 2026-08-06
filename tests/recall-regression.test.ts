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
import { dirname, join, relative, resolve } from 'node:path'
import { MemlawbClient } from '../client/index.ts'
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

/** Minimal client surface makeTools touches. The corpus never goes near the wire. */
function stubClient(entries: Record<string, string>) {
  return {
    pull: async (namespace: string) => ({ namespace, version: 1, entries }),
    push: async (namespace: string) => ({
      namespace,
      version: 1,
      uploaded: [],
      unchanged: [],
      deleted: [],
    }),
    hashes: async () => Object.fromEntries(Object.keys(entries).map(k => [k, 'x'])),
    delete: async () => undefined,
  } as unknown as MemlawbClient
}

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

  /** Matched-term counts for one pair: the target's, and the best any other entry reaches. */
  function arityOf(query: string, expected: string) {
    const qTerms = contentTerms(query, stemTerm)
    const matched = (key: string) => {
      const entry = contentTerms(`${key} ${CORPUS[key]}`, stemTerm)
      return [...qTerms].filter(t => entry.has(t)).length
    }
    const others = Object.keys(CORPUS).filter(k => k !== expected)
    return {
      qTerms: qTerms.size,
      target: matched(expected),
      best: Math.max(...others.map(matched)),
    }
  }

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
    // The index is not a candidate, so nothing was searched: 0, not 1.
    expect(r.text).toBe(
      `(nothing in ${NS} looks relevant to "roadmap onboarding escalation". ` +
        '0 entries searched, 0 below the relevance floor and withheld. ' +
        'Call memory_list before concluding the fact is unrecorded; ' +
        'it may be stored under wording this query did not match.)',
    )
    // Distinct from the empty-namespace message, which this is not.
    expect(r.text).not.toContain('no memory stored')
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

const DYNAMIC_CALL = /\b(?:import|require)\s*\(/g
const DYNAMIC_LITERAL = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g

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

describe('corpus provenance', () => {
  // Mechanical, because the rule is easy to break by accident and impossible to
  // see in a diff review of the corpus body: the fixture must be self-contained
  // synthetic text. If it could read a path, an env var, or the network, then
  // pointing it at a real memory directory would be one line away, and the
  // suite would silently start ranking someone's actual notes.
  test('the corpus module has no runtime input hooks and imports nothing', () => {
    const abs = join(REPO_ROOT, 'tests/recall-corpus.ts')
    const source = stripComments(readFileSync(abs, 'utf8'))
    for (const hook of [
      'readFile',
      'readFileSync',
      'Bun.file',
      'Bun.env',
      'process.env',
      'node:',
      'require(',
      'import(',
      'fetch(',
    ]) {
      expect(`${hook}:${source.includes(hook)}`).toBe(`${hook}:false`)
    }
    // The token list alone was bypassable, and provably so: a helper module doing
    // the readFileSync, imported from here, kept every token out of this file
    // while putting a real memory directory into the ranked corpus. A synthetic
    // fixture needs no imports at all, so the graph must be a single node.
    const edges = edgesOf(abs)
    expect(edges.specs).toEqual([])
    expect(edges.opaque).toBe(0)
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

describe('crypto-blind import boundary', () => {
  // A deny rule over the whole boundary, not an allowlist of known-good module
  // names. An allowlist goes green the day a new src/ module reaches plaintext
  // through src/mcp/tools.ts (which imports client/index.ts) or through a
  // dynamic import of the kind bin/memlawb.ts already uses, which is precisely
  // the regression worth catching. Resolution is transitive for the same reason.
  test('no module under src/ outside src/mcp/ can reach client/ or src/mcp/', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (e.name.endsWith('.ts')) files.push(full)
      }
    }
    walk(join(REPO_ROOT, 'src'))

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

describe('single-origin tool traffic', () => {
  const realFetch = globalThis.fetch
  afterAll(() => {
    globalThis.fetch = realFetch
  })

  // Runnable, not static: server.ts is import-unsafe here (it exits the process
  // at module scope when MEMLAWB_PASSPHRASE is unset, as it is under
  // tests/setup.ts, and connects a stdio transport), so the check runs at the
  // tools/client layer and drives every tool through a stubbed fetch.
  //
  // Origins alone were never the requirement. A client that uploaded plaintext
  // to the configured host would satisfy a single-origin check exactly, so the
  // interceptor captures the full URL and the request body too, and a sentinel
  // string is driven through save so there is something specific to look for.
  test('every tool request goes to the configured origin carrying no plaintext', async () => {
    const url = 'http://recall-r18.test'
    const sentinel = 'ZQXJ-recall-r18-plaintext-sentinel-ZQXJ'
    const hrefs: string[] = []
    const bodies: string[] = []
    // Requests attributable to `get` alone. The total-count guard below is not
    // enough to prove get is covered: the other four tools already clear it
    // between them, so dropping the get call would leave the check silently
    // green over five tools.
    let getHrefs: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      hrefs.push(href)
      bodies.push(typeof init?.body === 'string' ? init.body : (init?.body ?? '').toString())
      const method = init?.method ?? 'GET'
      if (method === 'PUT') return Response.json({ version: 1, deleted: [] })
      if (method === 'DELETE') return new Response(null, { status: 204 })
      // 404 is the empty-namespace path: pull returns no entries, hashes {}.
      return new Response(null, { status: 404 })
    }) as typeof fetch

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
      const beforeGet = hrefs.length
      await tools.get('notes/plain.md')
      getHrefs = hrefs.slice(beforeGet)
      await tools.delete('notes/plain.md')
    } finally {
      globalThis.fetch = realFetch
    }

    // Non-vacuous: six tool calls must have produced traffic before the
    // all-equal assertion means anything.
    expect(hrefs.length).toBeGreaterThanOrEqual(6)
    expect(getHrefs.length).toBeGreaterThanOrEqual(1)
    expect([...new Set(hrefs.map(h => new URL(h).origin))]).toEqual([url])
    expect([...new Set(getHrefs.map(h => new URL(h).origin))]).toEqual([url])

    // Non-vacuous the other way: at least one request must have carried a body,
    // or "the sentinel is in no body" is a statement about nothing.
    expect(bodies.filter(b => b.length > 0).length).toBeGreaterThan(0)
    expect(hrefs.filter(h => h.includes(sentinel))).toEqual([])
    expect(bodies.filter(b => b.includes(sentinel))).toEqual([])

    // And what did go out in place of the plaintext: the single PUT's entry
    // values must be base64 envelopes. Absence of the sentinel on its own would
    // also hold for a body that never contained the entry at all.
    const puts = bodies
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
})
