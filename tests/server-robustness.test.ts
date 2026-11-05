/**
 * `openrecall mcp` used to report its health only on stderr, so an embedder —
 * the CLI bundle, a launcher, a supervisor — had to scrape a log to learn that
 * no tool could work, and could not tell "never configured" apart from "the
 * last call failed". These tests pin the two answers, and the difference
 * between them, by driving the real registrations over the SDK's in-memory
 * transport: the stdio suite runs the server in a child process, so the status
 * it exposes cannot be read from there.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { handleRequest } from '../src/handler.ts'
import { getSetupError, hadToolError, main, makeServer, serveOn } from '../src/mcp/server.ts'
import {
  clearSetupError,
  recordSetupError,
  recordToolFailure,
  resetServerStatus,
} from '../src/mcp/status.ts'
import { type MemoryClient, makeTools } from '../src/mcp/tools.ts'

const open: Client[] = []
const homes: string[] = []
const stores: ReturnType<typeof Bun.serve>[] = []

/** A home with no config file, which is how an unconfigured server starts. */
function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'openrecall-status-'))
  homes.push(home)
  return home
}

async function connect(server: McpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await serveOn(server, serverSide)
  return attach(clientSide)
}

async function attach(clientSide: InMemoryTransport): Promise<Client> {
  const client = new Client({ name: 'status-test', version: '0.0.0' })
  await client.connect(clientSide)
  open.push(client)
  return client
}

// The status is module state and bun shares a module instance across the whole
// run, so every test starts from a known state instead of inheriting what the
// previous one — or an earlier suite — left behind.
beforeEach(() => resetServerStatus())
// A client left connected keeps its linked pair and callbacks alive, and a
// failed close must not be what leaves the status set for the next test.
afterEach(async () => {
  try {
    for (const client of open.splice(0)) await client.close()
  } finally {
    resetServerStatus()
  }
})
afterAll(() => {
  for (const store of stores.splice(0)) store.stop(true)
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** The least a client has to answer for the memory tools to run. */
const fakeClient = (overrides: Partial<MemoryClient> = {}): MemoryClient =>
  ({
    pull: async () => ({ version: 1, entries: {}, entryChecksums: {} }),
    push: async () => ({ version: 2 }),
    hashes: async () => ({}),
    delete: async () => {},
    ...overrides,
  }) as MemoryClient

const bound = (client: MemoryClient) =>
  makeServer({
    tools: makeTools(client, 'user:status'),
    projects: null,
    defaultNamespace: 'user:status',
  })

const textOf = (r: unknown) =>
  ((r as { content?: { type: string; text: string }[] }).content?.[0]?.text ?? '') as string

describe('MCP server status', () => {
  test('a clean start reports no setup error and no failed call', () => {
    expect(getSetupError()).toBeNull()
    expect(hadToolError()).toBe(false)
  })

  test('an unconfigured start hands back the diagnostic it logged to stderr', () => {
    const diagnosis =
      'OpenRecall is not set up: no passphrase configured\nTell the user to run `npx -y @twigpine/openrecall init`.'
    recordSetupError(diagnosis)

    expect(getSetupError()).toBe(diagnosis)
    // Not a tool error: the server never ran one. Collapsing the two would let
    // a caller blame a call that was never made.
    expect(hadToolError()).toBe(false)
  })

  test('the status can be reset so suites do not leak into each other', () => {
    recordSetupError('boom')

    resetServerStatus()

    expect(getSetupError()).toBeNull()
    expect(hadToolError()).toBe(false)
  })
})

describe('tool failures counted through the transport', () => {
  test('a successful call is not counted', async () => {
    const client = await connect(bound(fakeClient()))

    const res = await client.callTool({ name: 'memory_list', arguments: {} })

    expect((res as { isError?: boolean }).isError).toBeFalsy()
    expect(hadToolError()).toBe(false)
  })

  test('a tool that answers with a failure is counted', async () => {
    const failingStore = fakeClient({
      pull: async () => {
        throw new Error('store unreachable')
      },
    })
    const client = await connect(bound(failingStore))

    const res = await client.callTool({ name: 'memory_recall', arguments: { query: 'deploys' } })

    expect((res as { isError?: boolean }).isError).toBe(true)
    expect(textOf(res)).toContain('store unreachable')
    expect(hadToolError()).toBe(true)
  })

  test('a call the SDK rejects before the callback runs is counted', async () => {
    // `limit: 0` fails the tool's own schema, so the SDK answers and the
    // registered callback never runs. Counting inside the callback would miss
    // exactly the refusals a caller most often sees.
    const client = await connect(bound(fakeClient()))

    const res = await client.callTool({
      name: 'memory_recall',
      arguments: { query: 'deploys', limit: 0 },
    })

    expect((res as { isError?: boolean }).isError).toBe(true)
    expect(textOf(res)).toContain('Invalid arguments')
    expect(hadToolError()).toBe(true)
  })

  test('a callback that throws is counted', async () => {
    const server = new McpServer({ name: 'throwing', version: '0.0.0' })
    server.registerTool(
      'explode',
      { title: 'Explode', description: 'Always throws.', inputSchema: {} },
      async () => {
        throw new Error('kaboom')
      },
    )
    const client = await connect(server)

    const res = await client.callTool({ name: 'explode', arguments: {} })

    expect((res as { isError?: boolean }).isError).toBe(true)
    expect(hadToolError()).toBe(true)
  })

  test('an unbound server keeps its own diagnosis when another start replaces it', async () => {
    // Two servers in one process, which `main()` now allows. The shared
    // diagnostic moves on, but a server that is still connected has to answer
    // with the diagnosis that describes it.
    recordSetupError('first start: no passphrase')
    const first = await connect(
      makeServer({ tools: null, projects: null, defaultNamespace: 'user:first' }),
    )

    recordSetupError('second start: no service key')
    const second = await connect(
      makeServer({ tools: null, projects: null, defaultNamespace: 'user:second' }),
    )

    const ask = async (client: Client) =>
      textOf(await client.callTool({ name: 'memory_list', arguments: {} }))

    expect(await ask(first)).toContain('first start: no passphrase')
    expect(await ask(second)).toContain('second start: no service key')

    // A configured start clears the shared diagnostic. The unbound servers keep
    // theirs: clearing the status is not the same as fixing them.
    clearSetupError()
    expect(await ask(first)).toContain('first start: no passphrase')
  })

  test('an unbound server with no recorded diagnosis falls back to the generic text', async () => {
    const client = await connect(
      makeServer({ tools: null, projects: null, defaultNamespace: 'user:bare' }),
    )

    const res = await client.callTool({ name: 'memory_list', arguments: {} })

    expect((res as { isError?: boolean }).isError).toBe(true)
    expect(textOf(res)).toBe('OpenRecall is not configured')
  })

  test('main() records the preflight diagnosis before it serves a tool', async () => {
    // The production path: main() → preflight(env) → recordSetupError() →
    // makeServer() → serveOn(). Driven through an injected env and transport
    // rather than a spawned process, so the recorded status can be read here.
    // If main() stopped recording the diagnosis, `getSetupError()` would be
    // null and this test would fail.
    const home = freshHome()
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()

    await main({ env: { OPENRECALL_HOME: home }, transport: serverSide })

    expect(getSetupError()).toContain('OpenRecall is not set up:')
    // The diagnosis names the config file it looked for, which is the proof
    // that preflight ran with the injected home and found nothing there.
    expect(getSetupError()).toContain(home)

    const client = await attach(clientSide)
    const res = await client.callTool({ name: 'memory_list', arguments: {} })

    expect((res as { isError?: boolean }).isError).toBe(true)
    expect(textOf(res)).toContain('OpenRecall is not set up:')
    expect(hadToolError()).toBe(true)
  })

  test('main() clears a stale diagnosis once it binds tools', async () => {
    // A second start in one process: the first left a diagnosis because the
    // configuration was missing, and the tools are bound the second time. The
    // stale diagnosis must not survive, or a working server reports itself
    // broken.
    recordSetupError('stale diagnosis from the previous start')
    recordToolFailure()

    const store = Bun.serve({ port: 0, fetch: handleRequest })
    stores.push(store)
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()

    await main({
      env: {
        OPENRECALL_HOME: freshHome(),
        OPENRECALL_URL: `http://localhost:${store.port}`,
        OPENRECALL_PASSPHRASE: 'status-test-passphrase',
        OPENRECALL_NAMESPACE: 'user:status-ready',
      },
      transport: serverSide,
    })

    expect(getSetupError()).toBeNull()
    // The failure flag is a different fact and survives: clearing the setup
    // error is not the same as forgetting what a caller was already told.
    expect(hadToolError()).toBe(true)

    // Control: the tools really are bound, so this is a working server rather
    // than one that merely stopped reporting the old diagnosis.
    const client = await attach(clientSide)
    const res = await client.callTool({ name: 'memory_list', arguments: {} })
    expect((res as { isError?: boolean }).isError).toBeFalsy()
  })
})
