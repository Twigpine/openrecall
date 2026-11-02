#!/usr/bin/env bun
/**
 * openrecall CLI — sync a local memory directory to an openrecall server,
 * end-to-end encrypted. Mirrors the openclaude memdir layout (flat .md files +
 * MEMORY.md).
 *
 * Usage:
 *   openrecall push <dir> <namespace>     encrypt + upload changed entries
 *   openrecall pull <dir> <namespace>     download + decrypt into <dir>
 *   openrecall serve                      run the server (same as `bun run src/index.ts`)
 *
 * Env (client commands):
 *   OPENRECALL_URL         default http://localhost:8080
 *   OPENRECALL_API_KEY     bearer token (omit for ALLOW_UNAUTHENTICATED self-host)
 *   OPENRECALL_PASSPHRASE  REQUIRED — your zero-knowledge encryption passphrase
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { OpenRecallClient } from '../client/index.ts'
import type { ScanMode } from '../client/secretscan.ts'

async function walkMd(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(dir, { recursive: true }).catch(() => [] as string[])
  for (const rel of entries) {
    if (rel.endsWith('.md') && rel.split(sep).length <= 3) out.push(rel)
  }
  return out
}

function makeClient(): OpenRecallClient {
  const passphrase = process.env.OPENRECALL_PASSPHRASE
  if (!passphrase) {
    console.error('error: OPENRECALL_PASSPHRASE is required (your zero-knowledge key).')
    process.exit(1)
  }
  const scanMode = (process.env.OPENRECALL_SCAN ?? 'block') as ScanMode
  return new OpenRecallClient({
    url: process.env.OPENRECALL_URL ?? 'http://localhost:8080',
    apiKey: process.env.OPENRECALL_API_KEY,
    passphrase,
    scanMode,
  })
}

async function cmdPush(dir: string, namespace: string) {
  const client = makeClient()
  const files = await walkMd(dir)
  const entries: Record<string, string> = {}
  for (const rel of files) {
    entries[rel.split(sep).join('/')] = await readFile(join(dir, rel), 'utf8')
  }
  const r = await client.push(namespace, entries)
  console.log(
    `pushed ${namespace}: ${r.uploaded.length} uploaded, ${r.unchanged.length} unchanged → v${r.version}`,
  )
}

async function cmdPull(dir: string, namespace: string) {
  const client = makeClient()
  const r = await client.pull(namespace)
  let n = 0
  for (const [key, plaintext] of Object.entries(r.entries)) {
    const dest = join(dir, ...key.split('/'))
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, plaintext)
    n++
  }
  console.log(`pulled ${namespace} v${r.version}: ${n} files → ${dir}`)
}

const [cmd, a, b] = process.argv.slice(2)
try {
  switch (cmd) {
    case 'push':
      if (!a || !b) usage()
      await cmdPush(a, b)
      break
    case 'pull':
      if (!a || !b) usage()
      await cmdPull(a, b)
      break
    case 'mcp':
      // Stdio MCP server. Imported lazily so push/pull/serve don't pay for it.
      await import('../src/mcp/server.ts')
      break
    case 'serve':
      await import('../src/index.ts')
      break
    default:
      usage()
  }
} catch (err) {
  // SecretFoundError and HTTP errors carry actionable messages; print them
  // plainly rather than dumping a stack trace.
  console.error(`error: ${(err as Error).message}`)
  process.exit(1)
}

function usage(): never {
  console.log(
    'usage:\n' +
      '  openrecall push <dir> <namespace>   encrypt + upload changed entries\n' +
      '  openrecall pull <dir> <namespace>   download + decrypt into <dir>\n' +
      '  openrecall mcp                      run the stdio MCP server (memory tools)\n' +
      '  openrecall serve                    run the openrecall server',
  )
  process.exit(1)
}
