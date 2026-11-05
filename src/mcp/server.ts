/**
 * `openrecall mcp` — a stdio MCP server that gives any MCP-capable agent (Claude
 * Code, Zero, OpenClaude, Codex, Cursor, opencode, Gemini CLI, SDK agents)
 * durable, end-to-end-encrypted memory.
 *
 * It is a thin wrapper over OpenRecallClient: the passphrase lives in THIS local
 * process, so encryption/decryption happen here and the store (local disk or a
 * remote openrecall server) only ever sees ciphertext. Tool logic is in
 * ./tools.ts; this file just binds it to the MCP protocol.
 *
 * Config: ~/.openrecall/config.json (written by `openrecall init`), overridable
 * by OPENRECALL_URL, OPENRECALL_API_KEY, OPENRECALL_PASSPHRASE,
 * OPENRECALL_NAMESPACE, OPENRECALL_SCAN. See src/cli/settings.ts.
 *
 * If OpenRecall isn't set up yet (no passphrase), the server still starts and
 * every tool returns the fix, so the agent can tell the user instead of the
 * client showing an opaque "MCP server failed". A configuration that WOULD
 * corrupt memory (a wrong passphrase, a rejected key) is different: ./startup.ts
 * checks it against the pinned namespace before a single tool is served, and
 * the process exits. Nothing here runs on import.
 *
 * IMPORTANT: stdout is the MCP protocol channel — never write logs there. All
 * diagnostics go to stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import pkg from '../../package.json' with { type: 'json' }
import { DEFAULT_NAMESPACE } from '../cli/settings.ts'
import { logTiming } from '../log.ts'
import { loadMemoryGuide, SHORT_INSTRUCTIONS } from './guide.ts'
import { makeProjects } from './projects.ts'
import { makeSession } from './session.ts'
import { preflight } from './startup.ts'
import { clearSetupError, getSetupError, recordSetupError, recordToolFailure } from './status.ts'
import { type MemoryTools, makeTools, type Timings, type ToolResult } from './tools.ts'

// The health of this server, for embedders and tests that would otherwise have
// to scrape stderr for it. Re-exported from here because this is the module a
// caller reads as "the MCP server"; the state itself lives in ./status.ts so it
// can be read without starting a transport.
export { getSetupError, hadToolError } from './status.ts'

/**
 * The `_meta` key every tool result carries its stage timings under. The MCP
 * result shape has `_meta` for exactly this kind of side channel: a host can
 * read it, a model never sees it, so observing a call costs no context.
 * Reverse-DNS prefixed as the spec asks, so it cannot collide with a host's.
 */
export const TIMINGS_META = 'com.twigpine.openrecall/timings'

/** Timings for a result that produced none: the setup refusal, a project tool. */
const totalOnly = (startedAt: number): Timings => ({
  fetch: 0,
  decrypt: 0,
  rank: 0,
  format: 0,
  total: Math.round((performance.now() - startedAt) * 100) / 100,
  entries: 0,
  bytes: 0,
})

/**
 * The human-readable form, appended to the text only when OPENRECALL_TIMINGS=1:
 * a reader of a transcript can see where a slow call went, at the price of a
 * line of context per call, which is why it is opt-in.
 */
export const timingsTrailer = (t: Timings) =>
  `[timings fetch=${t.fetch}ms decrypt=${t.decrypt}ms rank=${t.rank}ms format=${t.format}ms ` +
  `total=${t.total}ms entries=${t.entries} bytes=${t.bytes}]`

const toMcp = (r: ToolResult, trailer: boolean) => ({
  content: [
    {
      type: 'text' as const,
      text: trailer && r.timings ? `${r.text}\n\n${timingsTrailer(r.timings)}` : r.text,
    },
  ],
  ...(r.isError ? { isError: true } : {}),
  ...(r.timings ? { _meta: { [TIMINGS_META]: r.timings } } : {}),
})

/**
 * True for the response to a tool call that failed.
 *
 * A response carries no `method`; `isError` on the result is the flag the
 * protocol defines for a refused call, and the SDK sets it both for a tool that
 * answered with a failure and for one whose arguments it rejected. Nothing else
 * this server serves puts `isError` on a result.
 *
 * The known limit: `isError` is what identifies a tool result here, rather than
 * the request it answers. Correlating the two would mean keeping every
 * in-flight request id and wrapping `onmessage` as well — and `connect()` is
 * what installs `onmessage`, so the wrapper would have to be stitched on after
 * the fact — all for a boolean. A handler registered by hand on a server passed
 * to `serveOn()` that returned a non-tool result carrying `isError` would be
 * counted too; this module registers no such handler.
 */
function isToolFailure(message: JSONRPCMessage): boolean {
  if (!('result' in message) || message.result === undefined) return false
  return (message.result as { isError?: unknown }).isError === true
}

/**
 * Count failed tool calls on their way to the client.
 *
 * Counting in a tool callback is not enough: the SDK validates arguments before
 * a registered callback runs, so `memory_recall` with `limit: 0` is refused
 * inside the SDK and never reaches this file's code. The outgoing response is
 * the one place every refusal passes through, whether the SDK or the tool
 * produced it, and the SDK turns a thrown callback into one as well.
 *
 * Only the status is read. Arguments and message text are never kept: the
 * caller already receives them, and both can quote whatever the caller sent —
 * which on this server can look like a secret.
 *
 * A JSON-RPC `error` response is deliberately not counted. That is the protocol
 * failing rather than a tool answering, and labelling the two apart would mean
 * tracking request ids for a boolean.
 *
 * Decorates in place and returns the transport: `connect()` installs its
 * callbacks on the object it is given, so a wrapper would have to forward every
 * one of them to stay equivalent.
 */
function countToolFailures(transport: Transport): Transport {
  const send = transport.send.bind(transport)
  transport.send = async (message, options) => {
    if (isToolFailure(message)) recordToolFailure()
    return send(message, options)
  }
  return transport
}

/**
 * Serve `server` on `transport`, counting the failed tool calls it reports.
 *
 * Exported so a test can drive a real client/server pair over the SDK's
 * in-memory transport and read the count in the same process. The stdio suite
 * cannot: there the server is a child process, and its status dies with it.
 */
export async function serveOn(server: McpServer, transport: Transport): Promise<void> {
  await server.connect(countToolFailures(transport))
}

/** What `makeServer` binds. A null group is one the preflight left unbound. */
export type ServerBinding = {
  tools: MemoryTools | null
  projects: ReturnType<typeof makeProjects> | null
  defaultNamespace: string
  /**
   * Append the timings trailer to every tool text and write one timing line
   * per call on stderr (what OPENRECALL_TIMINGS=1 asks for). Opt-in: the
   * trailer spends context and the line spends log space. The `_meta` timings
   * are always there.
   */
  timings?: boolean
  /**
   * Called with the `McpServer` as soon as it exists, before any transport is
   * connected. `main()` uses it to let the session read the connected client's
   * `initialize` info (`server.server.getClientVersion()`) off a server that
   * is built after the tools are.
   */
  attach?: (server: McpServer) => void
}

/**
 * Bind the tools to a server.
 *
 * Split out of `main()` so a test can drive the real registrations over the
 * SDK's in-memory transport: the stdio suite runs the server in a child
 * process, where the status this module exposes cannot be read.
 */
export function makeServer(binding: ServerBinding): McpServer {
  const defaultNamespace = binding.defaultNamespace

  // Captured when this server is built, not read on each call. A second start in
  // the same process can clear or replace the shared diagnosis, and an earlier
  // unbound server that is still connected must keep answering with the one
  // that describes *it* rather than with the newer start's, or with none.
  const setupDiagnostic = getSetupError()

  // "Not configured" is the same answer for every tool group, so it is written
  // once. The text comes from ./status.ts, which is what the operator saw on
  // stderr, so the answer a caller reads and the log can never disagree.
  const unconfigured = (): ToolResult => ({
    text: setupDiagnostic ?? 'OpenRecall is not configured',
    isError: true,
  })
  const timingsOn = binding.timings === true
  // Every result leaves with timings: the tool's own when it measured, else
  // the wall time of the call (the setup refusal, a project tool).
  const finish = (name: string, startedAt: number, r: ToolResult) => {
    const timings = r.timings ?? totalOnly(startedAt)
    if (timingsOn) {
      logTiming({
        tool: name,
        fetchMs: timings.fetch,
        decryptMs: timings.decrypt,
        rankMs: timings.rank,
        formatMs: timings.format,
        totalMs: timings.total,
        entries: timings.entries,
        bytes: timings.bytes,
      })
    }
    return toMcp({ ...r, timings }, timingsOn)
  }
  const run = async (name: string, fn: (t: MemoryTools) => Promise<ToolResult>) =>
    finish(name, performance.now(), binding.tools ? await fn(binding.tools) : unconfigured())
  type Projects = NonNullable<ServerBinding['projects']>
  const runProjects = async (name: string, fn: (p: Projects) => Promise<ToolResult>) =>
    finish(name, performance.now(), binding.projects ? await fn(binding.projects) : unconfigured())

  const server = new McpServer(
    { name: 'openrecall', version: pkg.version },
    { instructions: SHORT_INSTRUCTIONS },
  )
  binding.attach?.(server)

  // Full memory-usage protocol, served from the same SKILL.md the Claude Code
  // skill uses — so provider-neutral MCP clients can fetch the discipline too.
  server.registerPrompt(
    'memory_guide',
    {
      title: 'How to use OpenRecall memory',
      description:
        'The memory-usage protocol: when to recall, what to save, and how to keep memory tidy. Read this once at the start of a session.',
    },
    () => ({
      messages: [{ role: 'user', content: { type: 'text', text: loadMemoryGuide() } }],
    }),
  )

  server.registerTool(
    'memory_save',
    {
      title: 'Save a memory',
      description:
        'Persist a durable fact to encrypted memory. Use for stable facts (user preferences, project decisions, conventions) — not transient chatter. Overwrites the entry at `key`, unless it changed since this session last read it: then the save is refused as stale, and you should read the key with memory_get, merge, and save again. The client stamps YAML frontmatter on every save (id, type, created, updated, agent, session); you may set `type` (user, feedback, project, reference), `description`, `tags`, `expires` and `locked`. User notes belong in the shared namespace and project/reference notes in the open project namespace; a save in the wrong place is refused with the right one.',
      inputSchema: {
        key: z
          .string()
          .describe('Entry path within the namespace, e.g. "preferences.md" or "project/api.md".'),
        content: z.string().describe('The memory content (markdown).'),
        namespace: z.string().optional().describe(`Namespace (default: ${defaultNamespace}).`),
        supersedes: z
          .string()
          .optional()
          .describe('Key of the older entry this one replaces; stamped into frontmatter.'),
        force: z
          .boolean()
          .optional()
          .describe('Override the namespace routing check, or edit a locked entry.'),
      },
    },
    async ({ key, content, namespace, supersedes, force }) =>
      run('memory_save', t => t.save(key, content, namespace, { supersedes, force })),
  )

  server.registerTool(
    'memory_recall',
    {
      title: 'Recall relevant memories',
      description:
        'Search stored memory with a natural-language query. Returns one bounded region per matching entry, ranked: the part of the entry that matches, capped in size, under the entry key, not the entry itself. Any hit marked as a region has more behind it, so call `memory_get` with that key when you need the full entry. If nothing matches you get the number of entries searched and what to do next. Call this before answering when prior context might help.',
      inputSchema: {
        query: z.string().describe('What you want to remember about.'),
        namespace: z.string().optional().describe(`Namespace (default: ${defaultNamespace}).`),
        namespaces: z
          .array(z.string())
          .min(1)
          .max(8)
          .optional()
          .describe(
            'Search these namespaces together, for example the shared and project namespaces from memory_project. Use instead of namespace. Other projects are only searched when explicitly included.',
          ),
        limit: z.number().int().min(1).max(20).optional().describe('Max results (default 5).'),
        include_inactive: z
          .boolean()
          .optional()
          .describe('Also rank superseded, deleted and expired entries (hidden by default).'),
      },
    },
    async ({ query, namespace, limit, namespaces, include_inactive }) =>
      run('memory_recall', t =>
        t.recall(query, namespace, limit, namespaces, { includeInactive: include_inactive }),
      ),
  )

  server.registerTool(
    'memory_project',
    {
      title: 'Open a project memory scope',
      description:
        'Register or reopen a project in the encrypted project directory. Returns stable project and shared namespaces for organizing subsequent tool calls; does not change defaults or move existing entries. Call this at the start of a project task.',
      inputSchema: {
        project: z
          .string()
          .min(1)
          .max(140)
          .describe(
            'Stable project ID, e.g. github.com/twigpine/openrecall. Use the same case-insensitive ID on every machine and agent, including the host and owner for repositories. Never supply a local path or credentials.',
          ),
      },
    },
    async ({ project }) => runProjects('memory_project', p => p.open(project)),
  )

  server.registerTool(
    'memory_projects',
    {
      title: 'List known projects',
      description:
        'List the encrypted project directory with project IDs and their namespaces. Reads directory metadata, not the memories of other projects. Use before registering a project under another name.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe('Page size (default 20).'),
        offset: z.number().int().min(0).optional().describe('Number of sorted projects to skip.'),
      },
    },
    async ({ limit, offset }) => runProjects('memory_projects', p => p.list(limit, offset)),
  )

  server.registerTool(
    'memory_search',
    {
      title: 'Search memories',
      description: 'Literal keyword/substring search over memory keys and content.',
      inputSchema: {
        query: z.string().describe('Substring to search for.'),
        namespace: z.string().optional().describe(`Namespace (default: ${defaultNamespace}).`),
      },
    },
    async ({ query, namespace }) => run('memory_search', t => t.search(query, namespace)),
  )

  server.registerTool(
    'memory_get',
    {
      title: 'Read one memory entry',
      description:
        'Return the full, untruncated body of a single memory entry by key. Use it when recall or search shows an entry you need in full. One key per call; use `memory_list` to find the keys that exist.',
      inputSchema: {
        key: z.string().describe('Entry key to read, e.g. "preferences.md" or "project/api.md".'),
        namespace: z.string().optional().describe(`Namespace (default: ${defaultNamespace}).`),
      },
    },
    async ({ key, namespace }) => run('memory_get', t => t.get(key, namespace)),
  )

  server.registerTool(
    'memory_list',
    {
      title: 'List memory entries',
      description:
        'List the entry keys stored in a namespace (no content downloaded). Bookkeeping entries under `sys.openrecall/` are hidden unless `include_system` is true.',
      inputSchema: {
        namespace: z.string().optional().describe(`Namespace (default: ${defaultNamespace}).`),
        include_system: z
          .boolean()
          .optional()
          .describe('Also list the bookkeeping entries under sys.openrecall/.'),
      },
    },
    async ({ namespace, include_system }) =>
      run('memory_list', t => t.list(namespace, { includeSystem: include_system })),
  )

  server.registerTool(
    'memory_delete',
    {
      title: 'Delete a memory',
      description:
        'Remove one entry from a namespace. A note whose frontmatter says `locked: true` is refused unless `force` is true.',
      inputSchema: {
        key: z.string().describe('Entry key to delete.'),
        namespace: z.string().optional().describe(`Namespace (default: ${defaultNamespace}).`),
        force: z.boolean().optional().describe('Delete a locked entry.'),
      },
    },
    async ({ key, namespace, force }) =>
      run('memory_delete', t => t.delete(key, namespace, { force })),
  )

  return server
}

/** What `main` speaks from and reads, so a test can supply both. */
export type StartupOptions = {
  /** Left out by the CLI, which gets stdio. */
  transport?: Transport
  /** Left out by the CLI, which uses the launcher's environment. */
  env?: Record<string, string | undefined>
}

/**
 * Preflight, then bind the tools and connect the transport. Called by the CLI
 * rather than run on import, so a misconfigured process exits before the
 * transport exists and never half-serves.
 *
 * Both inputs are injectable for the same reason `preflight` takes an
 * environment: a test can drive the real startup path — including the status it
 * records — without spawning a process or reading the machine's own
 * configuration.
 */
export async function main(options: StartupOptions = {}): Promise<void> {
  const env = options.env ?? process.env
  const config = await preflight(env)
  let tools: MemoryTools | null = null
  let projects: ReturnType<typeof makeProjects> | null = null
  let defaultNamespace = DEFAULT_NAMESPACE
  let target = 'unconfigured'
  // The session reads the connected agent's name and version off the server,
  // which does not exist yet: `attach` below fills the holder once it does,
  // and the SDK has the client's `initialize` info before any tool call.
  const holder: { server?: McpServer } = {}
  const session = makeSession({ agent: () => holder.server?.server.getClientVersion(), env })
  if (config.ready) {
    // A second start in the same process must not keep reporting the first
    // start's diagnosis. Only the setup error: the tool-failure flag records
    // something a caller was already told, and a good start does not unsay it.
    clearSetupError()
    defaultNamespace = config.namespace
    target = config.url
    // Non-fatal findings from the preflight. Written before the tools are bound
    // so they are the first thing in the launcher's log, and to stderr because
    // stdout belongs to the protocol.
    for (const w of config.warnings) process.stderr.write(`openrecall mcp: ${w}\n`)
    tools = makeTools(config.client, defaultNamespace, session)
    projects = makeProjects(config.client, defaultNamespace, session)
  } else if (config.unconfigured) {
    const diagnosis =
      `OpenRecall is not set up: ${config.diagnostic}\n` +
      'Tell the user to run `npx -y @twigpine/openrecall init` (or, for a hosted service, `openrecall card <owner> <url>`), then restart this MCP server. Do not retry the memory tools until then.'
    // Recorded before it is logged, so a caller reading the status always sees
    // the same diagnosis the operator saw on stderr.
    recordSetupError(diagnosis)
    process.stderr.write(`[openrecall mcp] ${diagnosis}\n`)
  } else {
    process.stderr.write(`openrecall mcp: ${config.diagnostic}\n`)
    process.exit(1)
  }

  const server = makeServer({
    tools,
    projects,
    defaultNamespace,
    timings: env.OPENRECALL_TIMINGS === '1',
    attach: s => {
      holder.server = s
    },
  })
  await serveOn(server, options.transport ?? new StdioServerTransport())
  process.stderr.write(`[openrecall mcp] ready • store=${target} • namespace=${defaultNamespace}\n`)
}
