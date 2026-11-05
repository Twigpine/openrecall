/**
 * The access-date sidecar (`src/mcp/accessed.ts`): the merge rule, the
 * defensive parse, and the lone flush with its one sidecar-only 409 retry,
 * against a stub client that can refuse a push on demand.
 */

import { describe, expect, test } from 'bun:test'
import type { PushResult } from '../client/index.ts'
import {
  type AccessedClient,
  flushAccessed,
  isSidecarOnlyConflict,
  MAX_ACCESSED_KEYS,
  mergeAccessed,
  noteAccess,
  parseAccessed,
  prepareAccessed,
  serializeAccessed,
  settleAccess,
  today,
} from '../src/mcp/accessed.ts'
import { ACCESSED_KEY } from '../src/mcp/keys.ts'
import { httpError } from './stub-client.ts'

/** A client holding one namespace, whose next pushes can be made to fail. */
function stub(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial }
  const failures: unknown[] = []
  const pushed: Record<string, string>[] = []
  const client: AccessedClient = {
    async entry(_ns, key) {
      if (Object.keys(store).length === 0) throw httpError(404, 'empty')
      if (!Object.hasOwn(store, key)) throw httpError(404, 'entry_not_found')
      return store[key] as string
    },
    async push(namespace, entries): Promise<PushResult> {
      pushed.push({ ...entries })
      const err = failures.shift()
      if (err) throw err
      Object.assign(store, entries)
      return { namespace, version: 1, uploaded: Object.keys(entries), unchanged: [], deleted: [] }
    },
  }
  return { client, store, failures, pushed }
}

const sidecarConflict = () =>
  httpError(409, 'stale_base_version', { conflicts: { [ACCESSED_KEY]: 'sha256:aa' } })

describe('today and noteAccess', () => {
  test('today is the UTC calendar day', () => {
    expect(today(new Date('2026-11-05T23:59:59.000Z'))).toBe('2026-11-05')
    expect(today(new Date('2026-11-06T00:00:00.000Z'))).toBe('2026-11-06')
  })

  test('noteAccess keeps the later day per key and namespace', () => {
    const pending = new Map<string, Map<string, string>>()
    noteAccess(pending, 'user:a', 'k.md', '2026-11-05')
    noteAccess(pending, 'user:a', 'k.md', '2026-11-04')
    noteAccess(pending, 'user:a', 'j.md', '2026-11-04')
    noteAccess(pending, 'user:a', 'j.md', '2026-11-06')
    noteAccess(pending, 'user:b', 'k.md', '2026-01-01')
    expect([...(pending.get('user:a') ?? [])]).toEqual([
      ['k.md', '2026-11-05'],
      ['j.md', '2026-11-06'],
    ])
    expect(pending.get('user:b')?.get('k.md')).toBe('2026-01-01')
  })
})

describe('parse, merge, serialize', () => {
  test('anything unreadable parses as an empty sidecar', () => {
    for (const bad of [null, undefined, '', 'not json', '[]', '42', '{"keys":[]}', '{"v":1}']) {
      expect(parseAccessed(bad)).toEqual({ v: 1, keys: {} })
    }
  })

  test('only key -> date pairs survive the parse, and never a prototype key', () => {
    const text = JSON.stringify({
      v: 1,
      keys: { 'a.md': '2026-11-05', 'b.md': 7, 'c.md': 'yesterday', __proto__: '2026-01-01' },
    })
    const parsed = parseAccessed(text)
    expect(parsed.keys).toEqual({ 'a.md': '2026-11-05' })
    expect(Object.getPrototypeOf(parsed.keys)).toBe(Object.prototype)
    const polluted = parseAccessed('{"v":1,"keys":{"__proto__":{"x":"2026-01-01"}}}')
    expect(Object.keys(polluted.keys)).toEqual([])
  })

  test('merge is union with the later date per key', () => {
    const stored = { v: 1 as const, keys: { 'a.md': '2026-11-05', 'b.md': '2026-11-01' } }
    const { sidecar, changed } = mergeAccessed(
      stored,
      new Map([
        ['a.md', '2026-11-03'],
        ['b.md', '2026-11-04'],
        ['c.md', '2026-11-02'],
      ]),
    )
    expect(changed).toBe(true)
    expect(sidecar.keys).toEqual({
      'a.md': '2026-11-05',
      'b.md': '2026-11-04',
      'c.md': '2026-11-02',
    })
    // The input is not mutated.
    expect(stored.keys['b.md']).toBe('2026-11-01')
  })

  test('merging nothing newer reports no change', () => {
    const stored = { v: 1 as const, keys: { 'a.md': '2026-11-05' } }
    expect(mergeAccessed(stored, new Map([['a.md', '2026-11-05']])).changed).toBe(false)
    expect(mergeAccessed(stored, new Map([['a.md', '2026-11-01']])).changed).toBe(false)
    expect(mergeAccessed(stored, new Map([['a.md', 'bogus']])).changed).toBe(false)
    expect(mergeAccessed(stored, new Map()).changed).toBe(false)
  })

  test('past the cap the oldest dates are dropped', () => {
    const keys: Record<string, string> = {}
    for (let i = 0; i < MAX_ACCESSED_KEYS; i++) keys[`k${i}.md`] = '2026-06-01'
    keys['old.md'] = '2020-01-01'
    const { sidecar } = mergeAccessed({ v: 1, keys }, new Map([['new.md', '2026-11-05']]))
    expect(Object.keys(sidecar.keys)).toHaveLength(MAX_ACCESSED_KEYS)
    expect(sidecar.keys['new.md']).toBe('2026-11-05')
    expect(sidecar.keys['old.md']).toBeUndefined()
  })

  test('serialization sorts keys so an unchanged sidecar is byte-identical', () => {
    const a = serializeAccessed({ v: 1, keys: { 'b.md': '2026-11-05', 'a.md': '2026-11-04' } })
    const b = serializeAccessed({ v: 1, keys: { 'a.md': '2026-11-04', 'b.md': '2026-11-05' } })
    expect(a).toBe(b)
    expect(a).toBe('{"v":1,"keys":{"a.md":"2026-11-04","b.md":"2026-11-05"}}')
    expect(parseAccessed(a).keys).toEqual({ 'a.md': '2026-11-04', 'b.md': '2026-11-05' })
  })

  test('settleAccess drops what was flushed and keeps what was recalled again since', () => {
    const pending = new Map([
      ['a.md', '2026-11-05'],
      ['b.md', '2026-11-06'],
      ['c.md', '2026-11-05'],
    ])
    settleAccess(
      pending,
      new Map([
        ['a.md', '2026-11-05'],
        ['b.md', '2026-11-05'],
      ]),
    )
    expect([...pending.keys()]).toEqual(['b.md', 'c.md'])
  })
})

describe('isSidecarOnlyConflict', () => {
  test('is true only for a 409 whose conflicts name the sidecar and nothing else', () => {
    expect(isSidecarOnlyConflict(sidecarConflict())).toBe(true)
    expect(
      isSidecarOnlyConflict(
        httpError(409, 'stale_base_version', {
          conflicts: { [ACCESSED_KEY]: 'sha256:aa', 'a.md': 'sha256:bb' },
        }),
      ),
    ).toBe(false)
    expect(
      isSidecarOnlyConflict(httpError(409, 'stale_base_version', { conflicts: { 'a.md': null } })),
    ).toBe(false)
    expect(isSidecarOnlyConflict(httpError(409, 'stale_base_version'))).toBe(false)
    expect(isSidecarOnlyConflict(httpError(409, 'stale_base_version', { conflicts: [] }))).toBe(
      false,
    )
    expect(
      isSidecarOnlyConflict(httpError(403, 'forbidden', { conflicts: { [ACCESSED_KEY]: 'x' } })),
    ).toBe(false)
    expect(isSidecarOnlyConflict(new Error('409'))).toBe(false)
  })
})

describe('prepareAccessed and flushAccessed', () => {
  test('an absent sidecar is read as empty and the pending stamps become it', async () => {
    const { client } = stub()
    const content = await prepareAccessed(client, 'user:a', new Map([['k.md', '2026-11-05']]))
    expect(content).toBe('{"v":1,"keys":{"k.md":"2026-11-05"}}')
    expect(await prepareAccessed(client, 'user:a', new Map())).toBeNull()
  })

  test('a flush writes the union and settles the pending map', async () => {
    const { client, store } = stub({
      'k.md': 'note',
      [ACCESSED_KEY]: '{"v":1,"keys":{"k.md":"2026-11-01","j.md":"2026-11-09"}}',
    })
    const pending = new Map([
      ['k.md', '2026-11-05'],
      ['j.md', '2026-11-02'],
    ])
    expect(await flushAccessed(client, 'user:a', pending)).toBe(true)
    expect(parseAccessed(store[ACCESSED_KEY]).keys).toEqual({
      'k.md': '2026-11-05',
      'j.md': '2026-11-09',
    })
    expect(pending.size).toBe(0)
  })

  test('a sidecar-only 409 is re-read, merged and retried once, with nothing lost', async () => {
    const { client, store, failures, pushed } = stub({
      'k.md': 'note',
      [ACCESSED_KEY]: '{"v":1,"keys":{"k.md":"2026-11-01"}}',
    })
    const pending = new Map([['k.md', '2026-11-05']])
    // Another session lands its own flush between this client's read and push.
    const original = client.push
    let raced = false
    client.push = async (ns, entries) => {
      if (!raced) {
        raced = true
        store[ACCESSED_KEY] = '{"v":1,"keys":{"k.md":"2026-11-02","other.md":"2026-11-04"}}'
        failures.push(sidecarConflict())
      }
      return original(ns, entries)
    }
    expect(await flushAccessed(client, 'user:a', pending)).toBe(true)
    expect(pushed).toHaveLength(2)
    expect(parseAccessed(store[ACCESSED_KEY]).keys).toEqual({
      'k.md': '2026-11-05',
      'other.md': '2026-11-04',
    })
    expect(pending.size).toBe(0)
  })

  test('a second sidecar-only 409 gives up and keeps the stamps pending', async () => {
    const { client, failures, pushed } = stub({ 'k.md': 'note' })
    failures.push(sidecarConflict(), sidecarConflict())
    const pending = new Map([['k.md', '2026-11-05']])
    expect(await flushAccessed(client, 'user:a', pending)).toBe(false)
    expect(pushed).toHaveLength(2)
    expect(pending.size).toBe(1)
  })

  test('any other failure is swallowed and the stamps stay pending', async () => {
    const { client, failures, pushed } = stub({ 'k.md': 'note' })
    failures.push(httpError(409, 'stale_base_version', { conflicts: { 'k.md': 'sha256:aa' } }))
    const pending = new Map([['k.md', '2026-11-05']])
    expect(await flushAccessed(client, 'user:a', pending)).toBe(false)
    expect(pushed).toHaveLength(1)
    expect(pending.size).toBe(1)
    failures.push(httpError(401, 'unauthorized'))
    expect(await flushAccessed(client, 'user:a', pending)).toBe(false)
    expect(pending.size).toBe(1)
  })

  test('nothing newer than the stored sidecar writes nothing and settles', async () => {
    const { client, pushed } = stub({
      'k.md': 'note',
      [ACCESSED_KEY]: '{"v":1,"keys":{"k.md":"2026-11-05"}}',
    })
    const pending = new Map([['k.md', '2026-11-05']])
    expect(await flushAccessed(client, 'user:a', pending)).toBe(false)
    expect(pushed).toHaveLength(0)
    expect(pending.size).toBe(0)
  })
})
