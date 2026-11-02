/**
 * Full end-to-end: real Bun.serve + real OpenRecallClient over HTTP, proving the
 * zero-knowledge roundtrip and that what lands on disk is unreadable ciphertext.
 *
 * Env is set before the dynamic imports so config.ts reads the test settings.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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
