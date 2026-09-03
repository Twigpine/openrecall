/**
 * S3BlobStore's listing (U2 fix pass).
 *
 * s3 is the driver the hosted service runs, and reclaim now depends on list()
 * to find blobs no manifest names. A list that silently returned only its first
 * page would leave ciphertext behind on exactly the deployment where that
 * matters, and no other test in the suite reaches this driver.
 */

import { describe, expect, test } from 'bun:test'
import { S3BlobStore } from '../src/store/s3.ts'

type Page = { contents?: { key?: string }[]; isTruncated?: boolean; nextContinuationToken?: string }

function withFakeClient(pages: Page[]) {
  const store = new S3BlobStore({
    bucket: 'b',
    endpoint: '',
    region: 'auto',
    accessKeyId: 'k',
    secretAccessKey: 's',
  })
  const seen: (string | undefined)[] = []
  let i = 0
  // biome-ignore lint/suspicious/noExplicitAny: reaching past the private client is the point
  ;(store as any).client = {
    list: async (opts: { prefix: string; continuationToken?: string }) => {
      seen.push(opts.continuationToken)
      return pages[i++] ?? { contents: [] }
    },
  }
  return { store, seen }
}

describe('S3BlobStore.list', () => {
  test('follows continuation tokens across pages and stops when untruncated', async () => {
    const { store, seen } = withFakeClient([
      { contents: [{ key: 'ns/a/blobs/1' }], isTruncated: true, nextContinuationToken: 'tok1' },
      { contents: [{ key: 'ns/a/blobs/2' }], isTruncated: false },
    ])
    expect(await store.list('ns/a/blobs/')).toEqual(['ns/a/blobs/1', 'ns/a/blobs/2'])
    // Control: the second request carried the first page's token, so the walk
    // genuinely paginated rather than being handed both pages at once.
    expect(seen).toEqual([undefined, 'tok1'])
  })

  test('a single untruncated page makes exactly one request', async () => {
    const { store, seen } = withFakeClient([
      { contents: [{ key: 'ns/a/blobs/1' }], isTruncated: false },
    ])
    expect(await store.list('ns/a/blobs/')).toEqual(['ns/a/blobs/1'])
    expect(seen.length).toBe(1)
  })

  test('an empty prefix yields no paths', async () => {
    const { store } = withFakeClient([{ contents: [], isTruncated: false }])
    expect(await store.list('ns/a/blobs/')).toEqual([])
  })
})
