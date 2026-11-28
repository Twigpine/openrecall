import { expect, test } from 'bun:test'
import { config } from '../src/config.ts'
import { getData, getEntries, upsert } from '../src/memory.ts'
import { namespaceSlug } from '../src/namespace.ts'
import { getStore, resetStore, setStore } from '../src/store/index.ts'

test('full and bulk reads honor the configured concurrency', async () => {
  const ns = 'user:read-pool'
  const slug = namespaceSlug(ns)
  const keys = ['a', 'b', 'c', 'd', 'e']
  const entries = Object.fromEntries(keys.map(k => [k, Buffer.from(k).toString('base64')]))
  await upsert(ns, slug, 'local', { entries }, new Date().toISOString())
  const store = getStore()
  let active = 0
  let peak = 0
  const get = async (path: string) => {
    if (path.endsWith('/manifest.json')) return store.get(path)
    peak = Math.max(peak, ++active)
    try {
      await Bun.sleep(1)
      return await store.get(path)
    } finally {
      active--
    }
  }
  const original = config.storeConcurrency
  try {
    resetStore()
    setStore({
      get,
      put: store.put.bind(store),
      delete: store.delete.bind(store),
      list: store.list.bind(store),
      describe: store.describe.bind(store),
      erasure: store.erasure,
    })
    for (const limit of [1, 3]) {
      Object.assign(config, { storeConcurrency: limit })
      peak = 0
      expect((await getData(ns, slug)).content.entries).toEqual(entries)
      expect(peak).toBe(limit)
      peak = 0
      const bulk = await getEntries(ns, slug, keys)
      expect(bulk.status).toBe('ok')
      expect(peak).toBe(limit)
    }
  } finally {
    Object.assign(config, { storeConcurrency: original })
    resetStore()
  }
})
