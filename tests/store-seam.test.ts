/**
 * The store factory's test seam (U1).
 *
 * `getStore()` memoizes for the life of the process, which is right for the
 * server and impossible for tests: a fault-injecting store (U2's sweep) and a
 * second driver in one process both need to replace the cached instance and put
 * the real one back. The seam exists for that and nothing else, so the last test
 * here walks the production import graph and fails if anything under src/ that
 * the server actually loads reaches for it.
 */

import { describe, expect, test } from 'bun:test'
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
    describe: () => 'stub',
    erasure: 'erases',
  }
}

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
      for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
        await walk(resolve(dirname(file), m[1] as string))
      }
    }

    await walk(join(root, 'src/index.ts'))
    await walk(join(root, 'src/mcp/server.ts'))

    // Positive control: the walk actually reached the modules it claims to cover.
    expect(seen.size).toBeGreaterThan(8)
    expect([...seen].some(f => f.endsWith('src/store/index.ts'))).toBe(true)
    expect(offenders).toEqual([])
  })
})
