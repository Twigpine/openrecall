/**
 * Crash visibility across the commit sequence (U2, R9, AE4).
 *
 * The property: a reader never sees a manifest naming a blob that is absent,
 * nor a blob whose bytes disagree with the hash the visible manifest records
 * for it. Both directions matter. Today's write path overwrites an entry blob
 * in place at a key-derived path, so a fault after the first blob write leaves
 * the old manifest pointing at new bytes, which is the second direction.
 *
 * A single injection offset proves nothing here, so this sweeps every mutating
 * call in the commit and evidences the plant at each index before reading.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { sha256Hex, sha256Prefixed } from '../src/hash.ts'
import { getData, upsert } from '../src/memory.ts'
import { namespaceSlug } from '../src/namespace.ts'
import type { BlobStore } from '../src/store/blobstore.ts'
import { getStore, resetStore, setStore } from '../src/store/index.ts'

const NOW = '2026-06-24T00:00:00.000Z'
const b64 = (s: string) => Buffer.from(s).toString('base64')

class Boom extends Error {}

/** Wraps the real store and throws on the nth mutating call, counting attempts. */
function faulty(inner: BlobStore, failAt: number) {
  let calls = 0
  const guard = () => {
    if (calls++ === failAt) throw new Boom(`injected at ${failAt}`)
  }
  return {
    calls: () => calls,
    store: {
      get: (p: string) => inner.get(p),
      put: async (p: string, b: Uint8Array) => {
        guard()
        return inner.put(p, b)
      },
      delete: async (p: string) => {
        guard()
        return inner.delete(p)
      },
      describe: () => `faulty(${inner.describe()})`,
    } as BlobStore,
  }
}

/** Write one entry the way the pre-content-addressing code did: blob at a
 *  key-derived path, manifest naming it. This is the only way to get genuine
 *  legacy layout now that upsert writes content-addressed. */
async function plantLegacy(store: BlobStore, slug: string, key: string, body: string) {
  const bytes = new Uint8Array(Buffer.from(body))
  const path = `ns/${slug}/entries/${sha256Hex(key)}`
  await store.put(path, bytes)
  const m = {
    version: 1,
    lastModified: NOW,
    entries: { [key]: { hash: sha256Prefixed(bytes), size: bytes.byteLength, updatedAt: NOW } },
  }
  await store.put(`ns/${slug}/manifest.json`, new TextEncoder().encode(JSON.stringify(m)))
  return path
}

async function seed(ns: string, entries: Record<string, string>) {
  resetStore()
  await upsert(ns, namespaceSlug(ns), 'local', { entries }, NOW)
}

/** Every visible entry's bytes must match the hash the visible manifest records. */
async function assertConsistent(ns: string) {
  const data = await getData(ns, namespaceSlug(ns))
  for (const [key, b] of Object.entries(data.content.entries)) {
    const bytes = new Uint8Array(Buffer.from(b, 'base64'))
    expect(sha256Prefixed(bytes)).toBe(data.content.entryChecksums[key] as string)
  }
  // No manifest entry may lack a readable blob.
  expect(Object.keys(data.content.entries).sort()).toEqual(
    Object.keys(data.content.entryChecksums).sort(),
  )
  return data
}

afterEach(() => resetStore())

describe('crash visibility across the commit sequence', () => {
  test('sweep: a fault at any mutating call leaves the previous complete state', async () => {
    const ns = 'user:sweep'
    await seed(ns, { 'a.md': b64('a1'), 'b.md': b64('b1'), 'c.md': b64('c1') })
    const before = await assertConsistent(ns)

    const real = getStore()
    let injected = 0
    let untorn = 0
    let published = 0
    for (let i = 0; i < 8; i++) {
      resetStore()
      const f = faulty(real, i)
      setStore(f.store)
      const err = await upsert(
        ns,
        namespaceSlug(ns),
        'local',
        {
          entries: { 'a.md': b64('a2'), 'b.md': b64('b2'), 'd.md': b64('d1') },
          deletions: ['c.md'],
        },
        NOW,
      ).catch(e => e)
      resetStore()
      if (!(err instanceof Boom)) continue // past the end of the mutating sequence
      injected++
      // Evidence the plant landed at this index rather than short-circuiting.
      expect(f.calls()).toBe(i + 1)
      // Either the commit had not yet published (previous state) or it had
      // (new state). Never a torn one: that is what R9 asserts. A fault during
      // the post-manifest reclaim legitimately leaves the new state visible.
      const after = await assertConsistent(ns)
      const keys = Object.keys(after.content.entries).sort().join(',')
      expect(['a.md,b.md,c.md', 'a.md,b.md,d.md']).toContain(keys)
      if (keys === 'a.md,b.md,c.md') {
        expect(after.content.entries).toEqual(before.content.entries)
        untorn++
      } else {
        published++
      }
    }
    // Control that the sweep spanned the manifest write rather than only one side.
    expect(untorn).toBeGreaterThan(0)
    expect(published).toBeGreaterThan(0)
    // Positive control: the sweep actually injected faults, at more than one index.
    expect(injected).toBeGreaterThan(2)
  })

  test('harness control: a fault at index 0 leaves the namespace untouched', async () => {
    const ns = 'user:ctl'
    await seed(ns, { 'a.md': b64('a1') })
    const real = getStore()
    const f = faulty(real, 0)
    setStore(f.store)
    const err = await upsert(
      ns,
      namespaceSlug(ns),
      'local',
      { entries: { 'a.md': b64('a2') } },
      NOW,
    ).catch(e => e)
    resetStore()
    expect(err).toBeInstanceOf(Boom)
    expect(f.calls()).toBe(1)
    const data = await getData(ns, namespaceSlug(ns))
    expect(Buffer.from(data.content.entries['a.md'] as string, 'base64').toString()).toBe('a1')
  })

  test('an unreadable manifest refuses the write and leaves every blob in place', async () => {
    const ns = 'user:corrupt'
    await seed(ns, { 'a.md': b64('a1') })
    const slug = namespaceSlug(ns)
    const store = getStore()
    const blobBefore = await store.get(`ns/${slug}/entries/${sha256Hex('a.md')}`)
    await store.put(`ns/${slug}/manifest.json`, new TextEncoder().encode('{not json'))

    const err = await upsert(ns, slug, 'local', { entries: { 'b.md': b64('b1') } }, NOW).catch(
      e => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect(String((err as Error).message)).toContain('manifest')
    // Control: the pre-existing blob is still there, so nothing was reclaimed.
    expect(await store.get(`ns/${slug}/entries/${sha256Hex('a.md')}`)).toEqual(
      blobBefore as Uint8Array,
    )
  })

  test('a legacy-layout blob is read, and after one rewrite nothing is left at the legacy path', async () => {
    const ns = 'user:legacy'
    const slug = namespaceSlug(ns)
    resetStore()
    const store = getStore()
    const legacy = await plantLegacy(store, slug, 'a.md', 'a1')
    // Control: the legacy object exists before the rewrite.
    expect(await store.get(legacy)).not.toBeNull()

    const read = await getData(ns, slug)
    expect(Buffer.from(read.content.entries['a.md'] as string, 'base64').toString()).toBe('a1')

    await upsert(ns, slug, 'local', { entries: { 'a.md': b64('a2') } }, NOW)
    expect(await store.get(legacy)).toBeNull()
    const after = await getData(ns, slug)
    expect(Buffer.from(after.content.entries['a.md'] as string, 'base64').toString()).toBe('a2')
  })

  test('deleting a legacy-layout entry leaves nothing at either path', async () => {
    const ns = 'user:legacydel'
    const slug = namespaceSlug(ns)
    resetStore()
    const store = getStore()
    const legacy = await plantLegacy(store, slug, 'a.md', 'a1')
    await upsert(ns, slug, 'local', { entries: { 'keep.md': b64('k1') } }, NOW)
    expect(await store.get(legacy)).not.toBeNull()

    await upsert(ns, slug, 'local', { entries: {}, deletions: ['a.md'] }, NOW)
    expect(await store.get(legacy)).toBeNull()
    const after = await assertConsistent(ns)
    expect(Object.keys(after.content.entries)).toEqual(['keep.md'])
  })
})
