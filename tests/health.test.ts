/**
 * Health is liveness; the store check runs at startup.
 *
 * The health route is unauthenticated, so anything it reports is public. It
 * used to echo the store's description, which on a driver whose label carries a
 * URL or an owner would hand that to anyone. Reachability is worth knowing, but
 * it belongs at startup where an operator sees it and a broken store keeps the
 * process from binding at all.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { handleRequest } from '../src/handler.ts'
import { usagePath } from '../src/quota.ts'
import type { BlobStore } from '../src/store/blobstore.ts'
import { contentPath, entryPath, manifestPath } from '../src/store/blobstore.ts'
import { getStore, resetStore, setStore } from '../src/store/index.ts'
import { PROBE_PREFIX, probeStore } from '../src/store/probe.ts'

// setStore installs a process-wide override, and bun shares one process across
// test files. Without this an assertion failing before an inline resetStore()
// leaks a stub into every later suite.
afterEach(() => resetStore())

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

  test('a store that returns different bytes fails the probe', async () => {
    // A round trip that writes and reads without comparing proves the store
    // answered, not that it stored. This branch is the comparison.
    const inner = getStore()
    setStore({
      get: async () => new TextEncoder().encode('wrong'),
      put: (p, b) => inner.put(p, b),
      delete: p => inner.delete(p),
      list: p => inner.list(p),
      describe: () => 'liar',
      erasure: 'erases',
    })
    const r = await probeStore()
    resetStore()
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('different bytes')
  })

  test('a store that never answers fails the probe instead of hanging startup', async () => {
    // Neither adapter sets a socket timeout, so without a deadline a hung
    // connect leaves startup pending forever and the operator never sees the
    // failure line this module exists to produce.
    const inner = getStore()
    setStore({
      get: p => inner.get(p),
      put: () => new Promise<void>(() => {}),
      delete: p => inner.delete(p),
      list: p => inner.list(p),
      describe: () => 'hangs',
      erasure: 'erases',
    })
    const started = Date.now()
    const r = await probeStore(50)
    resetStore()
    expect(r.ok).toBe(false)
    // Control: it returned because of the deadline, not because the store
    // answered, and it did not wait the production timeout to do it.
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('the probe prefix is disjoint from every tenant path prefix', () => {
    // Tenants supply namespaces, never store paths, so asserting the validators
    // reject the prefix would prove the wrong thing and could not fail. Assert
    // against the prefixes the path builders actually produce.
    const tenantPaths = [
      manifestPath('deadbeef'),
      entryPath('deadbeef', 'abc'),
      contentPath('deadbeef', `sha256:${'a'.repeat(64)}`),
      usagePath('alice'),
    ]
    // Control: those really are the shapes tenant data takes.
    expect(tenantPaths.some(p => p.startsWith('ns/'))).toBe(true)
    expect(tenantPaths.some(p => p.startsWith('owners/'))).toBe(true)
    for (const p of tenantPaths) expect(p.startsWith(PROBE_PREFIX)).toBe(false)
  })
})
