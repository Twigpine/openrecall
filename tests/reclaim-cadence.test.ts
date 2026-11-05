/**
 * Reclaim cadence.
 *
 * Listing a namespace's blob prefix is the expensive call in a save (a Class-A
 * request per write on S3, a readdir of every blob on the fs), and it used to
 * run on every mutating write. Now a write deletes the blobs it superseded by
 * hash, and the listing runs when it is due: the first write per process to a
 * namespace, every 32 writes after that, and the write after a commit or a
 * collection failed. These tests count the store calls to pin that cadence,
 * and check that what the cheaper path deletes, and what it leaves alone, is
 * decided by the hashes the manifest still names.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { sha256Prefixed } from '../src/hash.ts'
import { type OperationalEvent, setEventSink } from '../src/log.ts'
import { getData, upsert } from '../src/memory.ts'
import { namespaceSlug } from '../src/namespace.ts'
import type { BlobStore } from '../src/store/blobstore.ts'
import { blobPrefix, contentPath, getStore, resetStore, setStore } from '../src/store/index.ts'

const NOW = '2026-06-24T00:00:00.000Z'
const b64 = (s: string) => Buffer.from(s).toString('base64')
const blobOf = (slug: string, body: string) =>
  contentPath(slug, sha256Prefixed(new Uint8Array(Buffer.from(body))))
const put = (ns: string, req: Parameters<typeof upsert>[3]) =>
  upsert(ns, namespaceSlug(ns), 'local', req, NOW)

class Boom extends Error {}

/**
 * Wraps the real store, counting every call by kind and recording each path
 * it deleted. `failNextDelete` and `failManifestPut` each arm one injected
 * failure, so a test can make exactly one targeted delete, or exactly one
 * commit, fail and then watch what the next write does about it.
 */
function counting(inner: BlobStore) {
  const c = {
    calls: { get: 0, put: 0, delete: 0, list: 0 },
    deleted: [] as string[],
    failNextDelete: false,
    failManifestPut: false,
    reset: () => {
      c.calls = { get: 0, put: 0, delete: 0, list: 0 }
      c.deleted = []
    },
    store: {} as BlobStore,
  }
  c.store = {
    get: p => {
      c.calls.get++
      return inner.get(p)
    },
    put: async (p, b) => {
      c.calls.put++
      if (c.failManifestPut && p.endsWith('/manifest.json')) {
        c.failManifestPut = false
        throw new Boom(`injected put ${p}`)
      }
      return inner.put(p, b)
    },
    delete: async p => {
      c.calls.delete++
      if (c.failNextDelete) {
        c.failNextDelete = false
        throw new Boom(`injected delete ${p}`)
      }
      c.deleted.push(p)
      return inner.delete(p)
    },
    list: p => {
      c.calls.list++
      return inner.list(p)
    },
    describe: () => `counting(${inner.describe()})`,
    erasure: inner.erasure,
  }
  return c
}

/** A fresh counting store over the real driver, installed for the test. */
function fresh() {
  resetStore()
  const real = getStore()
  const c = counting(real)
  setStore(c.store)
  return { real, c }
}

afterEach(() => {
  resetStore()
  setEventSink(null)
})

describe('reclaim cadence', () => {
  test('replacing or deleting a key removes its old blob on that write, without a listing', async () => {
    const ns = 'user:cadence-replace'
    const slug = namespaceSlug(ns)
    const { real, c } = fresh()
    await put(ns, { entries: { 'a.md': b64('v1') } })
    // Control: the first write did list, so a zero below is the cadence and
    // not a wrapper that never counts.
    expect(c.calls.list).toBe(1)

    c.reset()
    await put(ns, { entries: { 'a.md': b64('v2') } })
    expect(c.calls.list).toBe(0)
    expect(c.deleted).toContain(blobOf(slug, 'v1'))
    expect(await real.get(blobOf(slug, 'v1'))).toBeNull()
    expect(await real.get(blobOf(slug, 'v2'))).not.toBeNull()

    c.reset()
    await put(ns, { entries: {}, deletions: ['a.md'] })
    expect(c.calls.list).toBe(0)
    expect(c.deleted).toContain(blobOf(slug, 'v2'))
    expect(await real.get(blobOf(slug, 'v2'))).toBeNull()
  })

  test('a blob two keys share survives deleting one of them, and no listing saved it', async () => {
    // Identical ciphertext under two keys lands on one content-addressed blob.
    // The targeted path has no listing to fall back on, so it is the explicit
    // check against the manifest's live hashes that keeps the blob.
    const ns = 'user:cadence-shared'
    const slug = namespaceSlug(ns)
    const { real, c } = fresh()
    await put(ns, { entries: { 'x.md': b64('same'), 'y.md': b64('same') } })
    const shared = blobOf(slug, 'same')
    expect(await real.get(shared)).not.toBeNull()

    c.reset()
    await put(ns, { entries: {}, deletions: ['x.md'] })
    expect(c.calls.list).toBe(0)
    expect(c.deleted).not.toContain(shared)
    expect(await real.get(shared)).not.toBeNull()
    const data = await getData(ns, slug)
    expect(Object.keys(data.content.entries)).toEqual(['y.md'])

    // Control: once the last key naming it goes, so does the blob.
    c.reset()
    await put(ns, { entries: {}, deletions: ['y.md'] })
    expect(c.calls.list).toBe(0)
    expect(await real.get(shared)).toBeNull()
  })

  test('the first write per store instance and namespace lists once', async () => {
    const ns = 'user:cadence-first'
    const { real, c } = fresh()
    await put(ns, { entries: { 'a.md': b64('v1') } })
    expect(c.calls.list).toBe(1)
    await put(ns, { entries: { 'a.md': b64('v2') } })
    expect(c.calls.list).toBe(1)

    // A second instance over the same bytes is what a restarted process looks
    // like, and a previous process may have crashed: it lists on its first
    // write too, however recently the last instance swept.
    const c2 = counting(real)
    setStore(c2.store)
    await put(ns, { entries: { 'a.md': b64('v3') } })
    expect(c2.calls.list).toBe(1)

    // The cadence is per namespace, not per store: another namespace's first
    // write on this instance lists for itself.
    await put('user:cadence-first-other', { entries: { 'a.md': b64('v1') } })
    expect(c2.calls.list).toBe(2)
    await put(ns, { entries: { 'a.md': b64('v4') } })
    expect(c2.calls.list).toBe(2)
  })

  test('after the first write, every 32nd write lists and the others do not', async () => {
    const ns = 'user:cadence-32'
    const slug = namespaceSlug(ns)
    const { real, c } = fresh()
    await put(ns, { entries: { 'a.md': b64('v0') } })
    expect(c.calls.list).toBe(1)

    for (let cycle = 0; cycle < 2; cycle++) {
      c.reset()
      for (let i = 1; i <= 31; i++) {
        await put(ns, { entries: { 'a.md': b64(`v${cycle * 32 + i}`) } })
      }
      expect(c.calls.list).toBe(0)
      await put(ns, { entries: { 'a.md': b64(`v${cycle * 32 + 32}`) } })
      expect(c.calls.list).toBe(1)
    }

    // Nothing leaked between sweeps: 65 versions were written and the store
    // holds exactly the one the manifest names.
    expect(await real.list(blobPrefix(slug))).toEqual([blobOf(slug, 'v64')])
  })

  test('a failed targeted delete makes the next write list', async () => {
    const events: OperationalEvent[] = []
    setEventSink(e => events.push(e))
    const ns = 'user:cadence-faildelete'
    const slug = namespaceSlug(ns)
    const { real, c } = fresh()
    await put(ns, { entries: { 'a.md': b64('v1') } })

    c.reset()
    c.failNextDelete = true
    const r = await put(ns, { entries: { 'a.md': b64('v2') } })
    expect(r.accepted).toEqual(['a.md'])
    expect(c.calls.list).toBe(0)
    expect(events.map(e => e.event)).toEqual(['reclaim_failed'])
    expect(events[0]?.nsSlug).toBe(slug)
    // The bytes the failed delete was for are still there, which is what the
    // next write has to find without a touched key to name them.
    expect(await real.get(blobOf(slug, 'v1'))).not.toBeNull()

    c.reset()
    await put(ns, { entries: { 'a.md': b64('v3') } })
    expect(c.calls.list).toBe(1)
    expect(await real.get(blobOf(slug, 'v1'))).toBeNull()
    expect(await real.get(blobOf(slug, 'v2'))).toBeNull()
    expect(await real.list(blobPrefix(slug))).toEqual([blobOf(slug, 'v3')])

    // Control: the forced sweep is one write, not a change of cadence.
    c.reset()
    await put(ns, { entries: { 'a.md': b64('v4') } })
    expect(c.calls.list).toBe(0)
    expect(events.length).toBe(1)
  })

  test('a commit that throws makes the next successful write sweep', async () => {
    const ns = 'user:cadence-failcommit'
    const slug = namespaceSlug(ns)
    const { real, c } = fresh()
    await put(ns, { entries: { 'a.md': b64('v1') } })

    // The blob lands, the manifest does not: an orphan no key will ever name.
    c.reset()
    c.failManifestPut = true
    const err = await put(ns, { entries: { 'a.md': b64('v2') } }).catch(e => e)
    expect(err).toBeInstanceOf(Boom)
    expect(c.calls.list).toBe(0)
    const orphan = blobOf(slug, 'v2')
    expect(await real.get(orphan)).not.toBeNull()
    expect(await real.get(blobOf(slug, 'v1'))).not.toBeNull()

    c.reset()
    const r = await put(ns, { entries: { 'a.md': b64('v3') } })
    expect(r.accepted).toEqual(['a.md'])
    expect(c.calls.list).toBe(1)
    expect(await real.get(orphan)).toBeNull()
    expect(await real.get(blobOf(slug, 'v1'))).toBeNull()
    const data = await getData(ns, slug)
    expect(Buffer.from(data.content.entries['a.md'] as string, 'base64').toString()).toBe('v3')

    // Control: without the failed commit the same write would not have listed.
    c.reset()
    await put(ns, { entries: { 'a.md': b64('v4') } })
    expect(c.calls.list).toBe(0)
  })
})
