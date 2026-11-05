/**
 * End to end for the service surfaces, over a real socket with real crypto.
 *
 * `e2e.test.ts` drives the storage round trip. This drives what a deployment
 * exposes: the card a user pastes, the preflight that decides whether the MCP
 * server may serve anything, and the tool text a model reads. Those three only
 * meet in a running process, and every defect this file pins was found by a
 * reviewer rather than by a layer-local test, because each one lives in the
 * disagreement between two layers that are individually correct.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { stripFrontmatter } from '../src/mcp/frontmatter.ts'
import { _reset } from '../src/ratelimit.ts'

const DATA_DIR = process.env.DATA_DIR as string
const PASSPHRASE = 'correct horse battery staple'

let server: ReturnType<typeof Bun.serve>
let base: string
let OpenRecallClient: typeof import('../client/index.ts').OpenRecallClient
let makeTools: typeof import('../src/mcp/tools.ts').makeTools
let preflight: typeof import('../src/mcp/startup.ts').preflight
let renderSetupCard: typeof import('../client/setup.ts').renderSetupCard
let authorizeNamespace: typeof import('../src/auth.ts').authorizeNamespace
let generateRetypablePassphrase: typeof import('../client/setup.ts').generateRetypablePassphrase
let namespaceSlug: typeof import('../src/namespace.ts').namespaceSlug

beforeAll(async () => {
  const { handleRequest } = await import('../src/handler.ts')
  ;({ OpenRecallClient } = await import('../client/index.ts'))
  ;({ makeTools } = await import('../src/mcp/tools.ts'))
  ;({ preflight } = await import('../src/mcp/startup.ts'))
  ;({ renderSetupCard, generateRetypablePassphrase } = await import('../client/setup.ts'))
  ;({ authorizeNamespace } = await import('../src/auth.ts'))
  ;({ namespaceSlug } = await import('../src/namespace.ts'))
  server = Bun.serve({ port: 0, fetch: handleRequest })
  base = `http://localhost:${server.port}`
})
afterAll(() => server?.stop(true))
afterEach(() => _reset())

const client = (passphrase = PASSPHRASE) => new OpenRecallClient({ url: base, passphrase })
const toolsFor = (ns: string, passphrase = PASSPHRASE) => makeTools(client(passphrase), ns)

/** The env a user would end up with after pasting the generated block. */
function envFromCard(card: string): Record<string, string> {
  const json = card.slice(card.indexOf('{'), card.lastIndexOf('}') + 1)
  const parsed = JSON.parse(json) as {
    mcpServers: { openrecall: { env: Record<string, string> } }
  }
  return parsed.mcpServers.openrecall.env
}

describe('e2e: the path a new user actually walks', () => {
  test('a pasted setup card configures a client that saves and recalls', async () => {
    // AE6's local half. The card is generated, its block is parsed exactly as a
    // user's agent would, and the resulting configuration drives a real save
    // and a real recall against a real server with no edits in between. A
    // string check on the card cannot prove this: every other reason a first
    // save is refused is invisible to one.
    const passphrase = generateRetypablePassphrase()
    const card = renderSetupCard('openclaude', {
      owner: 'e2euser',
      repo: 'openrecall',
      url: base.replace('http://', 'https://'),
      apiKey: 'mk_test_key',
    })
    const env = envFromCard(card)
    expect(env.OPENRECALL_NAMESPACE).toBe('user:e2euser')
    expect(env.OPENRECALL_SCAN).toBe('block')

    // The card must not carry the secret it just generated.
    expect(card).not.toContain(passphrase)

    const tools = makeTools(
      new OpenRecallClient({ url: base, passphrase, scanMode: 'block' }),
      env.OPENRECALL_NAMESPACE as string,
    )
    const saved = await tools.save('prefs.md', 'The user prefers terse answers.')
    expect(saved.isError).toBeUndefined()
    const recalled = await tools.recall('what answers does the user prefer')
    expect(recalled.isError).toBeUndefined()
    expect(recalled.text).toContain('terse')

    // The card also tells the user to run one namespace per codebase, and the
    // guide tells the model the same. That form has to work against a real
    // server too, and has to be the one the card actually prints, or a user
    // following the card and an agent following the guide split their memory.
    // Read the form out of the CARD rather than out of repoNamespace: asserting
    // the card contains what repoNamespace returns compares the function with
    // itself and passes however both move. That the card agrees with the guide
    // is pinned in tests/setup-card.test.ts, against the guide file.
    const perRepo = card.match(/user:e2euser\/[a-z0-9._-]+/)?.[0] as string
    expect(perRepo).toBe('user:e2euser/openrecall')
    expect(authorizeNamespace({ owner: 'e2euser' } as never, perRepo)).toBe(true)
    expect(authorizeNamespace({ owner: 'someone-else' } as never, perRepo)).toBe(false)

    const repoTools = makeTools(new OpenRecallClient({ url: base, passphrase }), perRepo)
    expect(
      (await repoTools.save('conventions.md', 'Two-space indent here.')).isError,
    ).toBeUndefined()
    // Literal search rather than ranked recall: what is being proved here is
    // that the per-repo namespace stores and returns, not how the ranker scores.
    expect((await repoTools.search('Two-space')).text).toContain('conventions.md')
  })

  test('the preflight refuses a wrong passphrase and leaves the memory readable', async () => {
    // The whole reason the preflight exists: a wrong passphrase used to list
    // keys and save, and that first save left a namespace written under two
    // keys where the CORRECT passphrase could never read it again.
    const ns = 'user:e2e-wrong-pass'
    await client().push(ns, { 'kept.md': 'written under the right key' })

    const r = await preflight({
      OPENRECALL_URL: base,
      OPENRECALL_PASSPHRASE: 'not the passphrase',
      OPENRECALL_NAMESPACE: ns,
    })
    expect(r.ready).toBe(false)
    expect(r.ready ? '' : r.diagnostic).toMatch(/cannot decrypt/i)

    // The assertion that matters: refusing is worth nothing if it corrupted
    // anything on the way.
    expect((await client().pull(ns)).entries['kept.md']).toBe('written under the right key')
  })

  test('a correct configuration starts, and reads one entry rather than the namespace', async () => {
    // The bounded proof, measured on the wire rather than in the client.
    const ns = 'user:e2e-bounded'
    await client().push(ns, { 'a.md': 'one', 'b.md': 'two', 'c.md': 'three' })

    const seen: string[] = []
    const proxy = Bun.serve({
      port: 0,
      fetch: req => {
        const u = new URL(req.url)
        seen.push(u.search)
        return fetch(`${base}${u.pathname}${u.search}`)
      },
    })
    try {
      const r = await preflight({
        OPENRECALL_URL: `http://localhost:${proxy.port}`,
        OPENRECALL_PASSPHRASE: PASSPHRASE,
        OPENRECALL_NAMESPACE: ns,
      })
      expect(r.ready).toBe(true)
      expect(seen.filter(q => q.includes('view=entry')).length).toBe(1)
      // Control: the full read never happened, which is the saving.
      expect(seen.filter(q => !q.includes('view='))).toEqual([])
    } finally {
      proxy.stop(true)
    }
  })

  test('a stale save is refused through the tools, and the competing write survives', async () => {
    // AE7 driven the way an agent meets it: two sessions on one namespace, and
    // the refusal read as tool text rather than as an HTTP status.
    const ns = 'user:e2e-ae7'
    const a = toolsFor(ns)
    const b = toolsFor(ns)

    await a.save('shared.md', 'first')
    await a.recall('shared')

    await b.recall('shared')
    await b.save('shared.md', 'from b')

    // The server refuses a's write as stale; a recalled the note before b's
    // write, so the tool has a base to merge on, and both sides replaced the
    // one line: a conflict, rendered as tool text with the hunk to resolve.
    const stale = await a.save('shared.md', 'from a')
    expect(stale.isError).toBe(true)
    expect(stale.text).toStartWith('needs_decision (conflict): "shared.md" changed under you')
    expect(stale.text).toContain(
      '<<<<<<< yours\nfrom a\n||||||| base\nfirst\n=======\nfrom b\n>>>>>>> current',
    )

    // b's write is intact, and a can recover by doing what the text says.
    expect(stripFrontmatter((await client().pull(ns)).entries['shared.md'] as string)).toBe(
      'from b',
    )
    await a.recall('shared')
    const retry = await a.save('shared.md', 'from a, rebased')
    expect(retry.isError).toBeUndefined()
    expect(stripFrontmatter((await client().pull(ns)).entries['shared.md'] as string)).toBe(
      'from a, rebased',
    )
  })

  test('an entry the server refuses is not reported to the model as saved', async () => {
    // The server accepts the request and refuses the entry inside it. Reading
    // the client's own sent list rather than the server's answer reported that
    // as a save, and the model went on believing its memory had landed.
    const ns = 'user:e2e-skipped'
    const big = 'x'.repeat(300_000)
    const r = await toolsFor(ns).save('huge.md', big)
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/refused by the server/i)

    // Control: nothing was stored, so the text is true.
    const listed = await toolsFor(ns).list()
    expect(listed.text).not.toContain('huge.md')
  })

  test('a namespace whose bodies are gone does not read to the model as empty', async () => {
    // Manifest and blobs disagreeing is the shape that has produced five
    // separate denial-rendered-as-success defects on this branch. A model told
    // its memory does not exist will save over it.
    const ns = 'user:e2e-drift'
    await client().push(ns, { 'gone.md': 'this body will be removed' })

    const blobs = join(DATA_DIR, 'ns', namespaceSlug(ns), 'blobs')
    expect(existsSync(blobs)).toBe(true)
    for (const f of readdirSync(blobs)) rmSync(join(blobs, f))

    const recalled = await toolsFor(ns).recall('anything')
    expect(recalled.isError).toBe(true)
    expect(recalled.text).not.toMatch(/no memory stored/i)
    expect(recalled.text).toMatch(/could not serve/i)

    // list reads the manifest, so it still names what is missing, and the
    // preflight refuses to start rather than calling the namespace healthy.
    expect((await toolsFor(ns).list()).text).toContain('gone.md')
    const r = await preflight({
      OPENRECALL_URL: base,
      OPENRECALL_PASSPHRASE: PASSPHRASE,
      OPENRECALL_NAMESPACE: ns,
    })
    expect(r.ready).toBe(false)
    expect(r.ready ? '' : r.diagnostic).toMatch(/served none of the/i)
  })

  test('the single-entry read round-trips ciphertext the client can decrypt', async () => {
    // The new bounded read is only useful if what it returns is byte-identical
    // to what the full read returns, so the client decrypts it with the code it
    // already has.
    const ns = 'user:e2e-entry'
    await client().push(ns, { 'one.md': 'first body', 'two.md': 'second body' })

    expect(await client().entry(ns, 'two.md')).toBe('second body')

    // Control: the wrong passphrase fails on this path the same way it fails on
    // the full read, so the bounded read is a real proof and not a bypass.
    const err = await client('wrong passphrase')
      .entry(ns, 'two.md')
      .catch(e => e)
    expect((err as Error).name).toBe('OpenRecallDecryptError')
  })

  test('nothing the client sends carries the passphrase, over the whole flow', async () => {
    // The invariant the entire design exists for, asserted against captured
    // traffic rather than by reading the code.
    const ns = 'user:e2e-nosecret'
    const sent: string[] = []
    const proxy = Bun.serve({
      port: 0,
      fetch: async req => {
        const body = req.method === 'GET' ? '' : await req.clone().text()
        sent.push(`${req.url} ${JSON.stringify([...req.headers])} ${body}`)
        return fetch(`${base}${new URL(req.url).pathname}${new URL(req.url).search}`, {
          method: req.method,
          headers: req.headers,
          body: req.method === 'GET' || req.method === 'DELETE' ? undefined : body,
        })
      },
    })
    try {
      const c = new OpenRecallClient({
        url: `http://localhost:${proxy.port}`,
        passphrase: PASSPHRASE,
      })
      await c.push(ns, { 'secret.md': 'the plaintext body' })
      await c.pull(ns)
      await c.entry(ns, 'secret.md')
      await c.delete(ns, 'secret.md')

      // Positive control first: the capture actually observed the traffic.
      expect(sent.length).toBeGreaterThan(3)
      expect(sent.join('\n')).toContain('view=entry')

      const all = sent.join('\n')
      expect(all).not.toContain(PASSPHRASE)
      expect(all).not.toContain('the plaintext body')
    } finally {
      proxy.stop(true)
    }
  })
})
