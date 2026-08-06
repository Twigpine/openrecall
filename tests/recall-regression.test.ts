/**
 * Recall regression harness.
 *
 * This suite is the evidence trail for the recall work: it pins what the ranker
 * does today so every later unit has a mechanical flip to point at instead of an
 * impression. Pairs the current ranker already answers are hard assertions and
 * must stay green forever. Pairs it gets wrong that phase 1 will fix carry a
 * `test.failing` marker naming the unit set that closes them; bun runs a failing
 * test's body under plain `bun test`, so the marker turns red the moment the
 * body starts passing, which is exactly the signal we want. `test.todo` is
 * deliberately not used: its body never executes under the bare `bun test` that
 * CI runs, so it would prove nothing. Pairs phase 1 does not close are reported
 * rather than marked, because a marker that can never flip is noise.
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
import { rankMemories } from '../src/mcp/relevance.ts'
import { makeTools } from '../src/mcp/tools.ts'
import { BASELINE_RANK_MS, CORPUS, HELD_OUT, sharedTerms, TUNING } from './recall-corpus.ts'

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
    // Non-vacuous: the control pair plus the three test.failing markers.
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
  test.failing('closed by {U2}: "deployment process" ranks the deploy note first', () => {
    const p = keyPairFor('deployment process')
    expect(rankMemories(p.query, CORPUS)[0]?.key).toBe(p.expect)
  })

  // The note says "opening PRs"; the query says "open a pull request". No shared
  // token survives the tokenizer, so the entry that answers the question is
  // dropped entirely before scoring.
  test.failing('closed by {U2}: "am I allowed to open a pull request" finds the rule', () => {
    const p = keyPairFor('am I allowed to open a pull request')
    expect(rankMemories(p.query, CORPUS)[0]?.key).toBe(p.expect)
  })

  // Three entries each match exactly one query term once, tie on score, and the
  // key sort picks the winner. Stemming alone lifts the right entry to two
  // terms; rarity weighting is what stops a common term from tying it again.
  test.failing('closed by {U2, U3}: the push query beats the one-term tie', () => {
    const p = keyPairFor('what do I need to do before I push my work to the remote')
    expect(rankMemories(p.query, CORPUS)[0]?.key).toBe(p.expect)
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
  test('reports the width of the conventions tie', () => {
    const p = pairFor('why do we hold these conventions')
    const ranked = rankMemories(p.query, CORPUS, Object.keys(CORPUS).length)
    const topScore = ranked[0]?.score ?? 0
    const tied = ranked.filter(r => r.score === topScore)
    console.log(`[residual] conventions tie width=${tied.length} at score ${topScore.toFixed(3)}`)
    expect(tied.length).toBeGreaterThan(1)
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
      const shared = sharedTerms(p.query, p.expect, body)
      expect(`${p.query} :: ${shared.join(',')}`).toBe(
        `${p.query} :: ${shared.slice(0, 1).join(',')}`,
      )
    }
  })

  test('has at least ten pairs', () => {
    expect(HELD_OUT.length).toBeGreaterThanOrEqual(10)
  })

  // Reported, never asserted all-green. This number is the U1 baseline the
  // definition of done compares later units against, so it is printed rather
  // than buried in an expectation.
  test('reports the held-out pass rate', () => {
    const passed = HELD_OUT.filter(p => rankMemories(p.query, CORPUS)[0]?.key === p.expect)
    const rate = ((passed.length / HELD_OUT.length) * 100).toFixed(0)
    console.log(`[held-out] ${passed.length}/${HELD_OUT.length} (${rate}%) top-1 correct`)
    expect(HELD_OUT.length).toBeGreaterThan(0)
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

  test('the near-cap generator is deterministic', () => {
    expect(BASELINE_RANK_MS).toBeGreaterThan(0)
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

    // Non-vacuous: the walk must actually have found the server modules.
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
      await tools.delete('notes/plain.md')
    } finally {
      globalThis.fetch = realFetch
    }

    // Non-vacuous: five tool calls must have produced traffic before the
    // all-equal assertion means anything.
    expect(hrefs.length).toBeGreaterThanOrEqual(5)
    expect([...new Set(hrefs.map(h => new URL(h).origin))]).toEqual([url])

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
