/**
 * The rejection log (U7, R13, AE8).
 *
 * An operator needs to know which account was refused and why. The risk is that
 * a log line becomes the one place plaintext leaks, so the field set is an
 * allowlist fixed in KTD15 rather than a denylist: the space of things that
 * must not appear is open-ended, and a denylist only catches what someone
 * thought of. A namespace slug is excluded too. It looks opaque but it is a
 * hash of a low-entropy namespace, so it is a stable per-tenant identifier
 * anyone can reverse by dictionary.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { bucketKey, DEFAULT_CONTEXT, handleRequest } from '../src/handler.ts'
import { ALLOWED_FIELDS, setRejectionSink } from '../src/log.ts'
import { _reset } from '../src/ratelimit.ts'

const lines: Record<string, unknown>[] = []

afterEach(() => {
  setRejectionSink(null)
  lines.length = 0
  // The bucket is per owner and in-process, and every test here shares one
  // owner under open auth. Draining it would leak refusals into the suites that
  // share this process.
  _reset()
})

function capture() {
  lines.length = 0
  setRejectionSink(l => lines.push(l as Record<string, unknown>))
}

describe('rejection log', () => {
  test('a rate-limited caller produces exactly one line, with only allowed fields', async () => {
    capture()
    let last: Response | undefined
    for (let i = 0; i < 400; i++) {
      last = await handleRequest(new Request('http://x/api/memory/user:local'))
      if (last.status === 429) break
    }
    expect(last?.status).toBe(429)
    // Every refusal on the way here is logged too (the namespace does not
    // exist, so each read is a 404). All of them must obey the allowlist.
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(Object.keys(l).sort()).toEqual([...ALLOWED_FIELDS].sort())
    const limited = lines.filter(l => l.code === 'rate_limited')
    expect(limited.length).toBe(1)
    expect(limited[0]?.status).toBe(429)
    expect(limited[0]?.owner).toBe('local')
  })

  test('negative control: a line carrying an extra field fails the same check', () => {
    const planted = { timestamp: 't', owner: 'o', code: 'c', status: 1, route: 'r', slug: 'x' }
    expect(Object.keys(planted).sort()).not.toEqual([...ALLOWED_FIELDS].sort())
  })

  test('a sentinel in the request never reaches the line, and the check can see one', async () => {
    capture()
    const sentinel = 'SENTINEL-abc123'
    let last: Response | undefined
    for (let i = 0; i < 400; i++) {
      last = await handleRequest(new Request(`http://x/api/memory/user:${sentinel}`))
      if (last.status === 429) break
    }
    expect(last?.status).toBe(429)
    expect(lines.length).toBeGreaterThan(0)
    const serialized = JSON.stringify(lines)
    expect(serialized).not.toContain(sentinel)
    // Control: the assertion can actually see a sentinel when one is present.
    expect(JSON.stringify([{ ...lines[0], planted: sentinel }])).toContain(sentinel)
  })

  test('a throw from path parsing still returns an envelope and logs one line', async () => {
    // A malformed percent escape throws in decodeURIComponent, which happens
    // before respond()'s own try block. Without a guard in handleRequest that
    // reaches the runtime unhandled: no envelope, no security headers, no line.
    capture()
    const res = await handleRequest(new Request('http://x/api/memory/%'))
    expect(res.status).toBe(500)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('internal')
    expect(lines.length).toBe(1)
    expect(Object.keys(lines[0] as object).sort()).toEqual([...ALLOWED_FIELDS].sort())
    expect(lines[0]?.code).toBe('internal')
  })

  test('an unknown route is logged on the other route class', async () => {
    capture()
    const res = await handleRequest(new Request('http://x/nope'))
    expect(res.status).toBe(404)
    expect(lines.length).toBe(1)
    expect(lines[0]?.route).toBe('other')
    expect(lines[0]?.code).toBe('not_found')
    // The owner is 'local' here, not 'anonymous': tests/setup.ts pins
    // ALLOW_UNAUTHENTICATED process-wide, so authenticate always returns an
    // identity. The 'anonymous' default is only reachable with auth required,
    // which this harness cannot express, so it is asserted at unit level below.
    expect(lines[0]?.owner).toBe('local')
  })

  test('an authenticated caller draws from its own bucket, not the shared one', () => {
    // Not drivable through the handler here: the harness authenticates every
    // caller as the same owner, so a shared bucket and a per-owner one behave
    // identically. Pin the rule where it is decided.
    expect(bucketKey({ owner: 'alice' })).toBe('alice')
    expect(bucketKey({ owner: 'bob' })).toBe('bob')
    // Control: an unauthenticated caller shares one bucket rather than getting
    // an unthrottled path.
    expect(bucketKey(null)).toBe('anonymous')
  })

  test('the request context defaults to an anonymous caller on the other route', () => {
    // The defaults above cannot be driven through the handler under this
    // harness, so pin them where they are set. Control: both differ from the
    // values the handler overwrites them with.
    expect(DEFAULT_CONTEXT).toEqual({ owner: 'anonymous', route: 'other' })
    expect(DEFAULT_CONTEXT.owner).not.toBe('local')
    expect(DEFAULT_CONTEXT.route).not.toBe('memory')
  })

  test('a method-not-allowed caller is logged with its code', async () => {
    capture()
    const res = await handleRequest(
      new Request('http://x/api/memory/user:local', { method: 'POST' }),
    )
    expect(res.status).toBe(405)
    expect(lines.length).toBe(1)
    expect(lines[0]?.code).toBe('method_not_allowed')
    expect(lines[0]?.route).toBe('memory')
  })
})
