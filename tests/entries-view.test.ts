/**
 * The bulk entries read (`POST /api/memory/:ns?view=entries`, body
 * `{ keys: string[] }`), answered as binary frames.
 *
 * Why this view exists: an incremental pull compares the hashes view against
 * what it already holds and needs the bodies of the keys that moved, and
 * nothing else. The full view ships everything as base64 in JSON (10.6 MB
 * for 7.2 MB of ciphertext at 5,000 entries), and the single-entry view costs
 * a round trip per key. This one carries exactly the requested bodies, raw.
 *
 * What these tests defend:
 *   - a denial must never render as success: a missing namespace is the same
 *     404 `empty` the other reads give, and never an empty frame list
 *   - one bad key cannot fail a read of the others: validation, absence and
 *     drift are each a per-entry status, and a traversal-shaped key is never
 *     looked up
 *   - the bytes on the wire are pinned, so the encoder cannot drift without a
 *     test going red, and a client with the other codec copy keeps decoding
 *   - the request is bounded (a key-count cap) and the store is asked for at
 *     most READ_CONCURRENCY blobs at once, on this view and on the full one
 *   - the capability is advertised, so a client never POSTs at a server that
 *     would answer 405
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { ciphertextHash, decryptEntry, deriveKey, encryptEntry } from '../client/crypto.ts'
import { decodeFrames as decodeFramesClient } from '../client/frames.ts'
import { decodeFrames, encodeFrames, FRAMES_HEADER, FrameFormatError } from '../src/frames.ts'
import { handleRequest } from '../src/handler.ts'
import { sha256Prefixed } from '../src/hash.ts'
import { getData, getEntries, upsert } from '../src/memory.ts'
import { namespaceSlug } from '../src/namespace.ts'
import { _reset } from '../src/ratelimit.ts'
import type { BlobStore } from '../src/store/blobstore.ts'
import { contentPath, getStore, manifestPath, resetStore, setStore } from '../src/store/index.ts'

const NOW = '2026-09-04T00:00:00.000Z'

afterEach(() => {
  resetStore()
  _reset()
})

async function post(ns: string, body: unknown, query = 'view=entries'): Promise<Response> {
  return handleRequest(
    new Request(`http://t/api/memory/${encodeURIComponent(ns)}?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
}

async function seed(ns: string, entries: Record<string, string>) {
  return upsert(ns, namespaceSlug(ns), 'local', { entries }, NOW)
}

const b64 = (s: string) => Buffer.from(s).toString('base64')

describe('entries view: the frames answer', () => {
  test('returns the requested bodies raw, with the hash and timestamp the manifest holds', async () => {
    const ns = 'user:entries-happy'
    const key = deriveKey('test-pass', ns)
    const a = encryptEntry(key, 'notes/a.md', 'the user prefers terse answers')
    const b = encryptEntry(key, 'notes/b.md', 'a second note')
    const c = encryptEntry(key, 'notes/c.md', 'not asked for')
    await seed(ns, { 'notes/a.md': a, 'notes/b.md': b, 'notes/c.md': c })

    const res = await post(ns, { keys: ['notes/b.md', 'notes/a.md'] })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get(FRAMES_HEADER)).toBe('1')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    const body = new Uint8Array(await res.arrayBuffer())
    const { header, frames } = decodeFrames(body)

    expect(header).toEqual({
      namespace: ns,
      version: 1,
      lastModified: NOW,
      erasure: 'erases',
      count: 2,
    })
    // In the order asked for, not manifest order.
    expect(frames.map(f => f.meta.key)).toEqual(['notes/b.md', 'notes/a.md'])
    for (const [f, ct, k] of [
      [frames[0], b, 'notes/b.md'],
      [frames[1], a, 'notes/a.md'],
    ] as const) {
      expect(f?.meta.status).toBe('ok')
      expect(f?.meta.hash).toBe(ciphertextHash(ct))
      expect(f?.meta.size).toBe(Buffer.from(ct, 'base64').length)
      expect(f?.meta.updatedAt).toBe(NOW)
      // Raw bytes, not base64: the same ciphertext the full view base64s.
      expect(Buffer.from(f?.bytes as Uint8Array).toString('base64')).toBe(ct)
      expect(decryptEntry(key, k, Buffer.from(f?.bytes as Uint8Array).toString('base64'))).toBe(
        k === 'notes/a.md' ? 'the user prefers terse answers' : 'a second note',
      )
    }
    // Bounded: the sibling that was not asked for is not in the answer.
    expect(Buffer.from(body).includes(Buffer.from(c, 'base64'))).toBe(false)
    expect(Buffer.from(body).toString('latin1')).not.toContain('notes/c.md')
  })

  test('the two-entry golden frame is byte for byte what it was', async () => {
    // Pinned as hex so the encoder cannot drift silently: a reordered JSON
    // field, a changed magic, a length written big-endian or a renamed status
    // all show here, and the client's copy of the codec is asked to decode
    // the same bytes. The ciphertext is arbitrary bytes on purpose (the server
    // never inspects it), which keeps the literal short enough to read.
    const ns = 'user:entries-golden'
    await seed(ns, { 'a.md': b64('ciphertext-one'), 'b.md': b64('ciphertext-two!') })
    const res = await post(ns, { keys: ['a.md', 'b.md', 'zz.md'] })
    const hex = Buffer.from(await res.arrayBuffer()).toString('hex')
    const golden = [
      '4f524531760000007b226e616d657370616365223a22757365723a656e74726965732d676f6c64656e222c2276657273',
      '696f6e223a312c226c6173744d6f646966696564223a22323032362d30392d30345430303a30303a30302e3030305a22',
      '2c2265726173757265223a22657261736573222c22636f756e74223a337d9e0000007b226b6579223a22612e6d64222c',
      '2268617368223a227368613235363a393031353034373762323861313933306164623334613133323436363832336238',
      '62316335353236633930333465366562633761333062323633383234343833222c2273697a65223a31342c2275706461',
      '7465644174223a22323032362d30392d30345430303a30303a30302e3030305a222c22737461747573223a226f6b227d',
      '0e000000636970686572746578742d6f6e659e0000007b226b6579223a22622e6d64222c2268617368223a2273686132',
      '35363a303962373534386363313264393262663630356366313364333532653537346631326135643863636531646636',
      '36313231616462326238306662356333623663222c2273697a65223a31352c22757064617465644174223a2232303236',
      '2d30392d30345430303a30303a30302e3030305a222c22737461747573223a226f6b227d0f0000006369706865727465',
      '78742d74776f214a0000007b226b6579223a227a7a2e6d64222c2268617368223a6e756c6c2c2273697a65223a302c22',
      '757064617465644174223a6e756c6c2c22737461747573223a226e6f745f666f756e64227d00000000',
    ].join('')
    expect(hex).toBe(golden)
    // Readable control for the literal: it starts with the magic and the
    // header's length, and the hash in it is the real digest of the bytes.
    expect(hex.startsWith(`${Buffer.from('ORE1').toString('hex')}76000000`)).toBe(true)
    expect(Buffer.from(golden, 'hex').toString('latin1')).toContain(
      sha256Prefixed(new TextEncoder().encode('ciphertext-one')),
    )

    // And the client's copy of the codec reads the same bytes identically.
    const viaClient = decodeFramesClient(Buffer.from(golden, 'hex'))
    const viaServer = decodeFrames(Buffer.from(golden, 'hex'))
    expect(viaClient.header).toEqual(viaServer.header)
    expect(viaClient.frames.map(f => f.meta)).toEqual(viaServer.frames.map(f => f.meta))
    expect(viaServer.frames.map(f => f.meta.status)).toEqual(['ok', 'ok', 'not_found'])
  })

  test('a truncated body is a FrameFormatError, never a shorter answer', () => {
    const full = encodeFrames(
      { namespace: 'user:x', version: 1, lastModified: NOW, erasure: 'erases', count: 1 },
      [
        {
          meta: { key: 'a.md', hash: 'sha256:00', size: 3, updatedAt: NOW, status: 'ok' },
          bytes: new Uint8Array([1, 2, 3]),
        },
      ],
    )
    for (const cut of [3, 4, 10, full.length - 1]) {
      expect(() => decodeFrames(full.subarray(0, cut))).toThrow(FrameFormatError)
    }
    expect(() => decodeFrames(Buffer.concat([full, Buffer.from([0])]))).toThrow(FrameFormatError)
    const bad = Buffer.from(full)
    bad.write('ORE2', 0)
    expect(() => decodeFrames(bad)).toThrow(/magic/)
    // Control: untouched, it round-trips.
    expect(decodeFrames(full).frames[0]?.bytes).toEqual(new Uint8Array([1, 2, 3]))
  })
})

describe('entries view: refusals and per-entry statuses', () => {
  test('a namespace that does not exist answers 404 empty, like the other reads', async () => {
    const res = await post('user:entries-nothing-here', { keys: ['a.md'] })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('empty')
  })

  test('absence, drift and a bad key are statuses on their own frames', async () => {
    const ns = 'user:entries-statuses'
    const nsSlug = namespaceSlug(ns)
    const kept = b64('kept-body')
    const gone = b64('gone-body')
    await seed(ns, { 'kept.md': kept, 'gone.md': gone })
    await getStore().delete(contentPath(nsSlug, ciphertextHash(gone)))

    const res = await post(ns, { keys: ['kept.md', 'absent.md', 'gone.md', '../etc/passwd'] })
    expect(res.status).toBe(200)
    const { frames } = decodeFrames(new Uint8Array(await res.arrayBuffer()))
    expect(frames.map(f => [f.meta.key, f.meta.status, f.bytes.length])).toEqual([
      ['kept.md', 'ok', 9],
      ['absent.md', 'not_found', 0],
      ['gone.md', 'unreadable', 0],
      ['../etc/passwd', 'invalid_key', 0],
    ])
    // Drift keeps the manifest's word: the client learns the hash it cannot
    // get a body for, which is what lets it keep writing to that key.
    expect(frames[2]?.meta.hash).toBe(ciphertextHash(gone))
    expect(frames[2]?.meta.updatedAt).toBe(NOW)
    expect(frames[1]?.meta.hash).toBeNull()
    expect(frames[3]?.meta.hash).toBeNull()
  })

  test('the key list is bounded by the namespace entry cap', async () => {
    // tests/setup.ts pins MAX_ENTRIES_PER_NAMESPACE=5 for this process.
    const ns = 'user:entries-cap'
    await seed(ns, { 'a.md': b64('x') })
    const six = await post(ns, { keys: ['a', 'b', 'c', 'd', 'e', 'f'].map(k => `${k}.md`) })
    expect(six.status).toBe(400)
    expect(((await six.json()) as { error: { code: string } }).error.code).toBe('bad_request')
    const none = await post(ns, { keys: [] })
    expect(none.status).toBe(400)
    // Control: five is served.
    const five = await post(ns, { keys: ['a', 'b', 'c', 'd', 'e'].map(k => `${k}.md`) })
    expect(five.status).toBe(200)
  })

  test('a body that is not { keys: string[] } is a 400, and a POST without the view a 405', async () => {
    const ns = 'user:entries-shape'
    await seed(ns, { 'a.md': b64('x') })
    for (const body of ['not json', '[]', '{}', '{"keys":"a.md"}', '{"keys":[1]}']) {
      const res = await post(ns, body)
      expect(`${body} -> ${res.status}`).toBe(`${body} -> 400`)
    }
    expect((await post(ns, { keys: ['a.md'] }, '')).status).toBe(405)
    expect((await post(ns, { keys: ['a.md'] }, 'view=hashes')).status).toBe(405)
  })

  test('a body over the cap is refused before it is read', async () => {
    const ns = 'user:entries-big'
    await seed(ns, { 'a.md': b64('x') })
    const res = await handleRequest(
      new Request(`http://t/api/memory/${ns}?view=entries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '999999999' },
        body: '{"keys":["a.md"]}',
      }),
    )
    expect(res.status).toBe(413)
  })

  test('the capability is advertised on the hashes view', async () => {
    const ns = 'user:entries-advertised'
    await seed(ns, { 'a.md': b64('x') })
    const res = await handleRequest(new Request(`http://t/api/memory/${ns}?view=hashes`))
    const body = (await res.json()) as {
      supports: string[]
      entryUpdatedAt: Record<string, string>
    }
    expect(body.supports).toContain('entries-view')
    // And the timestamps an incremental pull needs for the keys it does not fetch.
    expect(body.entryUpdatedAt).toEqual({ 'a.md': NOW })
  })
})

/**
 * A store that counts how many `get`s are in flight at once. It wraps the real
 * one, so bodies still come back; only the fan-out is observed. Each read
 * yields to the event loop before answering, so concurrent reads really
 * overlap rather than resolving in turn.
 */
function countingStore(real: BlobStore): BlobStore & { maxInFlight: () => number } {
  let inFlight = 0
  let max = 0
  return {
    erasure: real.erasure,
    describe: () => real.describe(),
    put: p => real.put(p, new Uint8Array()),
    delete: p => real.delete(p),
    list: p => real.list(p),
    async get(path) {
      inFlight += 1
      max = Math.max(max, inFlight)
      try {
        await new Promise(r => setTimeout(r, 1))
        return await real.get(path)
      } finally {
        inFlight -= 1
      }
    },
    maxInFlight: () => max,
  }
}

/**
 * Forty entries written straight into the store, past the 5-entry cap the
 * test process pins for `upsert`, since the bound only shows above 16.
 */
async function seedDirect(ns: string, n: number): Promise<string[]> {
  const nsSlug = namespaceSlug(ns)
  const store = getStore()
  const entries: Record<string, { hash: string; size: number; updatedAt: string }> = {}
  const keys: string[] = []
  for (let i = 0; i < n; i++) {
    const key = `k${i}.md`
    const bytes = new TextEncoder().encode(`body ${i}`)
    const hash = sha256Prefixed(bytes)
    await store.put(contentPath(nsSlug, hash), bytes)
    entries[key] = { hash, size: bytes.length, updatedAt: NOW }
    keys.push(key)
  }
  await store.put(
    manifestPath(nsSlug),
    new TextEncoder().encode(JSON.stringify({ version: 1, lastModified: NOW, entries })),
  )
  return keys
}

describe('entries view: the store is asked for at most 16 blobs at once', () => {
  test('on the bulk view', async () => {
    const ns = 'user:entries-bounded-fanout'
    const keys = await seedDirect(ns, 40)
    const counting = countingStore(getStore())
    setStore(counting)
    const found = await getEntries(ns, namespaceSlug(ns), keys)
    expect(found.status).toBe('ok')
    if (found.status !== 'ok') return
    expect(found.frames.filter(f => f.meta.status === 'ok').length).toBe(40)
    expect(counting.maxInFlight()).toBeLessThanOrEqual(16)
    // Non-vacuous: the reads really overlapped, so the bound was exercised.
    expect(counting.maxInFlight()).toBeGreaterThan(1)
  })

  test('on the full view, with its results unchanged', async () => {
    const ns = 'user:entries-bounded-full'
    await seedDirect(ns, 40)
    const before = await getData(ns, namespaceSlug(ns))
    const counting = countingStore(getStore())
    setStore(counting)
    const after = await getData(ns, namespaceSlug(ns))
    expect(after).toEqual(before)
    expect(Object.keys(after.content.entries).length).toBe(40)
    expect(counting.maxInFlight()).toBeLessThanOrEqual(16)
    expect(counting.maxInFlight()).toBeGreaterThan(1)
  })
})
