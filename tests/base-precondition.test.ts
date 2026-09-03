/**
 * The per-entry base precondition (U3, R12, AE7 server half).
 *
 * A push carries the ciphertext hash it believes each key currently holds. If
 * the manifest disagrees, the write is refused with 409 rather than applied.
 * The guarded window is the caller's own turn, not the moment between its last
 * read and its PUT, so the base is per entry and the comparison happens inside
 * the namespace lock against the manifest the write would actually mutate.
 *
 * A request with no base is accepted unconditionally: existing clients keep
 * working, and the hashes view advertises the capability so a client can tell
 * a server that enforces it from one that does not.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { handleRequest } from '../src/handler.ts'
import { getData, getHashes, upsert } from '../src/memory.ts'
import { namespaceSlug } from '../src/namespace.ts'
import { resetStore } from '../src/store/index.ts'
import { StaleBaseError } from '../src/types.ts'

const NOW = '2026-06-24T00:00:00.000Z'
const b64 = (s: string) => Buffer.from(s).toString('base64')
const put = (ns: string, req: Parameters<typeof upsert>[3]) =>
  upsert(ns, namespaceSlug(ns), 'local', req, NOW)

afterEach(() => resetStore())

async function hashOf(ns: string, key: string) {
  const h = await getHashes(ns, namespaceSlug(ns))
  return h.entryChecksums[key] as string
}

describe('base precondition', () => {
  test('a stale base is refused and the namespace is unchanged', async () => {
    const ns = 'user:stale'
    await put(ns, { entries: { 'a.md': b64('v1') } })
    const err = await put(ns, {
      entries: { 'a.md': b64('v2') },
      base: { 'a.md': 'sha256:0000' },
    }).catch(e => e)

    expect(err).toBeInstanceOf(StaleBaseError)
    expect((err as StaleBaseError).code).toBe('stale_base_version')
    expect((err as StaleBaseError).details.conflicts).toEqual({
      'a.md': await hashOf(ns, 'a.md'),
    })
    const data = await getData(ns, namespaceSlug(ns))
    expect(Buffer.from(data.content.entries['a.md'] as string, 'base64').toString()).toBe('v1')
  })

  test('the same write with the current base succeeds', async () => {
    const ns = 'user:fresh'
    await put(ns, { entries: { 'a.md': b64('v1') } })
    const base = { 'a.md': await hashOf(ns, 'a.md') }
    const r = await put(ns, { entries: { 'a.md': b64('v2') }, base })
    expect(r.accepted).toEqual(['a.md'])
    const data = await getData(ns, namespaceSlug(ns))
    expect(Buffer.from(data.content.entries['a.md'] as string, 'base64').toString()).toBe('v2')
  })

  test('expected-absent: null base on an existing key is refused, on a new key succeeds', async () => {
    const ns = 'user:absent'
    await put(ns, { entries: { 'a.md': b64('v1') } })
    const err = await put(ns, {
      entries: { 'a.md': b64('v2') },
      base: { 'a.md': null },
    }).catch(e => e)
    expect(err).toBeInstanceOf(StaleBaseError)

    const ok = await put(ns, { entries: { 'b.md': b64('v1') }, base: { 'b.md': null } })
    expect(ok.accepted).toEqual(['b.md'])
  })

  test('a request with no base is accepted unconditionally', async () => {
    const ns = 'user:nobase'
    await put(ns, { entries: { 'a.md': b64('v1') } })
    const r = await put(ns, { entries: { 'a.md': b64('v2') } })
    expect(r.accepted).toEqual(['a.md'])
  })

  test('a deletion with a stale base is refused; with the right base it deletes', async () => {
    const ns = 'user:del'
    await put(ns, { entries: { 'a.md': b64('v1') } })
    const err = await put(ns, {
      entries: {},
      deletions: ['a.md'],
      base: { 'a.md': 'sha256:0000' },
    }).catch(e => e)
    expect(err).toBeInstanceOf(StaleBaseError)

    const r = await put(ns, {
      entries: {},
      deletions: ['a.md'],
      base: { 'a.md': await hashOf(ns, 'a.md') },
    })
    expect(r.deleted).toEqual(['a.md'])
  })

  test('the hashes view advertises the precondition capability', async () => {
    const ns = 'user:cap'
    await put(ns, { entries: { 'a.md': b64('v1') } })
    const h = await getHashes(ns, namespaceSlug(ns))
    expect(h.supports).toContain('base-precondition')
  })
})

describe('base precondition over the wire', () => {
  const url = (ns: string) => `http://x/api/memory/${encodeURIComponent(ns)}`

  test('a stale PUT returns 409 with the conflicting key', async () => {
    const ns = 'user:wire'
    await put(ns, { entries: { 'a.md': b64('v1') } })
    const res = await handleRequest(
      new Request(url(ns), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entries: { 'a.md': b64('v2') }, base: { 'a.md': 'sha256:0000' } }),
      }),
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; details: { conflicts: object } } }
    expect(body.error.code).toBe('stale_base_version')
    expect(Object.keys(body.error.details.conflicts)).toEqual(['a.md'])
  })

  test('a stale DELETE returns 409, not 500', async () => {
    const ns = 'user:wiredel'
    await put(ns, { entries: { 'a.md': b64('v1') } })
    const res = await handleRequest(
      new Request(`${url(ns)}?key=a.md&base=sha256:${'0'.repeat(64)}`, { method: 'DELETE' }),
    )
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'stale_base_version',
    )
  })

  test('a malformed base is 400 on both PUT and DELETE', async () => {
    const ns = 'user:badbase'
    await put(ns, { entries: { 'a.md': b64('v1') } })
    const p = await handleRequest(
      new Request(url(ns), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entries: {}, base: { 'a.md': 7 } }),
      }),
    )
    expect(p.status).toBe(400)
    const d = await handleRequest(
      new Request(`${url(ns)}?key=a.md&base=not-a-hash`, { method: 'DELETE' }),
    )
    expect(d.status).toBe(400)
  })
})
