/**
 * The store factory's test seam.
 *
 * `getStore()` memoizes for the life of the process, which is right for the
 * server and impossible for tests: a fault-injecting store (the crash sweep) and a
 * second driver in one process both need to replace the cached instance and put
 * the real one back. The seam exists for that and nothing else, so the last test
 * here walks the production import graph and fails if anything under src/ that
 * the server actually loads reaches for it.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { BlobStore } from '../src/store/blobstore.ts'
import { getStore, resetStore, setStore } from '../src/store/index.ts'

const SENTINEL = new TextEncoder().encode('sentinel')

function stub(): BlobStore {
  return {
    get: async () => SENTINEL,
    put: async () => {},
    delete: async () => {},
    list: async () => [],
    describe: () => 'stub',
    erasure: 'erases',
  }
}

// A failing assertion before an inline resetStore() would otherwise leak this
// file's stub into every later suite in the shared process.
afterEach(() => resetStore())

describe('filesystem listing', () => {
  test('an absent prefix lists nothing rather than throwing', async () => {
    resetStore()
    // reclaim lists a namespace's blob directory on every mutating write,
    // including the first, when that directory does not exist yet.
    expect(await getStore().list('ns/definitely-not-here/blobs/')).toEqual([])
  })

  test('a half-written temp file is not listed as a blob', async () => {
    resetStore()
    const store = getStore()
    const prefix = 'ns/listfixture/blobs/'
    await store.put(`${prefix}real`, new TextEncoder().encode('x'))
    await store.put(`${prefix}.tmp-123-1-1`, new TextEncoder().encode('y'))
    // Control: both objects are really there, so the filter is what removes one
    // rather than the write having failed.
    expect(await store.get(`${prefix}.tmp-123-1-1`)).not.toBeNull()
    expect(await store.list(prefix)).toEqual([`${prefix}real`])
  })
})

describe('store factory seam', () => {
  test('setStore installs an instance getStore then returns', async () => {
    setStore(stub())
    expect(getStore().describe()).toBe('stub')
    expect(await getStore().get('anything')).toEqual(SENTINEL)
    resetStore()
  })

  test('resetStore restores the real driver', () => {
    setStore(stub())
    resetStore()
    expect(getStore().describe()).toStartWith('fs:')
  })

  test('without an override, getStore memoizes one instance', () => {
    resetStore()
    expect(getStore()).toBe(getStore())
  })

  // The seam is production code, so the guard is that production never reaches
  // it. A grep for callers would be an absence claim proved by grep, which is
  // the shape docs/solutions/conventions/verify-completeness-by-proof-not-
  // assertion.md rejects; this walks the real import graph instead.
  test('the seam is unreachable from the production import graph', async () => {
    const root = resolve(import.meta.dir, '..')
    const seen = new Set<string>()
    const offenders: string[] = []

    async function walk(file: string): Promise<void> {
      if (seen.has(file)) return
      seen.add(file)
      let src: string
      try {
        src = await readFile(file, 'utf8')
      } catch {
        return
      }
      if (file !== join(root, 'src/store/index.ts')) {
        if (/\b(setStore|resetStore)\b/.test(src)) offenders.push(file.slice(root.length + 1))
      }
      // Static imports and dynamic import() alike. Following import() adds no
      // reach today, since bin/memlawb.ts's only dynamic targets are the two
      // roots below; it is here so the walk does not silently stop covering
      // them if those roots are ever dropped.
      for (const m of src.matchAll(/(?:from|import)\s*\(?\s*'(\.[^']+)'/g)) {
        await walk(resolve(dirname(file), m[1] as string))
      }
    }

    await walk(join(root, 'src/index.ts'))
    await walk(join(root, 'src/mcp/server.ts'))
    await walk(join(root, 'bin/memlawb.ts'))

    // Positive control: the walk reached every module it claims to cover. This
    // is an exact count, not a floor, because a floor is what let an earlier
    // version of this test lose reach without failing: any module added to or
    // dropped from the production graph should force a look at this number.
    expect(seen.size).toBe(25)
    expect([...seen].some(f => f.endsWith('src/store/index.ts'))).toBe(true)
    expect(offenders).toEqual([])
  })
})
