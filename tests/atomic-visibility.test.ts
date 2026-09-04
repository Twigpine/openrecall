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
import { getData, getHashes, upsert } from '../src/memory.ts'
import { namespaceSlug } from '../src/namespace.ts'
import type { BlobStore } from '../src/store/blobstore.ts'
import { contentPath, getStore, resetStore, setStore } from '../src/store/index.ts'
import { UnreadableManifestError } from '../src/types.ts'

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
      list: (p: string) => inner.list(p),
      describe: () => `faulty(${inner.describe()})`,
      erasure: inner.erasure,
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
  // No manifest entry may lack a readable blob. This has to compare against the
  // manifest: getData fills entries and entryChecksums in the same branch and
  // returns early when a blob is missing, so comparing those two to each other
  // is comparing a value to itself and cannot fail.
  const manifest = await getHashes(ns, namespaceSlug(ns))
  expect(Object.keys(data.content.entries).sort()).toEqual(
    Object.keys(manifest.entryChecksums).sort(),
  )
  return data
}

afterEach(() => resetStore())

describe('crash visibility across the commit sequence', () => {
  test('sweep: a fault at any mutating call leaves a complete, untorn state', async () => {
    let injected = 0
    let untorn = 0
    let published = 0
    // A fresh namespace per index. Reusing one lets the first successful
    // iteration change the state so later indices never reach a mutating call,
    // which silently halves the sequence the sweep claims to cover.
    for (let i = 0; i < 12; i++) {
      const ns = `user:sweep${i}`
      await seed(ns, { 'a.md': b64('a1'), 'b.md': b64('b1'), 'c.md': b64('c1') })
      const before = await assertConsistent(ns)
      const real = getStore()
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
      if (!(err instanceof Boom)) continue // index beyond this request's mutating calls
      injected++
      // Evidence the plant landed at this index rather than short-circuiting.
      expect(f.calls()).toBe(i + 1)
      // Never a torn state. With reclaim moved out of the commit, every call
      // that can fail happens before the manifest lands, so a fault always
      // leaves the previous state rather than a published one. This is stronger
      // than the disjunction it replaced, and it is not free: writing the
      // manifest before the blobs turns it red.
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
    // Controls. The commit makes exactly four mutating calls: three blob writes
    // and the manifest write. Faults past that land in reclaim, which is
    // non-fatal by design, so four is the whole failable sequence rather than a
    // floor someone guessed. Every one of them leaves the previous state.
    expect(injected).toBe(4)
    expect(untorn).toBe(4)
    expect(published).toBe(0)
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
    const path = contentPath(slug, sha256Prefixed(new Uint8Array(Buffer.from('a1'))))
    const blobBefore = await store.get(path)
    // Control: the blob is really there before the refused write, so the
    // assertion below can fail. Reading the legacy key-derived path here would
    // be null both times and prove nothing.
    expect(blobBefore).not.toBeNull()
    await store.put(`ns/${slug}/manifest.json`, new TextEncoder().encode('{not json'))

    const err = await upsert(ns, slug, 'local', { entries: { 'b.md': b64('b1') } }, NOW).catch(
      e => e,
    )
    expect(err).toBeInstanceOf(UnreadableManifestError)
    // Control: the pre-existing blob is still there, so nothing was reclaimed.
    expect(await store.get(path)).toEqual(blobBefore as Uint8Array)
  })

  test('a manifest hash that is not a digest cannot build a path', async () => {
    // A manifest is parsed JSON, not validated input, and its hashes now form
    // storage paths. Without a shape check a hash carrying separators escapes
    // the namespace directory, which is the one rule this repo states about
    // anything reaching a path.
    expect(() => contentPath('slug', 'sha256:../../other/blobs/deadbeef')).toThrow()
    expect(() => contentPath('slug', 'not-a-hash')).toThrow()
    // Control: a real digest still builds the path it should.
    const good = 'a'.repeat(64)
    expect(contentPath('slug', `sha256:${good}`)).toBe(`ns/slug/blobs/${good}`)
  })

  test('a manifest entry with a non-digest hash is skipped, not fatal', async () => {
    // contentPath throws on a hash that cannot name a blob, which is right on
    // the write path. On the read path one corrupt entry must not take the
    // namespace with it, so getData skips it the way it skips a missing blob.
    const ns = 'user:badhash'
    const slug = namespaceSlug(ns)
    await seed(ns, { 'ok.md': b64('fine') })
    const store = getStore()
    const raw = await store.get(`ns/${slug}/manifest.json`)
    const m = JSON.parse(new TextDecoder().decode(raw as Uint8Array))
    m.entries['bad.md'] = { hash: 'sha256:NOTHEX', size: 4, updatedAt: NOW }
    await store.put(`ns/${slug}/manifest.json`, new TextEncoder().encode(JSON.stringify(m)))

    const data = await getData(ns, slug)
    // Control: the healthy entry still reads, so the skip is targeted rather
    // than the whole view collapsing.
    expect(Buffer.from(data.content.entries['ok.md'] as string, 'base64').toString()).toBe('fine')
    expect(data.content.entries['bad.md']).toBeUndefined()
  })

  test('a reclaim failure does not fail a write that already published', async () => {
    // Reclaim collects blobs no reader can see. Failing it must not turn a
    // durable write into an error, and must not skip the caller's response.
    const ns = 'user:reclaimfail'
    const slug = namespaceSlug(ns)
    await seed(ns, { 'a.md': b64('v1') })
    const real = getStore()
    setStore({
      get: p => real.get(p),
      put: (p, b) => real.put(p, b),
      delete: async () => {
        throw new Boom('reclaim delete failed')
      },
      list: p => real.list(p),
      describe: () => 'delete-hostile',
      erasure: real.erasure,
    })
    const r = await upsert(ns, slug, 'local', { entries: { 'a.md': b64('v2') } }, NOW)
    resetStore()
    expect(r.accepted).toEqual(['a.md'])
    const after = await assertConsistent(ns)
    expect(Buffer.from(after.content.entries['a.md'] as string, 'base64').toString()).toBe('v2')
  })

  test('a delete whose reclaim fails still reports the entry gone, and the bytes go later', async () => {
    const ns = 'user:delreclaim'
    const slug = namespaceSlug(ns)
    await seed(ns, { 'a.md': b64('gone'), 'keep.md': b64('k') })
    const real = getStore()
    const orphan = contentPath(slug, sha256Prefixed(new Uint8Array(Buffer.from('gone'))))
    setStore({
      get: p => real.get(p),
      put: (p, b) => real.put(p, b),
      delete: async () => {
        throw new Boom('reclaim delete failed')
      },
      list: p => real.list(p),
      describe: () => 'delete-hostile',
      erasure: real.erasure,
    })
    const r = await upsert(ns, slug, 'local', { entries: {}, deletions: ['a.md'] }, NOW)
    resetStore()
    expect(r.deleted).toEqual(['a.md'])
    // The bytes survived that failure, which is exactly why reclaim sweeps by
    // listing rather than by the keys a request touched: nothing can name this
    // hash again, so a touched-key reclaim could never collect it.
    expect(await getStore().get(orphan)).not.toBeNull()

    await upsert(ns, slug, 'local', { entries: { 'other.md': b64('o') } }, NOW)
    expect(await getStore().get(orphan)).toBeNull()
  })

  test('a blob two entries share survives deleting one of them', async () => {
    // The server takes ciphertext as opaque bytes, so a client can put the same
    // ciphertext under two keys and they land on one content-addressed blob.
    // Reclaim must not remove it while another entry still names that hash.
    const ns = 'user:shared'
    const slug = namespaceSlug(ns)
    await seed(ns, { 'x.md': b64('same'), 'y.md': b64('same') })
    const store = getStore()
    const shared = contentPath(slug, sha256Prefixed(new Uint8Array(Buffer.from('same'))))
    expect(await store.get(shared)).not.toBeNull()

    await upsert(ns, slug, 'local', { entries: {}, deletions: ['x.md'] }, NOW)
    const after = await assertConsistent(ns)
    expect(Object.keys(after.content.entries)).toEqual(['y.md'])
    expect(Buffer.from(after.content.entries['y.md'] as string, 'base64').toString()).toBe('same')
    expect(await store.get(shared)).not.toBeNull()
  })

  test('a superseded blob is removed once nothing names it', async () => {
    const ns = 'user:supersede'
    const slug = namespaceSlug(ns)
    await seed(ns, { 'a.md': b64('v1') })
    const store = getStore()
    const oldPath = contentPath(slug, sha256Prefixed(new Uint8Array(Buffer.from('v1'))))
    expect(await store.get(oldPath)).not.toBeNull()

    await upsert(ns, slug, 'local', { entries: { 'a.md': b64('v2') } }, NOW)
    expect(await store.get(oldPath)).toBeNull()
  })

  test('a blob orphaned by a crashed write is reclaimed by the next write', async () => {
    const ns = 'user:orphan'
    const slug = namespaceSlug(ns)
    await seed(ns, { 'a.md': b64('a1') })
    const real = getStore()
    // Crash after the blob write, before the manifest write.
    const f = faulty(real, 1)
    setStore(f.store)
    await upsert(ns, slug, 'local', { entries: { 'b.md': b64('b1') } }, NOW).catch(() => {})
    resetStore()
    const store = getStore()
    const orphan = contentPath(slug, sha256Prefixed(new Uint8Array(Buffer.from('b1'))))
    expect(await store.get(orphan)).not.toBeNull()

    await upsert(ns, slug, 'local', { entries: { 'c.md': b64('c1') } }, NOW)
    expect(await store.get(orphan)).toBeNull()
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
