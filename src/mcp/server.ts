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
import { z } from 'zod'
import pkg from '../../package.json' with { type: 'json' }
import { DEFAULT_NAMESPACE } from '../cli/settings.ts'
import { logTiming } from '../log.ts'
import { loadMemoryGuide, SHORT_INSTRUCTIONS } from './guide.ts'
import { makeProjects } from './projects.ts'
import { preflight } from './startup.ts'
import { type MemoryTools, makeTools, type Timings, type ToolResult } from './tools.ts'

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
 * Preflight, then bind the tools and connect the transport. Called by the CLI
 * rather than run on import, so a misconfigured process exits before the
 * transport exists and never half-serves.
 */
export async function main(): Promise<void> {
  const config = await preflight(process.env)
  let tools: MemoryTools | null = null
  let projects: ReturnType<typeof makeProjects> | null = null
  let setupError = ''
  let defaultNamespace = DEFAULT_NAMESPACE
  let target = 'unconfigured'
  if (config.ready) {
    defaultNamespace = config.namespace
    target = config.url
    // Non-fatal findings from the preflight. Written before the tools are bound
    // so they are the first thing in the launcher's log, and to stderr because
    // stdout belongs to the protocol.
    for (const w of config.warnings) process.stderr.write(`openrecall mcp: ${w}\n`)
    tools = makeTools(config.client, defaultNamespace)
    projects = makeProjects(config.client, defaultNamespace)
  } else if (config.unconfigured) {
    setupError =
      `OpenRecall is not set up: ${config.diagnostic}\n` +
      'Tell the user to run `npx -y @twigpine/openrecall init` (or, for a hosted service, `openrecall card <owner> <url>`), then restart this MCP server. Do not retry the memory tools until then.'
    process.stderr.write(`[openrecall mcp] ${setupError}\n`)
  } else {
    process.stderr.write(`openrecall mcp: ${config.diagnostic}\n`)
    process.exit(1)
  }

  // Opt-in: the trailer spends context and the stderr line spends log space.
  // The `_meta` timings are always there.
  const timingsOn = process.env.OPENRECALL_TIMINGS === '1'
  const unconfigured = (): ToolResult => ({ text: setupError, isError: true })
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
    finish(name, performance.now(), tools ? await fn(tools) : unconfigured())
  type Projects = ReturnType<typeof makeProjects>
  const runProjects = async (name: string, fn: (p: Projects) => Promise<ToolResult>) =>
    finish(name, performance.now(), projects ? await fn(projects) : unconfigured())

  const server = new McpServer(
    { name: 'openrecall', version: pkg.version },
    { instructions: SHORT_INSTRUCTIONS },
  )

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
        'Persist a durable fact to encrypted memory. Use for stable facts (user preferences, project decisions, conventions) — not transient chatter. Overwrites the entry at `key`, unless it changed since this session last read it: then the save is refused as stale, and you should read the key with memory_get, merge, and save again.',
      inputSchema: {
        key: z
          .string()
          .describe('Entry path within the namespace, e.g. "preferences.md" or "project/api.md".'),
        content: z.string().describe('The memory content (markdown).'),
        namespace: z.string().optional().describe(`Namespace (default: ${defaultNamespace}).`),
      },
    },
    async ({ key, content, namespace }) => run('memory_save', t => t.save(key, content, namespace)),
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
      },
    },
    async ({ query, namespace, limit, namespaces }) =>
      run('memory_recall', t => t.recall(query, namespace, limit, namespaces)),
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
      description: 'List the entry keys stored in a namespace (no content downloaded).',
      inputSchema: {
        namespace: z.string().optional().describe(`Namespace (default: ${defaultNamespace}).`),
      },
    },
    async ({ namespace }) => run('memory_list', t => t.list(namespace)),
  )

  server.registerTool(
    'memory_delete',
    {
      title: 'Delete a memory',
      description: 'Remove one entry from a namespace.',
      inputSchema: {
        key: z.string().describe('Entry key to delete.'),
        namespace: z.string().optional().describe(`Namespace (default: ${defaultNamespace}).`),
      },
    },
    async ({ key, namespace }) => run('memory_delete', t => t.delete(key, namespace)),
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write(`[openrecall mcp] ready • store=${target} • namespace=${defaultNamespace}\n`)
}
