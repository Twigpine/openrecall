/**
 * End to end over a real socket, with the gitlawb node as the store.
 *
 * `e2e-service.test.ts` drives the same surfaces over the filesystem store.
 * This exists because the node driver is the one store whose failure modes are
 * not local: it shells out, it can refuse a write for a reason no other driver
 * has (the repo is public), and it retains what a delete removes. None of that
 * is visible to a layer-local test, and the plan's verification for the driver
 * is that the MCP startup probe succeeds *through* it, which only a running
 * process can show.
 *
 * Opt-in, same switches as tests/store-node.test.ts. A run without them skips,
 * and says so, because a node suite that quietly did nothing looks exactly like
 * one that passed.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { namespaceSlug } from '../src/namespace.ts'
import { resetStore, setStore } from '../src/store/index.ts'
import { NodeBlobStore } from '../src/store/node.ts'
import { createNodeNaming } from '../src/store/node-naming.ts'

const NODE_URL = process.env.OPENRECALL_NODE_TEST_URL?.trim()
const IDENTITY = process.env.OPENRECALL_NODE_TEST_IDENTITY?.trim()
const live = Boolean(NODE_URL && IDENTITY)
if (!live) {
  console.warn(
    '\n!! tests/e2e-node.test.ts: the node-backed e2e did NOT run.\n' +
      '!! Set OPENRECALL_NODE_TEST_URL and OPENRECALL_NODE_TEST_IDENTITY to run it.\n',
  )
}
if (process.env.OPENRECALL_NODE_TEST_BIN) {
  process.env.PATH = `${process.env.OPENRECALL_NODE_TEST_BIN}:${process.env.PATH ?? ''}`
}

/** Distinct from the driver suite's secret, so this file owns its own repos and
 *  cannot pass on state another file happened to leave behind. */
const SECRET = 'openrecall-u19-e2e'
const PASSPHRASE = 'correct horse battery staple'
/** A phrase that exists nowhere but this test, so finding it in a clone is
 *  proof of a plaintext leak rather than a coincidence. */
const CANARY = 'zqx-plaintext-canary-9f3a1c'

const dirs: string[] = []
let server: ReturnType<typeof Bun.serve>
let base: string
let OWNER_DID = ''
let OpenRecallClient: typeof import('../client/index.ts').OpenRecallClient
let makeTools: typeof import('../src/mcp/tools.ts').makeTools
let preflight: typeof import('../src/mcp/startup.ts').preflight

function run(argv: string[]): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    const child = spawn(argv[0] as string, argv.slice(1), {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: tmpdir(),
        GITLAWB_NODE: NODE_URL as string,
        GITLAWB_KEY: IDENTITY as string,
        GIT_TERMINAL_PROMPT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', d => {
      out += d
    })
    child.stderr.on('data', d => {
      out += d
    })
    child.on('close', code => resolve({ code: code ?? -1, out }))
  })
}

beforeAll(async () => {
  const { handleRequest } = await import('../src/handler.ts')
  ;({ OpenRecallClient } = await import('../client/index.ts'))
  ;({ makeTools } = await import('../src/mcp/tools.ts'))
  ;({ preflight } = await import('../src/mcp/startup.ts'))
  if (live) {
    const who = await run(['gl', 'whoami', '--dir', join(IDENTITY as string, '..')])
    const did = /did:key:[1-9A-HJ-NP-Za-km-z]+/.exec(who.out)
    if (!did) throw new Error(`could not read the test identity's DID: ${who.out}`)
    OWNER_DID = did[0]
    const workdir = mkdtempSync(join(tmpdir(), 'openrecall-e2e-node-'))
    dirs.push(workdir)
    setStore(
      new NodeBlobStore(
        {
          secret: SECRET,
          identityPath: IDENTITY as string,
          url: NODE_URL as string,
          acknowledged: true,
        },
        { workdir },
      ),
    )
  }
  server = Bun.serve({ port: 0, fetch: handleRequest })
  base = `http://localhost:${server.port}`
})

afterAll(() => {
  server?.stop(true)
  resetStore()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const client = (passphrase = PASSPHRASE) => new OpenRecallClient({ url: base, passphrase })

describe.skipIf(!live)('e2e: the service on node storage', () => {
  const ns = 'user:e2enode'

  test('the MCP startup probe succeeds through the node driver', async () => {
    // U19's verification line. The preflight is what decides whether the MCP
    // server may serve a tool at all, and it reaches the store on every launch,
    // so a driver that only satisfies the BlobStore contract in isolation can
    // still leave the server refusing to start.
    const res = await preflight({
      OPENRECALL_URL: base,
      OPENRECALL_PASSPHRASE: PASSPHRASE,
      OPENRECALL_NAMESPACE: ns,
    })
    expect(res.ready).toBe(true)
  }, 300_000)

  test('a save through the tools is recalled through the tools', async () => {
    const tools = makeTools(client(), ns)
    const saved = await tools.save('pref.md', `remember ${CANARY}`)
    expect(saved.isError ?? false).toBe(false)

    // A second client, built from scratch, so the read cannot be served by
    // anything the writer kept in memory.
    const fresh = makeTools(client(), ns)
    const got = await fresh.recall('remember')
    expect(got.isError ?? false).toBe(false)
    expect(got.text).toContain(CANARY)
  }, 300_000)

  test('the node holds ciphertext only: no plaintext reaches the repo', async () => {
    // The invariant the whole project protects, checked where it can actually
    // fail rather than at the client boundary. A fresh clone, so this reads what
    // the node really serves and not a local working copy.
    const repo = createNodeNaming(SECRET).repoName(namespaceSlug(ns))
    const dir = mkdtempSync(join(tmpdir(), 'openrecall-e2e-verify-'))
    dirs.push(dir)
    const cloned = await run([
      'git',
      'clone',
      '--quiet',
      `gitlawb://${OWNER_DID}/${repo}`,
      join(dir, 'c'),
    ])
    expect(cloned.code).toBe(0)

    // grep -r exits 1 when it matches nothing, which is the answer we want, so
    // the count is what is asserted. `grep | head` would exit 0 either way and
    // report a leak that is not there (or miss one that is).
    const hits = await run(['sh', '-c', `grep -rlF '${CANARY}' ${join(dir, 'c')} | wc -l`])
    expect(hits.out.trim()).toBe('0')

    // Positive control: the same search does find the canary when it really is
    // present, so the zero above is an absence and not a broken search.
    await run(['sh', '-c', `printf '%s' '${CANARY}' > ${join(dir, 'c', 'planted.txt')}`])
    const again = await run(['sh', '-c', `grep -rlF '${CANARY}' ${join(dir, 'c')} | wc -l`])
    expect(again.out.trim()).toBe('1')
  }, 300_000)

  test('a delete reports the bytes are retained, because this store cannot erase', async () => {
    // R22. On fs and s3 a delete is an erasure; here git history keeps what the
    // delete removed from the tree. The agent is what tells the user their
    // memory is gone, so the difference has to reach the tool response.
    const tools = makeTools(client(), ns)
    await tools.save('gone.md', 'delete me')
    const del = await tools.delete('gone.md')
    expect(del.isError ?? false).toBe(false)
    expect(del.text).toMatch(/retain|history|not erased|remains/i)

    // And the entry really is gone from the namespace, so the retention notice
    // is not covering for a delete that did not happen.
    const after = await makeTools(client(), ns).list()
    expect(after.text).not.toContain('gone.md')
  }, 300_000)
})
