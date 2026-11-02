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
 * If OpenRecall isn't set up yet, the server still starts and every tool
 * returns the fix — so the agent can tell the user, instead of the client
 * showing an opaque "MCP server failed".
 *
 * IMPORTANT: stdout is the MCP protocol channel — never write logs there. All
 * diagnostics go to stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import pkg from '../../package.json' with { type: 'json' }
import { describeTarget, makeClient } from '../cli/client.ts'
import { DEFAULT_NAMESPACE, resolveSettings } from '../cli/settings.ts'
import { loadMemoryGuide, SHORT_INSTRUCTIONS } from './guide.ts'
import { type MemoryTools, makeTools, type ToolResult } from './tools.ts'

let tools: MemoryTools | null = null
let setupError = ''
let defaultNamespace = DEFAULT_NAMESPACE
let target = 'unconfigured'
try {
  const settings = resolveSettings()
  defaultNamespace = settings.namespace
  target = describeTarget(settings)
  tools = makeTools(await makeClient(settings), defaultNamespace)
} catch (err) {
  setupError =
    `OpenRecall is not set up: ${(err as Error).message}\n` +
    'Tell the user to run `npx -y @twigpine/openrecall init`, then restart this MCP server.'
  process.stderr.write(`[openrecall mcp] ${setupError}\n`)
}

const toMcp = (r: ToolResult) => ({
  content: [{ type: 'text' as const, text: r.text }],
  ...(r.isError ? { isError: true } : {}),
})

const run = async (fn: (t: MemoryTools) => Promise<ToolResult>) =>
  toMcp(tools ? await fn(tools) : { text: setupError, isError: true })

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
      'Persist a durable fact to encrypted memory. Use for stable facts (user preferences, project decisions, conventions) — not transient chatter. Overwrites the entry at `key`.',
    inputSchema: {
      key: z
        .string()
        .describe('Entry path within the namespace, e.g. "preferences.md" or "project/api.md".'),
      content: z.string().describe('The memory content (markdown).'),
      namespace: z.string().optional().describe(`Namespace (default: ${defaultNamespace}).`),
    },
  },
  async ({ key, content, namespace }) => run(t => t.save(key, content, namespace)),
)

server.registerTool(
  'memory_recall',
  {
    title: 'Recall relevant memories',
    description:
      'Return the memories most relevant to a natural-language query, ranked. Call this before answering when prior context might help.',
    inputSchema: {
      query: z.string().describe('What you want to remember about.'),
      namespace: z.string().optional().describe(`Namespace (default: ${defaultNamespace}).`),
      limit: z.number().int().min(1).max(20).optional().describe('Max results (default 5).'),
    },
  },
  async ({ query, namespace, limit }) => run(t => t.recall(query, namespace, limit)),
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
  async ({ query, namespace }) => run(t => t.search(query, namespace)),
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
  async ({ namespace }) => run(t => t.list(namespace)),
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
  async ({ key, namespace }) => run(t => t.delete(key, namespace)),
)

const transport = new StdioServerTransport()
await server.connect(transport)
process.stderr.write(`[openrecall mcp] ready • store=${target} • namespace=${defaultNamespace}\n`)
