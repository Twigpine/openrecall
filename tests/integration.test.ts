/**
 * Full end-to-end: real Bun.serve + real OpenRecallClient over HTTP, proving the
 * zero-knowledge roundtrip and that what lands on disk is unreadable ciphertext.
 *
 * Env is set before the dynamic imports so config.ts reads the test settings.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { namespaceSlug } from '../src/namespace.ts'
import { contentPath } from '../src/store/blobstore.ts'

// Storage/auth/limit env is set in tests/setup.ts (preload) so config.ts reads
// it no matter which test file loads first.
const DATA_DIR = process.env.DATA_DIR!

let server: ReturnType<typeof Bun.serve>
let base: string
let OpenRecallClient: typeof import('../client/index.ts').OpenRecallClient

beforeAll(async () => {
  const { handleRequest } = await import('../src/handler.ts')
  ;({ OpenRecallClient } = await import('../client/index.ts'))
  server = Bun.serve({ port: 0, fetch: handleRequest })
  base = `http://localhost:${server.port}`
})

afterAll(() => server?.stop(true))

function client(passphrase = 'test-pass') {
  return new OpenRecallClient({ url: base, passphrase })
}

describe('end-to-end zero-knowledge sync', () => {
  const ns = 'user:local'

  test('pull on empty namespace returns nothing (404 → empty)', async () => {
    const r = await client().pull(ns)
    expect(r.version).toBe(0)
    expect(Object.keys(r.entries)).toHaveLength(0)
  })

  test('push then pull roundtrips plaintext', async () => {
    const c = client()
    const push = await c.push(ns, {
      'MEMORY.md': '# index\n- [a](a.md)',
      'a.md': 'the user prefers terse answers',
    })
    expect(push.uploaded.sort()).toEqual(['MEMORY.md', 'a.md'])
    expect(push.version).toBe(1)

    const pull = await c.pull(ns)
    expect(pull.entries['MEMORY.md']).toBe('# index\n- [a](a.md)')
    expect(pull.entries['a.md']).toBe('the user prefers terse answers')
  })

  test('what is stored on disk is ciphertext, not plaintext', () => {
    // Walk the data dir; no file should contain the plaintext.
    const found: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else found.push(readFileSync(p, 'utf8').toString())
      }
    }
    walk(DATA_DIR)
    const blob = found.join('\n')
    expect(blob).not.toContain('terse answers')
    expect(blob).not.toContain('the user prefers')
  })

  test('second push of identical content uploads nothing (delta)', async () => {
    const c = client()
    const push = await c.push(ns, {
      'MEMORY.md': '# index\n- [a](a.md)',
      'a.md': 'the user prefers terse answers',
    })
    expect(push.uploaded).toHaveLength(0)
    expect(push.unchanged.sort()).toEqual(['MEMORY.md', 'a.md'])
  })

  test('changing one entry uploads only that entry', async () => {
    const c = client()
    const push = await c.push(ns, {
      'MEMORY.md': '# index\n- [a](a.md)',
      'a.md': 'CHANGED: user now wants detailed answers',
    })
    expect(push.uploaded).toEqual(['a.md'])
    expect(push.unchanged).toEqual(['MEMORY.md'])
    const pull = await c.pull(ns)
    expect(pull.entries['a.md']).toBe('CHANGED: user now wants detailed answers')
  })

  test('delete removes an entry', async () => {
    const c = client()
    await c.delete(ns, 'a.md')
    const pull = await c.pull(ns)
    expect(pull.entries['a.md']).toBeUndefined()
    expect(pull.entries['MEMORY.md']).toBeDefined()
  })

  test('a different passphrase cannot read the data (zero-knowledge)', async () => {
    const wrong = client('totally-different-pass')
    await expect(wrong.pull(ns)).rejects.toThrow()
  })

  test('entry-count cap is enforced (413)', async () => {
    const c = client()
    const many: Record<string, string> = {}
    for (let i = 0; i < 10; i++) many[`f${i}.md`] = `content ${i}`
    await expect(c.push('user:local/capns', many)).rejects.toThrow(/413|too_many/)
  })

  test('path-traversal entry key is rejected', async () => {
    const res = await fetch(`${base}/api/memory/${encodeURIComponent(ns)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: { '../escape': 'x' } }),
    })
    const body = (await res.json()) as { skipped?: { key: string; reason: string }[] }
    expect(body.skipped?.[0]?.reason).toBe('invalid_key')
  })
})

/**
 * The manifest already records when each entry was last written; until now
 * nothing outside the server could see it. These pin the surfacing itself,
 * against the real server rather than a stub, so the assertion fails when the
 * field stops being written on the wire.
 *
 * Shape, never wall-clock equality: the server stamps its own clock, so an
 * assertion on a literal timestamp would pass only on the machine that wrote it.
 */
describe('per-entry updatedAt', () => {
  const ns = 'user:local'
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

  // Seed our own fixtures rather than inheriting whatever an earlier describe
  // left behind. Without this the suite passes only in whole-file order and
  // dies under `bun test -t <pattern>`, which CLAUDE.md documents as a normal
  // workflow: the namespace is empty, the GET 404s, and the failure surfaces as
  // a TypeError about `content` rather than as the assertion that was meant.
  beforeAll(async () => {
    await client().push(ns, { 'ts-a.md': 'first entry', 'ts-b.md': 'second entry' })
  })

  test('pull exposes per-entry updatedAt from the manifest', async () => {
    const c = client()
    const pull = await c.pull(ns)
    expect(Object.keys(pull.updatedAt).sort()).toEqual(
      expect.arrayContaining(['ts-a.md', 'ts-b.md']),
    )
    expect(pull.updatedAt['ts-a.md']).toMatch(ISO)
    expect(pull.updatedAt['ts-b.md']).toMatch(ISO)
  })

  test('writing one entry moves only that entry timestamp', async () => {
    const c = client()
    const before = (await c.pull(ns)).updatedAt
    // The server stamps one clock value per PUT at millisecond resolution, so
    // without a gap a rewrite can land in the same millisecond and the "it
    // moved" half of this test would pass vacuously.
    await new Promise(r => setTimeout(r, 5))
    await c.push(ns, { 'ts-a.md': 'first entry, revised' })
    const after = (await c.pull(ns)).updatedAt
    expect(after['ts-a.md']).not.toBe(before['ts-a.md'])
    expect(after['ts-b.md']).toBe(before['ts-b.md'])
  })

  test('a re-push of identical plaintext uploads nothing and moves no timestamp', async () => {
    const c = client()
    const before = (await c.pull(ns)).updatedAt
    // Non-vacuity: without this, deleting the feature makes `before` and the
    // comparison below both `{}`, and `toEqual` passes on two empty maps. A
    // mutation run proved that: removing the getData write left this test
    // green. Assert the map is populated before asserting it did not change.
    expect(before['ts-a.md']).toMatch(ISO)
    expect(before['ts-b.md']).toMatch(ISO)
    await new Promise(r => setTimeout(r, 5))
    // Client half: push filters unchanged entries by ciphertext hash before any
    // PUT exists, so this asserts what is reachable through the client, and
    // deliberately makes no claim about PUT contents.
    const push = await c.push(ns, { 'ts-a.md': 'first entry, revised' })
    expect(push.uploaded).toHaveLength(0)
    expect((await c.pull(ns)).updatedAt).toEqual(before)
  })

  test('a raw PUT of byte-identical ciphertext moves no timestamp', async () => {
    const c = client()
    const before = (await c.pull(ns)).updatedAt
    expect(before['ts-b.md']).toMatch(ISO) // non-vacuity, same reason as above
    // Server half: the client would filter this out, so go around it and hand
    // the server back the exact bytes it already holds. This is the only way
    // to reach the hash-equal skip in the write path.
    const raw = (await (await fetch(`${base}/api/memory/${encodeURIComponent(ns)}`)).json()) as {
      content: { entries: Record<string, string> }
    }
    await new Promise(r => setTimeout(r, 5))
    const res = await fetch(`${base}/api/memory/${encodeURIComponent(ns)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: { 'ts-b.md': raw.content.entries['ts-b.md'] } }),
    })
    expect(res.ok).toBe(true)
    expect((await c.pull(ns)).updatedAt['ts-b.md']).toBe(before['ts-b.md'])
  })

  test('an entry whose blob is missing is omitted from every map', async () => {
    // `getData` skips a manifest entry whose blob has gone (drift, rather than
    // 500ing), and the timestamp copy sits after that guard so the three maps
    // stay key-consistent. The comment in src/memory.ts claims that invariant;
    // this executes it. Removing the guard's protection by copying the
    // timestamp above the `if (!bytes) return` makes this test fail.
    const c = client()
    const key = 'ts-drift.md'
    await c.push(ns, { [key]: 'this entry is about to lose its blob' })
    expect((await c.pull(ns)).updatedAt[key]).toMatch(ISO) // non-vacuity: it was there

    // Blobs are named by their ciphertext hash, not the entry key, so take the
    // hash the manifest holds. No `force`: if the layout moves again, a delete
    // that finds nothing throws here instead of leaving the blob in place and
    // the assertions below checking a namespace that never drifted.
    const hash = (await c.hashes(ns))[key] as string
    rmSync(join(DATA_DIR, contentPath(namespaceSlug(ns), hash)))

    // Assert on the WIRE, not through pull(). Going through the client proves
    // nothing here: its sanitizer only keeps keys present in the decrypted
    // entries, so it drops a stray timestamp on its own and the server-side
    // invariant becomes unobservable. Measured, hoisting the timestamp copy
    // above the drift guard in getData left a pull()-based assertion green.
    const raw = (await (await fetch(`${base}/api/memory/${encodeURIComponent(ns)}`)).json()) as {
      content: { entries: Record<string, string>; entryUpdatedAt: Record<string, string> }
    }
    expect(Object.keys(raw.content.entryUpdatedAt)).toContain('ts-a.md') // non-vacuity
    expect(raw.content.entries[key]).toBeUndefined()
    expect(raw.content.entryUpdatedAt[key]).toBeUndefined()

    // End to end, the client agrees and the surviving entries are untouched,
    // so this is a skip rather than a wipe.
    const pull = await c.pull(ns)
    expect(pull.entries[key]).toBeUndefined()
    expect(pull.updatedAt[key]).toBeUndefined()
    expect(pull.updatedAt['ts-a.md']).toMatch(ISO)

    await c.delete(ns, key) // leave the namespace as we found it
  })
})

/**
 * The timestamp map is the first thing the client acts on that the crypto does
 * not vouch for, so these drive hostile and merely old response shapes through
 * the real `pull` with the network stubbed. Each asserts the same contract:
 * whatever arrives, the caller gets a clean map of real entry keys and nothing
 * throws.
 */
describe('updatedAt sanitization', () => {
  const ns = 'user:local'
  const realFetch = globalThis.fetch

  // Own fixtures, same reason as the describe above: `pullWith` reads real
  // ciphertext off the server, so without seeding, a filtered run finds an
  // empty namespace and dies on `real.content` rather than asserting anything.
  beforeAll(async () => {
    await client().push(ns, { 'ts-a.md': 'first entry', 'ts-b.md': 'second entry' })
  })

  afterAll(() => {
    globalThis.fetch = realFetch
  })

  /** Serve one crafted `entryUpdatedAt` alongside genuine ciphertext. */
  async function pullWith(entryUpdatedAt: unknown) {
    const c = client()
    const real = (await (
      await realFetch(`${base}/api/memory/${encodeURIComponent(ns)}`)
    ).json()) as { version: number; content: { entries: Record<string, string> } }
    globalThis.fetch = (async () =>
      Response.json({
        version: real.version,
        content: { entries: real.content.entries, entryUpdatedAt },
      })) as unknown as typeof fetch
    try {
      return await c.pull(ns)
    } finally {
      globalThis.fetch = realFetch
    }
  }

  test('a hostile or malformed field yields a clean map, never a throw', async () => {
    const cases: [string, unknown][] = [
      ['a bare string', 'not-a-map'],
      ['an array', ['2026-08-06T00:00:00.000Z']],
      ['null', null],
      ['a number', 42],
    ]
    for (const [label, value] of cases) {
      const pull = await pullWith(value)
      expect(`${label} -> ${JSON.stringify(pull.updatedAt)}`).toBe(`${label} -> {}`)
    }
  })

  test('non-string values and unknown keys are dropped, real ones kept', async () => {
    const pull = await pullWith({
      'ts-a.md': '2026-08-06T00:00:00.000Z',
      'ts-b.md': 12345,
      'no-such-entry.md': '2026-08-06T00:00:00.000Z',
    })
    expect(pull.updatedAt).toEqual({ 'ts-a.md': '2026-08-06T00:00:00.000Z' })
  })

  test('an inherited key cannot reach the result', async () => {
    // The FIRST version of this test passed `{"__proto__":{"ts-a.md":"pwned"}}`
    // and asserted an empty map. It could not fail: JSON.parse makes
    // `__proto__` an ordinary own property, and the loop only ever looks up
    // decrypted entry keys, so that payload is never consulted. Deleting the
    // `Object.hasOwn` guard left the whole suite green, measured.
    //
    // This version pollutes the prototype for real, so the lookup the loop DOES
    // perform (`ts-a.md`) resolves through the prototype chain unless the guard
    // stops it.
    //
    // The payload must be a VALID timestamp. A first attempt used 'pwned', and
    // the mutation run still showed 0 failures with `Object.hasOwn` deleted:
    // the inherited value was reaching the loop exactly as feared, then being
    // dropped by the Date.parse check instead. That made this test look like it
    // covered the own-property guard while actually covering a different one.
    const proto = Object.prototype as unknown as Record<string, unknown>
    proto['ts-a.md'] = '2026-01-01T00:00:00.000Z'
    try {
      const pull = await pullWith({})
      expect(pull.updatedAt).toEqual({})
    } finally {
      delete proto['ts-a.md']
    }
  })

  test('an oversized or unparseable value is dropped', async () => {
    // Measured before this guard existed: a 20,000,000-character string passed
    // through untouched. The key space was bounded, the value space was not.
    const pull = await pullWith({
      'ts-a.md': 'A'.repeat(20_000),
      'ts-b.md': 'not-a-date',
    })
    expect(pull.updatedAt).toEqual({})
  })

  test('a 200 with no content.entries is a protocol error, not a TypeError', async () => {
    // Three reviewers flagged that this used to throw a raw
    // `TypeError: undefined is not an object` out of Object.entries. It failed
    // closed either way, so this is about naming the fault, not about safety.
    const realGlobal = globalThis.fetch
    for (const body of [
      { version: 1 },
      { version: 1, content: null },
      { version: 1, content: 'x' },
    ]) {
      globalThis.fetch = (async () => Response.json(body)) as unknown as typeof fetch
      try {
        await expect(client().pull(ns)).rejects.toThrow(/malformed body/)
      } finally {
        globalThis.fetch = realGlobal
      }
    }
  })

  test('an older server without the field degrades to an empty map', async () => {
    const pull = await pullWith(undefined)
    expect(pull.updatedAt).toEqual({})
    expect(Object.keys(pull.entries).length).toBeGreaterThan(0)
  })

  test('a new namespace (404) yields an empty map beside empty entries', async () => {
    const pull = await client().pull('user:local/never-written')
    expect(pull.updatedAt).toEqual({})
    expect(pull.entries).toEqual({})
    expect(pull.version).toBe(0)
  })
})
