/**
 * Erasure advertisement, server half.
 *
 * Whether a delete actually erases is a property of the store, not of the
 * client, and the client cannot see which driver is configured. So the store
 * declares it and the server reports it where a client already looks: the
 * hashes view and every write response. fs and s3 erase; a store that keeps
 * history (a git-backed store) does not, and a client that knows will
 * refuse a scan mode that would let a secret reach a store it can never leave.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { getData, getHashes, upsert } from '../src/memory.ts'
import { namespaceSlug } from '../src/namespace.ts'
import type { BlobStore } from '../src/store/blobstore.ts'
import { getStore, resetStore, setStore } from '../src/store/index.ts'
import { S3BlobStore } from '../src/store/s3.ts'

const NOW = '2026-06-24T00:00:00.000Z'
const b64 = (s: string) => Buffer.from(s).toString('base64')
const put = (ns: string, req: Parameters<typeof upsert>[3]) =>
  upsert(ns, namespaceSlug(ns), 'local', req, NOW)

afterEach(() => resetStore())

describe('erasure advertisement', () => {
  test('the filesystem driver reports erasing on both surfaces', async () => {
    const ns = 'user:erase'
    const w = await put(ns, { entries: { 'a.md': b64('v1') } })
    expect(w.erasure).toBe('erases')
    const h = await getHashes(ns, namespaceSlug(ns))
    expect(h.erasure).toBe('erases')
    const d = await put(ns, { entries: {}, deletions: ['a.md'] })
    expect(d.erasure).toBe('erases')
    // A client that only ever pulls still needs to know, so the full view
    // carries it too rather than only the hashes view and write responses.
    await put(ns, { entries: { 'b.md': b64('x') } })
    expect((await getData(ns, namespaceSlug(ns))).erasure).toBe('erases')
  })

  test('a retaining store reports retaining on both surfaces', async () => {
    const inner = getStore()
    const retaining: BlobStore = {
      get: p => inner.get(p),
      put: (p, b) => inner.put(p, b),
      delete: p => inner.delete(p),
      list: p => inner.list(p),
      describe: () => 'retaining',
      erasure: 'retains',
    }
    setStore(retaining)
    const ns = 'user:retain'
    const w = await put(ns, { entries: { 'a.md': b64('v1') } })
    expect(w.erasure).toBe('retains')
    const h = await getHashes(ns, namespaceSlug(ns))
    expect(h.erasure).toBe('retains')
  })

  test('a store missing the attribute does not type-check', () => {
    // The pin is the @ts-expect-error itself: if BlobStore ever stops requiring
    // `erasure`, this object becomes valid, the directive becomes unused, and
    // `bun run type-check` fails. That is the control -- the assertion below
    // only proves the object exists.
    // @ts-expect-error - BlobStore requires `erasure`
    const incomplete: BlobStore = {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
      describe: () => 'incomplete',
    }
    expect(incomplete.describe()).toBe('incomplete')
  })

  test('both shipped drivers declare erasure', () => {
    resetStore()
    expect(getStore().erasure).toBe('erases')
    // Read s3's declaration directly. Going through getStore() only ever
    // reaches the filesystem driver under the test config, so flipping s3's
    // value would not be observed -- and s3 is the driver the hosted service
    // runs, which is exactly where a wrong declaration would matter.
    const s3 = new S3BlobStore({
      bucket: 'b',
      endpoint: '',
      region: 'auto',
      accessKeyId: 'k',
      secretAccessKey: 's',
    })
    expect(s3.erasure).toBe('erases')
  })
})
