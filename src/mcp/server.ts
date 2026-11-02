/**
 * `openrecall mcp` — a stdio MCP server that gives any MCP-capable agent (Claude
 * Code, Cursor, opencode, SDK agents) durable, end-to-end-encrypted memory.
 *
 * It is a thin wrapper over OpenRecallClient: the passphrase lives in THIS local
 * process, so encryption/decryption happen here and the remote openrecall server
 * still only ever sees ciphertext. Tool logic is in ./tools.ts; this file just
 * binds it to the MCP protocol.
 *
 * Config (env): OPENRECALL_URL, OPENRECALL_API_KEY, OPENRECALL_PASSPHRASE (required),
 * OPENRECALL_NAMESPACE (default namespace), OPENRECALL_SCAN (block|warn|off).
 *
 * IMPORTANT: stdout is the MCP protocol channel — never write logs there. All
 * diagnostics go to stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { OpenRecallClient } from '../../client/index.ts'
import type { ScanMode } from '../../client/secretscan.ts'
import { loadMemoryGuide, SHORT_INSTRUCTIONS } from './guide.ts'
import { makeTools, type ToolResult } from './tools.ts'

function env(name: string): string | undefined {
  const v = process.env[name]
  return v?.trim() ? v.trim() : undefined
}

function die(message: string): never {
  process.stderr.write(`openrecall mcp: ${message}\n`)
  process.exit(1)
}

const passphrase = env('OPENRECALL_PASSPHRASE')
if (!passphrase) {
  die(
    'OPENRECALL_PASSPHRASE is required — it is your zero-knowledge key and is never sent to the server.',
  )
}

const url = env('OPENRECALL_URL') ?? 'http://localhost:8080'
const defaultNamespace = env('OPENRECALL_NAMESPACE') ?? 'user:me'
const client = new OpenRecallClient({
  url,
  apiKey: env('OPENRECALL_API_KEY'),
  passphrase,
  scanMode: (env('OPENRECALL_SCAN') ?? 'block') as ScanMode,
})
const tools = makeTools(client, defaultNamespace)

const toMcp = (r: ToolResult) => ({
  content: [{ type: 'text' as const, text: r.text }],
  ...(r.isError ? { isError: true } : {}),
})

const server = new McpServer(
  { name: 'openrecall', version: '0.1.0' },
  { instructions: SHORT_INSTRUCTIONS },
)

// Full memory-usage protocol, served from the same SKILL.md the Claude Code
// skill uses — so provider-neutral MCP clients can fetch the discipline too.
server.registerPrompt(
  'memory_guide',
  {
    title: 'How to use openrecall memory',
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
  async ({ key, content, namespace }) => toMcp(await tools.save(key, content, namespace)),
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
  async ({ query, namespace, limit }) => toMcp(await tools.recall(query, namespace, limit)),
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
  async ({ query, namespace }) => toMcp(await tools.search(query, namespace)),
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
  async ({ namespace }) => toMcp(await tools.list(namespace)),
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
  async ({ key, namespace }) => toMcp(await tools.delete(key, namespace)),
)

const transport = new StdioServerTransport()
await server.connect(transport)
process.stderr.write(`[openrecall mcp] ready • url=${url} • namespace=${defaultNamespace}\n`)
