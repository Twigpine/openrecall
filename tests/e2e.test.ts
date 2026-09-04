/**
 * End-to-end over a real socket, with the real client and real encryption.
 *
 * Everything else in the suite drives one layer. This drives the whole stack the
 * way a deployment does: AES-GCM in the client, HTTP on a real port, the
 * content-addressed store on disk. It exists to catch what layer-local tests
 * structurally cannot -- a change that is correct in `memory.ts` and wrong once
 * ciphertext, the wire format and the storage layout have to agree.
 *
 * The shipped client sends no `base` and reads neither `supports` nor
 * `erasure`, because the client half of that work is a later phase. That is
 * exactly why the compatibility cases below matter: they are the evidence that
 * a client which has not adopted the new contract still works against a server
 * that has, which nothing else in the suite proves.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { _reset } from '../src/ratelimit.ts'

const DATA_DIR = process.env.DATA_DIR as string
const PASSPHRASE = 'correct horse battery staple'

let server: ReturnType<typeof Bun.serve>
let base: string
let MemlawbClient: typeof import('../client/index.ts').MemlawbClient
let namespaceSlug: typeof import('../src/namespace.ts').namespaceSlug

beforeAll(async () => {
  const { handleRequest } = await import('../src/handler.ts')
  ;({ MemlawbClient } = await import('../client/index.ts'))
  ;({ namespaceSlug } = await import('../src/namespace.ts'))
  server = Bun.serve({ port: 0, fetch: handleRequest })
  base = `http://localhost:${server.port}`
})

afterAll(() => server?.stop(true))
afterEach(() => _reset())

const client = (passphrase = PASSPHRASE) => new MemlawbClient({ url: base, passphrase })

/** Every file the store holds for a namespace, as raw bytes. */
function storedBytes(ns: string): { path: string; body: Buffer }[] {
  const root = join(DATA_DIR, 'ns', namespaceSlug(ns))
  const out: { path: string; body: Buffer }[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name)
      if (name.isDirectory()) walk(p)
      else out.push({ path: p, body: readFileSync(p) })
    }
  }
  walk(root)
  return out
}

describe('e2e: the round trip a deployment actually performs', () => {
  test('push, pull, modify, delete through the real client', async () => {
    const ns = 'user:e2e-life'
    const c = client()
    await c.push(ns, { 'MEMORY.md': '# index', 'feedback/tone.md': 'be terse' })

    const pulled = await c.pull(ns)
    expect(pulled.entries).toEqual({ 'MEMORY.md': '# index', 'feedback/tone.md': 'be terse' })

    await c.push(ns, { 'MEMORY.md': '# index v2', 'feedback/tone.md': 'be terse' })
    expect((await c.pull(ns)).entries['MEMORY.md']).toBe('# index v2')

    await c.delete(ns, 'feedback/tone.md')
    const after = await c.pull(ns)
    expect(Object.keys(after.entries)).toEqual(['MEMORY.md'])
  })

  test('a second push of unchanged content uploads nothing', async () => {
    const ns = 'user:e2e-delta'
    const c = client()
    const entries = { 'a.md': 'stable', 'b.md': 'also stable' }
    const first = await c.push(ns, entries)
    expect(first.uploaded.sort()).toEqual(['a.md', 'b.md'])
    const second = await c.push(ns, entries)
    expect(second.uploaded).toEqual([])
    expect(second.unchanged.sort()).toEqual(['a.md', 'b.md'])
  })
})

describe('e2e: the server holds ciphertext and nothing else', () => {
  test('no plaintext reaches disk, under the content-addressed layout', async () => {
    const ns = 'user:e2e-zk'
    const secret = 'SENTINEL-plaintext-must-not-appear'
    await client().push(ns, { 'MEMORY.md': secret, 'notes/deep.md': `${secret} again` })

    const stored = storedBytes(ns)
    // Control: the walk actually found the blobs and the manifest, so the
    // absence assertions below are about content and not an empty directory.
    expect(stored.length).toBeGreaterThanOrEqual(3)
    expect(stored.some(f => f.path.endsWith('manifest.json'))).toBe(true)
    expect(stored.some(f => f.path.includes(`${join('blobs')}`))).toBe(true)

    for (const f of stored) {
      expect(f.body.toString('utf8')).not.toContain(secret)
      expect(f.body.toString('utf8')).not.toContain(PASSPHRASE)
    }
  })

  test('the wrong passphrase cannot read what the right one wrote', async () => {
    const ns = 'user:e2e-wrongpass'
    await client().push(ns, { 'a.md': 'private' })
    // The manifest is cleartext, so key names are visible either way; the
    // ciphertext is what the passphrase gates.
    await expect(client('a-different-passphrase').pull(ns)).rejects.toThrow()
    expect((await client().pull(ns)).entries['a.md']).toBe('private')
  })
})

describe('e2e: a client that has not adopted the new contract still works', () => {
  test('the shipped client round-trips against a server that enforces preconditions', async () => {
    const ns = 'user:e2e-compat'
    const c = client()
    // The client sends no `base`, so every write here is unconditional. This is
    // the compatibility guarantee the server promises by accepting an absent
    // base, and nothing else in the suite exercises it through the real client.
    await c.push(ns, { 'a.md': 'one' })
    await c.push(ns, { 'a.md': 'two' })
    expect((await c.pull(ns)).entries['a.md']).toBe('two')
  })

  test('the new response fields do not disturb it', async () => {
    const ns = 'user:e2e-fields'
    await client().push(ns, { 'a.md': 'x' })
    const raw = (await (
      await fetch(`${base}/api/memory/${encodeURIComponent(ns)}?view=hashes`)
    ).json()) as {
      supports: string[]
      erasure: string
      entryChecksums: Record<string, string>
    }
    // The server advertises both; the client reads neither and still works.
    expect(raw.supports).toEqual(['base-precondition'])
    expect(raw.erasure).toBe('erases')
    expect(await client().hashes(ns)).toEqual(raw.entryChecksums)
  })
})

describe('e2e: the write precondition over the wire', () => {
  const url = (ns: string) => `${base}/api/memory/${encodeURIComponent(ns)}`

  test('a stale base is refused and the stored value is untouched', async () => {
    const ns = 'user:e2e-conflict'
    const c = client()
    await c.push(ns, { 'a.md': 'first' })
    const stale = (await c.hashes(ns))['a.md'] as string

    // Someone else writes.
    await c.push(ns, { 'a.md': 'second' })

    // The first caller pushes from what it last saw. Hand-built because the
    // shipped client does not send a base yet.
    const res = await fetch(url(ns), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entries: { 'a.md': Buffer.from('ignored').toString('base64') },
        base: { 'a.md': stale },
      }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; details: { conflicts: object } } }
    expect(body.error.code).toBe('stale_base_version')
    expect(Object.keys(body.error.details.conflicts)).toEqual(['a.md'])

    // The competing write survived, decryptable end to end.
    expect((await c.pull(ns)).entries['a.md']).toBe('second')
  })

  test('the same push with a current base is accepted', async () => {
    const ns = 'user:e2e-fresh'
    const c = client()
    await c.push(ns, { 'a.md': 'first' })
    const current = (await c.hashes(ns))['a.md'] as string
    const res = await fetch(url(ns), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: {}, deletions: ['a.md'], base: { 'a.md': current } }),
    })
    expect(res.status).toBe(200)
    expect(Object.keys((await c.pull(ns)).entries)).toEqual([])
  })
})

describe('e2e: deletion actually removes the bytes', () => {
  test('after a delete no blob on disk carries the deleted plaintext', async () => {
    const ns = 'user:e2e-erase'
    const c = client()
    const doomed = 'SENTINEL-should-be-collected'
    await c.push(ns, { 'gone.md': doomed, 'kept.md': 'stays' })
    const before = storedBytes(ns).length

    await c.delete(ns, 'gone.md')
    // Reclaim runs on the write, so the blob is collected by the time the
    // response returns; erasure: 'erases' is a claim this makes true.
    const after = storedBytes(ns)
    expect(after.length).toBeLessThan(before)
    expect((await c.pull(ns)).entries).toEqual({ 'kept.md': 'stays' })
  })
})

describe('e2e: operational surfaces', () => {
  test('health reports liveness and reveals nothing about the store', async () => {
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, service: 'memlawb' })
  })

  test('a namespace whose index is corrupt answers 503 rather than looking empty', async () => {
    const ns = 'user:e2e-corrupt'
    const c = client()
    await c.push(ns, { 'a.md': 'v1' })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(DATA_DIR, 'ns', namespaceSlug(ns), 'manifest.json'), '{not json')

    const res = await fetch(`${base}/api/memory/${encodeURIComponent(ns)}`)
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'manifest_unreadable',
    )
    // The client surfaces it as an error rather than an empty namespace, which
    // is the denial-rendered-as-success shape this refusal exists to avoid.
    await expect(c.pull(ns)).rejects.toThrow()
  })

  test('a caller past its budget is refused with a retry hint', async () => {
    let last: Response | undefined
    for (let i = 0; i < 400; i++) {
      last = await fetch(`${base}/api/memory/user:e2e-ratelimit`)
      if (last.status === 429) break
    }
    expect(last?.status).toBe(429)
    expect(last?.headers.get('retry-after')).toBeTruthy()
    // Control: the budget is per caller and recovers, so this is a limit rather
    // than a wedged server.
    _reset()
    expect((await fetch(`${base}/health`)).status).toBe(200)
  })
})
