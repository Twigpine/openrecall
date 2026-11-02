#!/usr/bin/env bun
/**
 * openrecall CLI — one end-to-end-encrypted memory for every agent.
 *
 * Usage:
 *   openrecall init [--url <local|https://…>] [--namespace <ns>] [--api-key <key>]
 *   openrecall setup [agent…|all] [--write] [--npx]
 *   openrecall status
 *   openrecall push <dir> [namespace]   encrypt + upload changed .md entries
 *   openrecall pull <dir> [namespace]   download + decrypt into <dir>
 *   openrecall mcp                      run the stdio MCP server (memory tools)
 *   openrecall serve                    run the openrecall server (needs Bun)
 *
 * Client settings come from ~/.openrecall/config.json (see `init`), overridden
 * by OPENRECALL_URL / _API_KEY / _PASSPHRASE / _NAMESPACE / _SCAN / _HOME.
 *
 * The published package runs this file as a Node bundle (dist/openrecall.js),
 * so everything except `serve` must stay Node-compatible.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { describeTarget, makeClient } from '../src/cli/client.ts'
import {
  configTooOpen,
  generatePassphrase,
  LOCAL_URL,
  readConfigFile,
  resolveSettings,
  validateScan,
  validateUrl,
  writeConfigFile,
} from '../src/cli/settings.ts'
import { validateNamespace } from '../src/namespace.ts'

type Args = { positional: string[]; flags: Record<string, string | true> }

function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (!a.startsWith('--')) {
      positional.push(a)
      continue
    }
    const eq = a.indexOf('=')
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1)
    } else if (VALUE_FLAGS.has(a.slice(2)) && argv[i + 1] !== undefined) {
      flags[a.slice(2)] = argv[++i] as string
    } else {
      flags[a.slice(2)] = true
    }
  }
  return { positional, flags }
}

const VALUE_FLAGS = new Set(['url', 'namespace', 'api-key', 'scan'])

function flag(args: Args, name: string): string | undefined {
  const v = args.flags[name]
  if (v === true) throw new Error(`--${name} needs a value`)
  return v
}

async function walkMd(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(dir, { recursive: true }).catch(() => [] as string[])
  for (const rel of entries) {
    if (rel.endsWith('.md') && rel.split(sep).length <= 3) out.push(rel)
  }
  return out
}

async function cmdInit(args: Args) {
  const s = resolveSettings()
  const existing = readConfigFile(s.configPath)
  const cfg = { ...existing }

  const url = flag(args, 'url')
  if (url) cfg.url = validateUrl(url)
  const namespace = flag(args, 'namespace')
  if (namespace) cfg.namespace = validateNamespace(namespace)
  const scan = flag(args, 'scan')
  if (scan) cfg.scan = validateScan(scan)
  const apiKey = flag(args, 'api-key') ?? process.env.OPENRECALL_API_KEY?.trim()
  if (apiKey) cfg.apiKey = apiKey

  // Never replace an existing passphrase: a new one can't decrypt old memory.
  let created = false
  if (!cfg.passphrase) {
    cfg.passphrase = process.env.OPENRECALL_PASSPHRASE?.trim() || generatePassphrase()
    created = true
  }
  cfg.url ??= LOCAL_URL
  cfg.namespace ??= 'user:me'

  const path = writeConfigFile(s.home, cfg)
  const r = resolveSettings()
  console.log(`openrecall config → ${path} (owner-only, 0600)`)
  console.log(`  store      ${describeTarget(r)}`)
  console.log(`  namespace  ${r.namespace}`)
  console.log(`  api key    ${cfg.apiKey ? 'set' : 'none'}`)
  console.log(
    created
      ? '  passphrase generated — BACK UP this file. The passphrase is the only key to\n' +
          '             your memory; the host cannot recover it.'
      : '  passphrase kept (existing)',
  )
  console.log('\nnext: openrecall setup        # connect your agents')
}

async function cmdStatus() {
  const s = resolveSettings()
  console.log(
    `config     ${s.configPath}${configTooOpen(s.configPath) ? '  ⚠ readable by others — chmod 600' : ''}`,
  )
  console.log(`store      ${describeTarget(s)}  [${s.sources.url}]`)
  console.log(`namespace  ${s.namespace}  [${s.sources.namespace}]`)
  console.log(`passphrase ${s.passphrase ? 'set' : 'MISSING'}  [${s.sources.passphrase}]`)
  console.log(`api key    ${s.apiKey ? 'set' : 'none'}  [${s.sources.apiKey}]`)
  console.log(`scan       ${s.scan}`)
  const client = await makeClient(s)
  const hashes = await client.hashes(s.namespace)
  const n = Object.keys(hashes).length
  console.log(`\nok — ${n} ${n === 1 ? 'entry' : 'entries'} in ${s.namespace}`)
}

async function cmdPush(dir: string, namespace?: string) {
  const s = resolveSettings()
  const ns = namespace ?? s.namespace
  const client = await makeClient(s)
  const files = await walkMd(dir)
  const entries: Record<string, string> = {}
  for (const rel of files) {
    entries[rel.split(sep).join('/')] = await readFile(join(dir, rel), 'utf8')
  }
  const r = await client.push(ns, entries)
  console.log(
    `pushed ${ns}: ${r.uploaded.length} uploaded, ${r.unchanged.length} unchanged → v${r.version}`,
  )
}

async function cmdPull(dir: string, namespace?: string) {
  const s = resolveSettings()
  const ns = namespace ?? s.namespace
  const client = await makeClient(s)
  const r = await client.pull(ns)
  let n = 0
  for (const [key, plaintext] of Object.entries(r.entries)) {
    const dest = join(dir, ...key.split('/'))
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, plaintext)
    n++
  }
  console.log(`pulled ${ns} v${r.version}: ${n} files → ${dir}`)
}

const [cmd, ...rest] = process.argv.slice(2)
const args = parseArgs(rest)
const [a, b] = args.positional
try {
  switch (cmd) {
    case 'init':
      await cmdInit(args)
      break
    case 'setup': {
      const { runSetup } = await import('../src/cli/setup.ts')
      const ok = await runSetup(args.positional, {
        write: args.flags.write === true,
        npx: args.flags.npx === true,
      })
      if (!ok) process.exit(1)
      break
    }
    case 'status':
      await cmdStatus()
      break
    case 'push':
      if (!a) usage()
      await cmdPush(a, b)
      break
    case 'pull':
      if (!a) usage()
      await cmdPull(a, b)
      break
    case 'mcp':
      // Stdio MCP server. Imported lazily so the other commands don't pay for it.
      await import('../src/mcp/server.ts')
      break
    case 'serve':
      if (typeof Bun === 'undefined') {
        throw new Error(
          'the server needs Bun (https://bun.sh): `bunx --bun @twigpine/openrecall serve`',
        )
      }
      await import('../src/index.ts')
      break
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      usage(0)
      break
    default:
      usage()
  }
} catch (err) {
  // SecretFoundError, setup and HTTP errors carry actionable messages; print
  // them plainly rather than dumping a stack trace.
  console.error(`error: ${(err as Error).message}`)
  process.exit(1)
}

function usage(code = 1): never {
  console.log(
    'openrecall — one end-to-end-encrypted memory for every agent\n\n' +
      'usage:\n' +
      '  openrecall init [--url <local|https://…>] [--namespace <ns>] [--api-key <key>]\n' +
      '                                       create ~/.openrecall/config.json (keeps your passphrase)\n' +
      '  openrecall setup [agent…|all] [--write] [--npx]\n' +
      '                                       connect Claude Code, Zero, OpenClaude, Codex, Cursor, …\n' +
      '  openrecall status                    show config and check the store\n' +
      '  openrecall push <dir> [namespace]    encrypt + upload changed .md entries\n' +
      '  openrecall pull <dir> [namespace]    download + decrypt into <dir>\n' +
      '  openrecall mcp                       run the stdio MCP server (memory tools)\n' +
      '  openrecall serve                     run the openrecall server (needs Bun)',
  )
  process.exit(code)
}
