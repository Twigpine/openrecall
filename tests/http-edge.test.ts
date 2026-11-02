/**
 * The HTTP edge is the only thing between the internet and the store, so every
 * client mistake must be a 4xx and every route must answer the method question
 * honestly. Before this suite a malformed percent-escape in the path escaped
 * the handler as a `URIError` (a 500), `/health` answered POST/PUT/DELETE with
 * a success body, and a bogus `content-length` silently skipped the early size
 * check. These tests call the handler directly, with no socket.
 */

import { describe, expect, test } from 'bun:test'
import { config } from '../src/config.ts'
import { handleRequest } from '../src/handler.ts'

const call = (path: string, init?: RequestInit) =>
  handleRequest(new Request(`http://openrecall.test${path}`, init))

type ErrorBody = {
  error?: { code: string; message: string; details?: Record<string, unknown> }
}
const body = async (res: Response) => (await res.json()) as ErrorBody & Record<string, unknown>

const memory = (namespace: string) => `/api/memory/${encodeURIComponent(namespace)}`
const json = (value: unknown): RequestInit => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
})

describe('/health', () => {
  test('GET reports liveness and nothing about the store', async () => {
    const res = await call('/health')
    expect(res.status).toBe(200)
    const b = await body(res)
    expect(b.ok).toBe(true)
    expect(b.service).toBe('openrecall')
    expect(b.store).toBeUndefined()
  })

  test('HEAD has the GET status and headers but no body', async () => {
    const res = await call('/health', { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.text()).toBe('')
  })

  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    test(`${method} is a 405 that names the allowed methods`, async () => {
      const res = await call('/health', { method })
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('GET, HEAD')
      expect((await body(res)).error?.code).toBe('method_not_allowed')
    })
  }
})

describe('path parsing', () => {
  for (const bad of [
    '/api/memory/%',
    '/api/memory/%E0%A4%A',
    '/api/memory/user:me%2',
    '/api/memory/%ZZ',
  ]) {
    test(`${bad} is a 400, not a 500`, async () => {
      const res = await call(bad)
      expect(res.status).toBe(400)
      expect((await body(res)).error?.code).toBe('invalid_path')
    })
  }

  test('an unknown route is still a 404', async () => {
    const res = await call('/nope')
    expect(res.status).toBe(404)
    expect((await body(res)).error?.code).toBe('not_found')
  })

  test('a traversal namespace is rejected by the validator, not decoded into the store', async () => {
    const res = await call('/api/memory/user%3Ame%2F..%2F..%2Fescape')
    expect(res.status).toBe(400)
    expect((await body(res)).error?.code).toBe('invalid_namespace')
  })
})

describe('methods on the memory route', () => {
  for (const method of ['POST', 'PATCH', 'OPTIONS']) {
    test(`${method} is a 405 that names the allowed verbs`, async () => {
      const res = await call(memory('user:edge-methods'), { method })
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('GET, HEAD, PUT, DELETE')
    })
  }
})

describe('declared body size', () => {
  for (const bad of ['abc', '-1', '12, 12']) {
    test(`content-length ${JSON.stringify(bad)} is a 400`, async () => {
      const res = await call(memory('user:edge-body'), {
        method: 'PUT',
        headers: { 'content-length': bad },
        body: '{}',
      })
      expect(res.status).toBe(400)
      expect((await body(res)).error?.message).toContain('content-length')
    })
  }

  test('an oversized declaration is a 413 that names the cap', async () => {
    const res = await call(memory('user:edge-body'), {
      method: 'PUT',
      headers: { 'content-length': String(config.limits.maxBodyBytes + 1) },
      body: '{}',
    })
    expect(res.status).toBe(413)
    expect((await body(res)).error?.details?.max_bytes).toBe(config.limits.maxBodyBytes)
  })

  test('a correct declaration still writes', async () => {
    const res = await call(memory('user:edge-body-ok'), {
      method: 'PUT',
      ...json({ entries: { 'a.md': 'aGk=' } }),
    })
    expect(res.status).toBe(200)
  })
})

describe('HEAD on memory reads', () => {
  const ns = 'user:edge-head'

  test('HEAD of a stored namespace is a bodyless GET', async () => {
    const put = await call(memory(ns), { method: 'PUT', ...json({ entries: { 'a.md': 'aGk=' } }) })
    expect(put.status).toBe(200)

    const res = await call(memory(ns), { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.text()).toBe('')

    const hashes = await call(`${memory(ns)}?view=hashes`, { method: 'HEAD' })
    expect(hashes.status).toBe(200)
    expect(await hashes.text()).toBe('')

    const entry = await call(`${memory(ns)}?view=entry&key=a.md`, { method: 'HEAD' })
    expect(entry.status).toBe(200)
    expect(await entry.text()).toBe('')
  })

  test('HEAD of a refused entry read keeps the status and drops the error body', async () => {
    const res = await call(`${memory(ns)}?view=entry`, { method: 'HEAD' })
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('')
  })

  test('HEAD of an empty namespace mirrors the 404', async () => {
    const res = await call(memory('user:edge-head-empty'), { method: 'HEAD' })
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('')
  })

  test('GET still returns the ciphertext it stored', async () => {
    const res = await call(memory(ns))
    expect(res.status).toBe(200)
    const b = (await res.json()) as {
      content: { entries: Record<string, string>; entryChecksums: Record<string, string> }
    }
    expect(b.content.entries['a.md']).toBe('aGk=')
    expect(b.content.entryChecksums['a.md']).toStartWith('sha256:')
  })
})
