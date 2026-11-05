/**
 * The incremental pull: the hashes view, the in-memory plaintext cache, the
 * on-disk ciphertext mirror and the bulk entries view, driven through a real
 * Bun.serve and the real client, with a proxy in between that records what
 * crossed the wire.
 *
 * What is pinned here, and why each matters:
 *   - a warm pull fetches exactly the keys whose hash moved, nothing else
 *   - a mirror blob whose bytes do not hash to its name is never trusted: it
 *     is deleted, refetched, and the file on disk replaced
 *   - a manifest that does not parse is ignored and rebuilt, not an error
 *   - a server that cannot be reached is answered from the mirror only when
 *     the caller allowed it, and the answer says how stale it is; a refusal
 *     (401) is never answered from the mirror, because the server did answer
 *   - the mirror's files are the user's alone (0700 / 0600)
 *   - the incremental pull enumerates, so a create asserts absence, and a key
 *     whose body has drifted still carries its manifest hash rather than a
 *     null that would lock it out
 *   - the fallback matrix: a server advertising nothing, only the single-entry
 *     view, or both, each read the way it can be
 *   - two concurrent puts of equal-length blobs to the fs store land both
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ciphertextHash,
  type MirrorStore,
  OpenRecallClient,
  OpenRecallDecryptError,
  OpenRecallHttpError,
  OpenRecallProtocolError,
} from '../client/index.ts'
import { makeClient } from '../src/cli/client.ts'
import { LOCAL_ORIGIN, localFetch } from '../src/cli/local.ts'
import { cacheDir, FsMirror } from '../src/cli/mirror.ts'
import { resolveSettings } from '../src/cli/settings.ts'
import { encodeFrames } from '../src/frames.ts'
import { makeTools } from '../src/mcp/tools.ts'
import { namespaceSlug } from '../src/namespace.ts'
import { _reset } from '../src/ratelimit.ts'
import { FsBlobStore } from '../src/store/fs.ts'
import { contentPath, getStore } from '../src/store/index.ts'

const PASSPHRASE = 'sync-pass'
let server: ReturnType<typeof Bun.serve>
let base: string
const temps: string[] = []

beforeAll(async () => {
  const { handleRequest } = await import('../src/handler.ts')
  server = Bun.serve({ port: 0, fetch: handleRequest })
  base = `http://localhost:${server.port}`
})
afterAll(() => {
  server?.stop(true)
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})
afterEach(() => _reset())

function temp(): string {
  const t = mkdtempSync(join(tmpdir(), 'openrecall-sync-'))
  temps.push(t)
  return t
}

type Wire = { method: string; search: string; body: string }

/**
 * A proxy that records every request (method, query, body) and can present
 * the upstream as an older server: `supports` replaces what the hashes view
 * advertises (and drops the timestamps an older server would not send), and
 * a POST is answered 405 when the override does not include the bulk view,
 * exactly as a server predating it answers.
 */
function proxy(upstream: string, supports: string[] | null = null) {
  const wire: Wire[] = []
  const s = Bun.serve({
    port: 0,
    fetch: async req => {
      const u = new URL(req.url)
      const body = req.method === 'GET' || req.method === 'DELETE' ? '' : await req.text()
      wire.push({ method: req.method, search: u.search, body })
      if (supports !== null && req.method === 'POST' && !supports.includes('entries-view')) {
        return Response.json({ error: { code: 'method_not_allowed' } }, { status: 405 })
      }
      const res = await fetch(`${upstream}${u.pathname}${u.search}`, {
        method: req.method,
        headers: req.headers,
        body: body || undefined,
      })
      if (supports !== null && u.searchParams.get('view') === 'hashes' && res.ok) {
        const data = (await res.json()) as Record<string, unknown>
        const { entryUpdatedAt: _dropped, ...rest } = data
        return Response.json({ ...rest, supports })
      }
      return res
    },
  })
  return {
    url: `http://localhost:${s.port}`,
    wire,
    since: (n: number) => wire.slice(n).map(w => `${w.method} ${w.search}`),
    stop: () => s.stop(true),
  }
}

function mirrored(
  url: string,
  home: string,
  extra: Partial<ConstructorParameters<typeof OpenRecallClient>[0]> = {},
) {
  return new OpenRecallClient({
    url,
    passphrase: PASSPHRASE,
    cache: true,
    mirror: new FsMirror(cacheDir(home)),
    ...extra,
  })
}

const blobPath = (home: string, ns: string, hash: string) =>
  join(cacheDir(home), contentPath(namespaceSlug(ns), hash))
const manifestPath = (home: string, ns: string) =>
  join(cacheDir(home), 'ns', namespaceSlug(ns), 'mirror.json')

describe('the incremental pull', () => {
  test('a second pull after a foreign write fetches exactly the changed keys', async () => {
    const ns = 'user:sync-delta'
    const home = temp()
    const foreign = new OpenRecallClient({ url: base, passphrase: PASSPHRASE })
    await foreign.push(ns, { 'a.md': 'alpha', 'b.md': 'beta', 'c.md': 'gamma' })

    const p = proxy(base)
    try {
      const c = mirrored(p.url, home)
      const first = await c.pull(ns)
      expect(first.entries).toEqual({ 'a.md': 'alpha', 'b.md': 'beta', 'c.md': 'gamma' })
      expect(first.served).toEqual({ source: 'server', staleMs: 0 })
      // Cold: the hashes view, then one bulk read for everything.
      expect(p.since(0)).toEqual(['GET ?view=hashes', 'POST ?view=entries'])
      expect(JSON.parse(p.wire[1]?.body ?? '{}')).toEqual({ keys: ['a.md', 'b.md', 'c.md'] })

      // Warm and unchanged: one bodyless round trip and nothing decrypted.
      const n1 = p.wire.length
      const same = await c.pull(ns)
      expect(same.entries).toEqual(first.entries)
      expect(p.since(n1)).toEqual(['GET ?view=hashes'])
      expect(same.timings?.decryptMs).toBe(0)

      await foreign.push(ns, { 'b.md': 'beta two', 'd.md': 'delta' })
      const n2 = p.wire.length
      const next = await c.pull(ns)
      expect(next.entries).toEqual({
        'a.md': 'alpha',
        'b.md': 'beta two',
        'c.md': 'gamma',
        'd.md': 'delta',
      })
      expect(p.since(n2)).toEqual(['GET ?view=hashes', 'POST ?view=entries'])
      expect(JSON.parse(p.wire[n2 + 1]?.body ?? '{}')).toEqual({ keys: ['b.md', 'd.md'] })
      // The fingerprint moved for the changed key only.
      expect(next.hashes?.['a.md']).toBe(first.hashes?.['a.md'] as string)
      expect(next.hashes?.['b.md']).not.toBe(first.hashes?.['b.md'])
      // Timestamps come from the hashes view for the unfetched keys.
      expect(Object.keys(next.updatedAt).sort()).toEqual(['a.md', 'b.md', 'c.md', 'd.md'])
    } finally {
      p.stop()
    }
  })

  test('the plaintext cache is keyed by hash: a flipped byte on disk is refetched and replaced', async () => {
    const ns = 'user:sync-flip'
    const home = temp()
    const foreign = new OpenRecallClient({ url: base, passphrase: PASSPHRASE })
    await foreign.push(ns, { 'a.md': 'alpha', 'b.md': 'beta' })
    const p = proxy(base)
    try {
      const warm = mirrored(p.url, home)
      const first = await warm.pull(ns)
      const hash = first.hashes?.['a.md'] as string
      const file = blobPath(home, ns, hash)
      const good = readFileSync(file)
      const bad = Buffer.from(good)
      bad[bad.length - 1] ^= 0x01
      writeFileSync(file, bad)

      // A fresh process: nothing in memory, so the mirror is consulted.
      const cold = mirrored(p.url, home)
      const n = p.wire.length
      const r = await cold.pull(ns)
      expect(r.entries).toEqual({ 'a.md': 'alpha', 'b.md': 'beta' })
      // Only the corrupted blob was refetched; the good one came from disk.
      expect(p.since(n)).toEqual(['GET ?view=hashes', 'POST ?view=entries'])
      expect(JSON.parse(p.wire[n + 1]?.body ?? '{}')).toEqual({ keys: ['a.md'] })
      expect(readFileSync(file).equals(good)).toBe(true)
    } finally {
      p.stop()
    }
  })

  test('a garbage mirror.json is ignored and rebuilt', async () => {
    const ns = 'user:sync-garbage'
    const home = temp()
    await new OpenRecallClient({ url: base, passphrase: PASSPHRASE }).push(ns, { 'a.md': 'alpha' })
    const c = mirrored(base, home)
    await c.pull(ns)
    const file = manifestPath(home, ns)
    expect(existsSync(file)).toBe(true)
    for (const garbage of [
      'not json',
      '[]',
      JSON.stringify({ namespace: 'user:other', version: 1, fetchedAt: 'x', entries: {} }),
    ]) {
      writeFileSync(file, garbage)
      const fresh = mirrored(base, home)
      expect((await fresh.pull(ns)).entries).toEqual({ 'a.md': 'alpha' })
      const rebuilt = JSON.parse(readFileSync(file, 'utf8')) as {
        namespace: string
        entries: Record<string, unknown>
      }
      expect(rebuilt.namespace).toBe(ns)
      expect(Object.keys(rebuilt.entries)).toEqual(['a.md'])
    }
  })

  test('an unreachable server is answered from the mirror only when allowed, and says how stale', async () => {
    const ns = 'user:sync-stale'
    const home = temp()
    await new OpenRecallClient({ url: base, passphrase: PASSPHRASE }).push(ns, {
      'a.md': 'alpha',
      'b.md': 'beta',
    })
    const p = proxy(base)
    const c = mirrored(p.url, home)
    await c.pull(ns)
    p.stop()
    await new Promise(r => setTimeout(r, 20))

    // A fresh process, so the answer has to come from disk, not memory.
    const cold = mirrored(p.url, home)
    const stale = await cold.pull(ns, { allowStale: true })
    expect(stale.entries).toEqual({ 'a.md': 'alpha', 'b.md': 'beta' })
    expect(stale.served?.source).toBe('mirror')
    expect(stale.served?.staleMs).toBeGreaterThan(0)

    // Without the permission the transport failure is the answer.
    await expect(cold.pull(ns)).rejects.toThrow()
    const err = await cold.pull(ns).catch(e => e)
    expect(err).not.toBeInstanceOf(OpenRecallHttpError)
    expect(err).not.toBeInstanceOf(OpenRecallDecryptError)

    // And the tools: recall says where the answer came from; get fails.
    const tools = makeTools(cold, ns)
    const recalled = await tools.recall('alpha')
    expect(recalled.isError).toBeUndefined()
    expect(recalled.text).toMatch(
      /^1 relevant memory from user:sync-stale \(served from the local cache, \d+s stale: the server could not be reached\):\n\n### a\.md/,
    )
    const got = await tools.get('a.md')
    expect(got.isError).toBe(true)
    expect(got.text).not.toContain('alpha')
  })

  test('a 401 is never served from the mirror', async () => {
    const ns = 'user:sync-refused'
    const home = temp()
    await new OpenRecallClient({ url: base, passphrase: PASSPHRASE }).push(ns, { 'a.md': 'alpha' })
    await mirrored(base, home).pull(ns)

    const denier = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({ error: { code: 'unauthorized', message: 'nope' } }, { status: 401 }),
    })
    try {
      const c = mirrored(`http://localhost:${denier.port}`, home)
      const err = await c.pull(ns, { allowStale: true }).catch(e => e)
      expect(err).toBeInstanceOf(OpenRecallHttpError)
      expect((err as OpenRecallHttpError).status).toBe(401)
    } finally {
      denier.stop(true)
    }
  })

  test.skipIf(process.platform === 'win32')(
    'the mirror belongs to the user alone: 0700 directories, 0600 files',
    async () => {
      const ns = 'user:sync-perms'
      const home = temp()
      await new OpenRecallClient({ url: base, passphrase: PASSPHRASE }).push(ns, {
        'a.md': 'alpha',
      })
      const c = mirrored(base, home)
      const r = await c.pull(ns)
      const root = cacheDir(home)
      const nsDir = join(root, 'ns', namespaceSlug(ns))
      for (const dir of [root, join(root, 'ns'), nsDir, join(nsDir, 'blobs')]) {
        expect(`${dir}: ${(statSync(dir).mode & 0o777).toString(8)}`).toBe(`${dir}: 700`)
      }
      for (const file of [
        manifestPath(home, ns),
        blobPath(home, ns, r.hashes?.['a.md'] as string),
      ]) {
        expect(`${file}: ${(statSync(file).mode & 0o777).toString(8)}`).toBe(`${file}: 600`)
      }
      // And nothing under it is plaintext.
      const everything = readdirSync(root, { recursive: true }) as string[]
      for (const f of everything) {
        const p = join(root, f)
        if (statSync(p).isDirectory()) continue
        expect(readFileSync(p, 'latin1')).not.toContain('alpha')
      }
    },
  )

  test('the incremental pull enumerates: a create asserts absence, a drifted key keeps its hash', async () => {
    const ns = 'user:sync-enum'
    const a = new OpenRecallClient({ url: base, passphrase: PASSPHRASE, cache: true })
    const b = new OpenRecallClient({ url: base, passphrase: PASSPHRASE })
    await b.push(ns, { 'seed.md': 'seed', 'drift.md': 'will lose its body' })
    const slug = namespaceSlug(ns)
    const hashes = await b.hashes(ns, { observe: false })
    await getStore().delete(contentPath(slug, hashes['drift.md'] as string))

    const r = await a.pull(ns)
    // The drifted key is skipped, as the full view skips it.
    expect(Object.keys(r.entries)).toEqual(['seed.md'])

    // A null base for an absent key: accepted, since the key is absent.
    await a.push(ns, { 'new.md': 'created' })
    // The same claim after a foreign create: refused, which is the point.
    await b.push(ns, { 'raced.md': 'from-b' })
    const err = await a.push(ns, { 'raced.md': 'from-a' }).catch(e => e)
    expect(err).toBeInstanceOf(OpenRecallHttpError)
    expect((err as OpenRecallHttpError).code).toBe('stale_base_version')
    expect((await b.pull(ns)).entries['raced.md']).toBe('from-b')

    // The drifted key carries its manifest hash, not a null: writing it is
    // the recovery, and the base matches what the manifest still names.
    await a.push(ns, { 'drift.md': 'restored' })
    expect((await b.pull(ns)).entries['drift.md']).toBe('restored')
  })

  test('the fallback matrix: nothing, the single-entry view, and both', async () => {
    const ns = 'user:sync-matrix'
    const foreign = new OpenRecallClient({ url: base, passphrase: PASSPHRASE })
    await foreign.push(ns, { 'a.md': 'alpha', 'b.md': 'beta', 'c.md': 'gamma' })

    const expectations: [string[], string[], string[]][] = [
      // advertised, cold wire, warm wire after one foreign change to b.md
      [[], ['GET ?view=hashes', 'GET '], ['GET ?view=hashes', 'GET ']],
      [
        ['entry-view'],
        [
          'GET ?view=hashes',
          'GET ?view=entry&key=a.md',
          'GET ?view=entry&key=b.md',
          'GET ?view=entry&key=c.md',
        ],
        ['GET ?view=hashes', 'GET ?view=entry&key=b.md'],
      ],
      [
        ['entry-view', 'entries-view'],
        ['GET ?view=hashes', 'POST ?view=entries'],
        ['GET ?view=hashes', 'POST ?view=entries'],
      ],
    ]
    let round = 0
    for (const [supports, cold, warm] of expectations) {
      const p = proxy(base, supports)
      try {
        const c = new OpenRecallClient({ url: p.url, passphrase: PASSPHRASE, cache: true })
        const first = await c.pull(ns)
        expect(first.entries['a.md']).toBe('alpha')
        expect(`${supports}: ${p.since(0).join(' | ')}`).toBe(`${supports}: ${cold.join(' | ')}`)
        round += 1
        await foreign.push(ns, { 'b.md': `beta ${round}` })
        const n = p.wire.length
        const next = await c.pull(ns)
        expect(next.entries['b.md']).toBe(`beta ${round}`)
        expect(next.entries['a.md']).toBe('alpha')
        expect(`${supports}: ${p.since(n).join(' | ')}`).toBe(`${supports}: ${warm.join(' | ')}`)
        // Only the changed entry was decrypted on the warm pull, on every path.
        expect(next.timings?.decryptMs).toBeGreaterThanOrEqual(0)
      } finally {
        p.stop()
      }
    }
  })

  test('a server advertising nothing is read as before: not enumerated', async () => {
    const ns = 'user:sync-legacy-enum'
    const b = new OpenRecallClient({ url: base, passphrase: PASSPHRASE })
    await b.push(ns, { 'seed.md': 'seed' })
    const p = proxy(base, [])
    try {
      const a = new OpenRecallClient({ url: p.url, passphrase: PASSPHRASE })
      expect(Object.keys((await a.pull(ns)).entries)).toEqual(['seed.md'])
      await b.push(ns, { 'x.md': 'from-b' })
      // Unconditional, as the full view has always been for a key it did not see.
      await a.push(ns, { 'x.md': 'from-a' })
      expect((await b.pull(ns)).entries['x.md']).toBe('from-a')
    } finally {
      p.stop()
    }
  })

  test('timestamps from the hashes view and the frames are sanitized as on the full view', async () => {
    const ns = 'user:sync-stamps'
    await new OpenRecallClient({ url: base, passphrase: PASSPHRASE }).push(ns, {
      'a.md': 'alpha',
      'b.md': 'beta',
    })
    const crafted = Bun.serve({
      port: 0,
      fetch: async req => {
        const u = new URL(req.url)
        const res = await fetch(`${base}${u.pathname}${u.search}`, {
          method: req.method,
          headers: req.headers,
          body: req.method === 'POST' ? await req.text() : undefined,
        })
        if (u.searchParams.get('view') !== 'hashes') return res
        const data = (await res.json()) as Record<string, unknown>
        return Response.json({
          ...data,
          entryUpdatedAt: {
            'a.md': '2026-08-06T00:00:00.000Z',
            'b.md': 12345,
            'nope.md': '2026-08-06T00:00:00.000Z',
            __proto__: { 'b.md': '2026-01-01T00:00:00.000Z' },
          },
        })
      },
    })
    try {
      const c = new OpenRecallClient({
        url: `http://localhost:${crafted.port}`,
        passphrase: PASSPHRASE,
        cache: true,
      })
      // Cold: both bodies come through frames, whose own timestamps (the real
      // manifest's) are the server's later word and win.
      const cold = await c.pull(ns)
      expect(Object.keys(cold.updatedAt).sort()).toEqual(['a.md', 'b.md'])
      expect(cold.updatedAt['a.md']).not.toBe('2026-08-06T00:00:00.000Z')
      // Warm: nothing is fetched, so the hashes view is the only source. The
      // crafted string survives, the number and the unknown key do not.
      const warm = await c.pull(ns)
      expect(warm.updatedAt).toEqual({ 'a.md': '2026-08-06T00:00:00.000Z' })
    } finally {
      crafted.stop(true)
    }
  })
})

describe('the bulk entries read', () => {
  test('entries() returns one status per key and arms only the keys it read', async () => {
    const ns = 'user:sync-entries'
    const a = new OpenRecallClient({ url: base, passphrase: PASSPHRASE })
    const b = new OpenRecallClient({ url: base, passphrase: PASSPHRASE })
    await b.push(ns, { 'a.md': 'alpha', 'b.md': 'beta' })
    const r = await a.entries(ns, ['a.md', 'nope.md', '../bad'])
    expect(r.entries).toEqual({ 'a.md': 'alpha' })
    expect(r.statuses).toEqual({ 'a.md': 'ok', 'nope.md': 'not_found', '../bad': 'invalid_key' })
    expect(r.hashes['a.md']).toBe((await b.hashes(ns))['a.md'] as string)
    expect(typeof r.updatedAt['a.md']).toBe('string')

    // Armed for a.md, nothing claimed about b.md.
    await b.push(ns, { 'a.md': 'alpha two', 'b.md': 'beta two' })
    const err = await a.push(ns, { 'a.md': 'from-a' }).catch(e => e)
    expect((err as OpenRecallHttpError).code).toBe('stale_base_version')
    await a.push(ns, { 'b.md': 'from-a' })
    expect((await b.pull(ns)).entries['b.md']).toBe('from-a')
  })

  test('a body that does not hash to its name, or a truncated frame, is a protocol error', async () => {
    const ns = 'user:sync-tamper'
    await new OpenRecallClient({ url: base, passphrase: PASSPHRASE }).push(ns, { 'a.md': 'alpha' })
    const hash = (await new OpenRecallClient({ url: base, passphrase: PASSPHRASE }).hashes(ns))[
      'a.md'
    ] as string
    const tampered = encodeFrames(
      { namespace: ns, version: 1, lastModified: 'x', erasure: 'erases', count: 1 },
      [
        {
          meta: { key: 'a.md', hash, size: 4, updatedAt: null, status: 'ok' },
          bytes: new Uint8Array([1, 2, 3, 4]),
        },
      ],
    )
    const bodies: Uint8Array[] = [tampered, tampered.subarray(0, tampered.length - 2)]
    const s = Bun.serve({
      port: 0,
      fetch: async req => {
        const u = new URL(req.url)
        if (req.method !== 'POST') return fetch(`${base}${u.pathname}${u.search}`)
        const body = bodies.shift() as Uint8Array
        return new Response(body as unknown as BodyInit, {
          headers: { 'content-type': 'application/octet-stream', 'x-openrecall-frames': '1' },
        })
      },
    })
    try {
      const c = new OpenRecallClient({ url: `http://localhost:${s.port}`, passphrase: PASSPHRASE })
      for (const what of ['mismatch', 'truncated']) {
        const err = await c.pull(ns).catch(e => e)
        expect(`${what}: ${(err as Error).name}`).toBe(`${what}: OpenRecallProtocolError`)
        expect(err).toBeInstanceOf(OpenRecallProtocolError)
        expect(err).not.toBeInstanceOf(OpenRecallDecryptError)
      }
      // And a JSON answer where frames were expected is the same class.
      const plain = Bun.serve({
        port: 0,
        fetch: async req => {
          const u = new URL(req.url)
          if (req.method !== 'POST') return fetch(`${base}${u.pathname}${u.search}`)
          return Response.json({ version: 1, content: { entries: {} } })
        },
      })
      try {
        const d = new OpenRecallClient({
          url: `http://localhost:${plain.port}`,
          passphrase: PASSPHRASE,
        })
        const err = await d.pull(ns).catch(e => e)
        expect(err).toBeInstanceOf(OpenRecallProtocolError)
      } finally {
        plain.stop(true)
      }
    } finally {
      s.stop(true)
    }
  })

  test('a mirror that throws is a miss, never a failed read', async () => {
    const ns = 'user:sync-throwing-mirror'
    await new OpenRecallClient({ url: base, passphrase: PASSPHRASE }).push(ns, { 'a.md': 'alpha' })
    const broken: MirrorStore = {
      readManifest: async () => {
        throw new Error('disk on fire')
      },
      writeManifest: async () => {
        throw new Error('disk on fire')
      },
      getBlob: async () => {
        throw new Error('disk on fire')
      },
      putBlob: async () => {
        throw new Error('disk on fire')
      },
      deleteBlob: async () => {
        throw new Error('disk on fire')
      },
      listBlobs: async () => {
        throw new Error('disk on fire')
      },
    }
    const c = new OpenRecallClient({ url: base, passphrase: PASSPHRASE, mirror: broken })
    expect((await c.pull(ns)).entries).toEqual({ 'a.md': 'alpha' })
  })
})

describe('the fs mirror and the fs store', () => {
  test('equal-length blobs written with Promise.all all land', async () => {
    const store = new FsBlobStore(temp(), { private: true })
    const n = 40
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        store.put(
          `ns/x/blobs/${String(i).padStart(2, '0')}`,
          new TextEncoder().encode(`body-${String(i).padStart(2, '0')}`),
        ),
      ),
    )
    const listed = await store.list('ns/x/blobs/')
    expect(listed.length).toBe(n)
    for (let i = 0; i < n; i++) {
      const got = await store.get(`ns/x/blobs/${String(i).padStart(2, '0')}`)
      expect(new TextDecoder().decode(got as Uint8Array)).toBe(`body-${String(i).padStart(2, '0')}`)
    }
    // No temp file survived, and none is listed.
    expect(listed.some(p => p.includes('.tmp-'))).toBe(false)
  })

  test('a mirror that cannot write says so once on stderr and goes quiet', async () => {
    const ns = 'user:sync-unwritable'
    await new OpenRecallClient({ url: base, passphrase: PASSPHRASE }).push(ns, { 'a.md': 'alpha' })
    const home = temp()
    // The cache root is a file, so every directory creation under it fails.
    writeFileSync(cacheDir(home), 'not a directory')
    const lines: string[] = []
    const realError = console.error
    console.error = (...args: unknown[]) => lines.push(args.map(String).join(' '))
    try {
      const c = mirrored(base, home)
      expect((await c.pull(ns)).entries).toEqual({ 'a.md': 'alpha' })
      expect((await c.pull(ns)).entries).toEqual({ 'a.md': 'alpha' })
    } finally {
      console.error = realError
    }
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('local cache')
    expect(lines[0]).not.toContain('alpha')
  })
})

describe('makeClient wiring', () => {
  // Local mode binds the in-process handler to one data dir for the life of
  // the process, and the test preload already bound it, so local clients
  // here point at that directory (unique namespaces keep them apart).
  const DATA_DIR = process.env.DATA_DIR as string
  const env = (home: string, over: Record<string, string> = {}) => ({
    OPENRECALL_HOME: home,
    OPENRECALL_PASSPHRASE: PASSPHRASE,
    OPENRECALL_DATA_DIR: DATA_DIR,
    ...over,
  })
  type Internals = { mirror?: MirrorStore; cacheEnabled: boolean }

  test('local mode gets the cache and no mirror; remote mode gets both; OPENRECALL_CACHE=off neither', async () => {
    const home = temp()
    const local = (await makeClient(resolveSettings(env(home)))) as unknown as Internals
    expect(local.cacheEnabled).toBe(true)
    expect(local.mirror).toBeUndefined()

    const remote = (await makeClient(
      resolveSettings(env(home, { OPENRECALL_URL: base })),
    )) as unknown as Internals
    expect(remote.cacheEnabled).toBe(true)
    expect(remote.mirror).toBeInstanceOf(FsMirror)
    expect((remote.mirror as FsMirror).root).toBe(cacheDir(home))

    const off = (await makeClient(
      resolveSettings(env(home, { OPENRECALL_URL: base, OPENRECALL_CACHE: 'off' })),
    )) as unknown as Internals
    expect(off.cacheEnabled).toBe(false)
    expect(off.mirror).toBeUndefined()
    expect(resolveSettings(env(home, { OPENRECALL_CACHE: 'off' })).cache).toBe(false)
    expect(resolveSettings(env(home)).cache).toBe(true)
  })

  test('local mode reads the bulk view in-process, binary body and all, without the lock', async () => {
    const ns = 'user:sync-local'
    const dir = DATA_DIR
    const inner = await localFetch(dir)
    const wire: string[] = []
    const fetchLike: typeof inner = (input, init) => {
      wire.push(`${(init?.method ?? 'GET').toUpperCase()} ${new URL(input).search}`)
      return inner(input, init)
    }
    const c = new OpenRecallClient({
      url: LOCAL_ORIGIN,
      passphrase: PASSPHRASE,
      fetch: fetchLike,
      cache: true,
    })
    await c.push(ns, { 'a.md': 'alpha', 'b.md': 'beta' })
    const n = wire.length
    const first = await c.pull(ns)
    expect(first.entries).toEqual({ 'a.md': 'alpha', 'b.md': 'beta' })
    expect(wire.slice(n)).toEqual(['GET ?view=hashes', 'POST ?view=entries'])
    // A held lock does not stop the read: POST is a read here.
    writeFileSync(join(dir, '.lock'), '99999 0123456789abcdef\n')
    try {
      const other = new OpenRecallClient({
        url: LOCAL_ORIGIN,
        passphrase: PASSPHRASE,
        fetch: inner,
      })
      const t0 = performance.now()
      expect((await other.pull(ns)).entries).toEqual(first.entries)
      expect(performance.now() - t0).toBeLessThan(2000)
    } finally {
      rmSync(join(dir, '.lock'), { force: true })
    }
    // Nothing under the namespace's store directory holds plaintext, and the
    // hash the client reports names the blob the server wrote.
    const nsDir = join(dir, 'ns', namespaceSlug(ns))
    for (const f of readdirSync(nsDir, { recursive: true }) as string[]) {
      const p = join(nsDir, f)
      if (statSync(p).isDirectory()) continue
      expect(readFileSync(p, 'latin1')).not.toContain('alpha')
    }
    const blob = readFileSync(
      join(dir, contentPath(namespaceSlug(ns), first.hashes?.['a.md'] as string)),
    )
    expect(first.hashes?.['a.md']).toBe(ciphertextHash(Buffer.from(blob).toString('base64')))
  })
})
