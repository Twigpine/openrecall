/**
 * What a retaining store changes on the surfaces a user and a model actually
 * read (R27, R28, KTD10).
 *
 * The node driver keeps prior ciphertext in repository history and in any pin
 * already taken, so on that store a delete is not an erasure. Two consequences,
 * and neither is visible to the driver's own tests because both live in the
 * client and the tools:
 *
 *  - `memory_delete` answering a bare "deleted" is a false promise. The agent is
 *    what tells the user their memory is gone.
 *  - A non-blocking secret scan is a different bargain when the store retains.
 *    On an erasing store a warned-through credential can be deleted; here it is
 *    permanent, so the client refuses the combination before it encrypts.
 *
 * The erasure comes from the server, which reads it off the store, so nothing
 * here needs the client to know which driver is running.
 */

import { describe, expect, test } from 'bun:test'
import { OpenRecallClient } from '../client/index.ts'
import { makeTools } from '../src/mcp/tools.ts'
import { StubClient } from './stub-client.ts'

describe('R27: the delete tool tells the truth about retention', () => {
  test('a retaining store is named in the response', async () => {
    const stub = new StubClient()
    stub.entries['gone.md'] = 'x'
    stub.erasure = 'retains'
    const r = await makeTools(stub, 'user:me').delete('gone.md')
    expect(r.isError ?? false).toBe(false)
    expect(r.text).toMatch(/retain/i)
    // It still has to say the entry is gone from the namespace: the retention
    // notice explains what survives, it does not replace the outcome.
    expect(r.text).toContain('gone.md')
  })

  test('an erasing store is not, so the sentence is not boilerplate', async () => {
    // The negative control. Without it, a tool that appended the retention text
    // unconditionally would pass the test above while telling every fs and s3
    // user their deletes do not erase, which is its own false statement.
    const stub = new StubClient()
    stub.entries['gone.md'] = 'x'
    stub.erasure = 'erases'
    const r = await makeTools(stub, 'user:me').delete('gone.md')
    expect(r.text).not.toMatch(/retain/i)
  })

  test('a server that reports no erasure gets no claim either way', async () => {
    // Absence of the field is not evidence of erasure. Claiming either would be
    // inventing a fact about a deployment this client cannot see.
    const stub = new StubClient()
    stub.entries['gone.md'] = 'x'
    stub.erasure = null
    const r = await makeTools(stub, 'user:me').delete('gone.md')
    expect(r.text).not.toMatch(/retain/i)
    expect(r.isError ?? false).toBe(false)
  })
})

describe('R28: a non-blocking scan is refused against a retaining store', () => {
  /** A server that reports the erasure under test and records what it was sent. */
  function serve(erasure: string) {
    const seen: string[] = []
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        seen.push(`${req.method} ${url.pathname}${url.search}`)
        if (url.searchParams.get('view') === 'hashes') {
          return Response.json({
            version: 1,
            entryChecksums: {},
            supports: ['base-precondition'],
            erasure,
          })
        }
        return Response.json({ version: 2, accepted: [], deleted: [], skipped: [], erasure })
      },
    })
    return { server, seen, url: `http://localhost:${server.port}` }
  }

  const SECRET = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB'

  test('scan=warn against a retaining store throws, and sends nothing', async () => {
    const { server, seen, url } = serve('retains')
    try {
      const c = new OpenRecallClient({ url, passphrase: 'p', scanMode: 'warn' })
      await expect(c.push('user:me', { 'k.md': `token ${SECRET}` })).rejects.toThrow(/retain/i)
      // The refusal has to land before anything is written. A throw that still
      // uploaded would be a warning dressed as a refusal.
      expect(seen.some(s => s.startsWith('PUT') || s.startsWith('POST'))).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  test('scan=block against the same store is allowed', async () => {
    // The positive control: the refusal is about the scan mode, not about
    // retaining stores being unwritable.
    const { server, seen, url } = serve('retains')
    try {
      const c = new OpenRecallClient({ url, passphrase: 'p', scanMode: 'block' })
      await c.push('user:me', { 'k.md': 'nothing secret here' })
      expect(seen.some(s => s.startsWith('PUT'))).toBe(true)
    } finally {
      server.stop(true)
    }
  })

  test('scan=warn against an erasing store is allowed', async () => {
    // The other control: same client, same mode, only the store's answer
    // differs, so the refusal above cannot be the scan mode alone.
    const { server, seen, url } = serve('erases')
    try {
      const c = new OpenRecallClient({
        url,
        passphrase: 'p',
        scanMode: 'warn',
        onScanWarning: () => {},
      })
      await c.push('user:me', { 'k.md': `token ${SECRET}` })
      expect(seen.some(s => s.startsWith('PUT'))).toBe(true)
    } finally {
      server.stop(true)
    }
  })
})
