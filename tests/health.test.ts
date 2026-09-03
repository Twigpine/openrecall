/**
 * Health is liveness; the store check runs at startup (U6, R15/R24).
 *
 * The health route is unauthenticated, so anything it reports is public. It
 * used to echo the store's description, which on a driver whose label carries a
 * URL or an owner would hand that to anyone. Reachability is worth knowing, but
 * it belongs at startup where an operator sees it and a broken store keeps the
 * process from binding at all.
 */

import { describe, expect, test } from 'bun:test'
import { handleRequest } from '../src/handler.ts'
import { usagePath } from '../src/quota.ts'
import type { BlobStore } from '../src/store/blobstore.ts'
import { entryPath, manifestPath } from '../src/store/blobstore.ts'
import { getStore, resetStore, setStore } from '../src/store/index.ts'
import { PROBE_PREFIX, probeStore } from '../src/store/probe.ts'

describe('health route', () => {
  test('reports liveness and nothing about the store', async () => {
    const res = await handleRequest(new Request('http://x/health'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, service: 'memlawb' })
  })
})

describe('startup store probe', () => {
  test('round-trips and leaves nothing behind', async () => {
    resetStore()
    const store = getStore()
    const seen: string[] = []
    setStore({
      get: p => {
        seen.push(`get ${p}`)
        return store.get(p)
      },
      put: (p, b) => {
        seen.push(`put ${p}`)
        return store.put(p, b)
      },
      delete: p => {
        seen.push(`delete ${p}`)
        return store.delete(p)
      },
      list: p => store.list(p),
      describe: () => store.describe(),
      erasure: store.erasure,
    })
    const r = await probeStore()
    expect(r.ok).toBe(true)
    // Wrote, read back, and removed: the object must not survive the probe.
    const written = seen.find(s => s.startsWith('put '))?.slice(4) as string
    expect(written).toStartWith(PROBE_PREFIX)
    resetStore()
    expect(await getStore().get(written)).toBeNull()
  })

  test('a failing store reports failure without naming a credential', async () => {
    const inner = getStore()
    setStore({
      get: p => inner.get(p),
      put: async () => {
        throw new Error('connect ECONNREFUSED key=AKIAsecret bucket=private-bucket')
      },
      delete: p => inner.delete(p),
      list: p => inner.list(p),
      describe: () => 's3:private-bucket',
      erasure: 'erases',
    } as BlobStore)
    const r = await probeStore()
    resetStore()
    expect(r.ok).toBe(false)
    expect(r.detail).not.toContain('AKIAsecret')
    expect(r.detail).not.toContain('private-bucket')
  })

  test('the probe prefix is disjoint from every tenant path prefix', () => {
    // Tenants supply namespaces, never store paths, so asserting the validators
    // reject the prefix would prove the wrong thing and could not fail. Assert
    // against the prefixes the path builders actually produce.
    const tenantPaths = [manifestPath('deadbeef'), entryPath('deadbeef', 'abc'), usagePath('alice')]
    // Control: those really are the shapes tenant data takes.
    expect(tenantPaths.some(p => p.startsWith('ns/'))).toBe(true)
    expect(tenantPaths.some(p => p.startsWith('owners/'))).toBe(true)
    for (const p of tenantPaths) expect(p.startsWith(PROBE_PREFIX)).toBe(false)
  })
})
