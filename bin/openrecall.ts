#!/usr/bin/env bun
/**
 * openrecall CLI — one end-to-end-encrypted memory for every agent.
 *
 * Usage:
 *   openrecall init [--url <local|https://…>] [--namespace <ns>] [--api-key <key>]
 *   openrecall setup [agent…|all] [--write] [--npx]
 *   openrecall status [--timings]       show config, check the store, measure recall per stage
 *   openrecall doctor [namespace]       audit memory organization; proposes fixes, changes nothing
 *   openrecall card <owner> [url]         print the service paste-in card + a new passphrase
 *   openrecall push <dir> [namespace]   encrypt + upload changed .md entries
 *   openrecall pull <dir> [namespace]   download + decrypt into <dir>
 *   openrecall mcp                      run the stdio MCP server (memory tools)
 *   openrecall serve                    run the openrecall server (needs Bun)
 *
 * Client settings come from ~/.openrecall/config.json (see `init`), overridden
 * by OPENRECALL_URL / _API_KEY / _PASSPHRASE / _NAMESPACE / _SCAN / _HOME.
 *
 * The published package runs this file as a Node bundle (dist/openrecall.js),
 * so `serve` hands off to Bun; everything else stays Node-compatible.
 */

import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { flattenServerText } from '../client/index.ts'
import { generateRetypablePassphrase, renderSetupCard } from '../client/setup.ts'
import { describeTarget, makeClient } from '../src/cli/client.ts'
import {
  configTooOpen,
  envOverrides,
  generatePassphrase,
  LOCAL_URL,
  readConfigFile,
  resolveSettings,
  validateScan,
  validateUrl,
  writeConfigFile,
} from '../src/cli/settings.ts'
import type { Timings } from '../src/mcp/tools.ts'
import { validateNamespace } from '../src/namespace.ts'
import { version } from '../src/version.ts'

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
  //
  // When OPENRECALL_PASSPHRASE_FILE is set the file is the passphrase, and it
  // wins over anything stored. Writing a second, generated one here would leave
  // config.json holding a key the file contradicts, so none is stored.
  const fromFile = Boolean(process.env.OPENRECALL_PASSPHRASE_FILE?.trim())
  let created = false
  if (!cfg.passphrase && !fromFile) {
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
    fromFile
      ? '  passphrase supplied by OPENRECALL_PASSPHRASE_FILE (none stored here)'
      : created
        ? '  passphrase generated — BACK UP this file. The passphrase is the only key to\n' +
          '             your memory; the host cannot recover it.'
        : '  passphrase kept (existing)',
  )
  console.log('\nnext: openrecall setup        # connect your agents')
}

async function cmdStatus(timings: boolean) {
  const s = resolveSettings()
  console.log(
    `config     ${s.configPath}${configTooOpen(s.configPath) ? '  ⚠ readable by others — chmod 600' : ''}`,
  )
  console.log(`store      ${describeTarget(s)}`)
  console.log(`namespace  ${s.namespace}`)
  // Remote mode only: local mode has no mirror, its data dir already is one.
  if (s.url !== LOCAL_URL && s.cache) {
    const { describeMirror } = await import('../src/cli/mirror.ts')
    const m = await describeMirror(s.home, s.namespace)
    if (m)
      console.log(
        `cache      ${m.path} (${m.entries} ${m.entries === 1 ? 'entry' : 'entries'}, ${Math.round(m.bytes / 1024)} KB of ciphertext)`,
      )
  }
  // Secrets are reported as present/absent only — never their values.
  console.log(`passphrase ${s.passphrase ? 'set' : 'MISSING'}`)
  console.log(`api key    ${s.apiKey ? 'set' : 'none'}`)
  console.log(`scan       ${s.scan}`)
  if (!s.cache) console.log('cache      off')
  const overrides = envOverrides()
  if (overrides.length)
    console.log(`env        ${overrides.join(', ')} (overriding the config file)`)
  const client = await makeClient(s)
  const hashes = await client.hashes(s.namespace)
  const n = Object.keys(hashes).length
  console.log(`\nok — ${n} ${n === 1 ? 'entry' : 'entries'} in ${s.namespace}`)
  if (timings) await printTimings(client, s.namespace, n)
}

/**
 * The warm-recall latency targets, in milliseconds, at the namespace entry
 * cap; see docs/performance.md. Below the cap the measurement is informational
 * because a small namespace cannot fail a target set for a full one.
 */
const SLO = { entries: 2000, p50Ms: 50, p95Ms: 200 }

/**
 * `status --timings`: run recall once cold and eleven times warm against the
 * pinned namespace and print where the time goes per stage. The recall text is
 * never printed: it is memory content, and this is a diagnostic. The probe is
 * generic on purpose, so the numbers describe the namespace and not one lucky
 * query.
 */
async function printTimings(client: Awaited<ReturnType<typeof makeClient>>, ns: string, n: number) {
  const { makeTools } = await import('../src/mcp/tools.ts')
  const tools = makeTools(client, ns)
  const probe = 'project conventions and user preferences'
  const sample = async () => {
    const r = await tools.recall(probe)
    if (!r.timings) throw new Error('recall returned no timings')
    return r.timings
  }
  const cold = await sample()
  const warm: Timings[] = []
  for (let i = 0; i < 11; i++) warm.push(await sample())
  const stages = ['fetch', 'decrypt', 'rank', 'format', 'total'] as const
  const sorted = (stage: (typeof stages)[number]) => warm.map(t => t[stage]).sort((a, b) => a - b)
  const median = (xs: number[]) => xs[Math.floor(xs.length / 2)] as number
  // With eleven samples the 95th percentile is the second largest.
  const p95 = (xs: number[]) => xs[Math.floor(0.95 * (xs.length - 1))] as number
  const fmt = (ms: number) => `${ms.toFixed(1).padStart(8)} ms`
  // The bytes are the cold call's: warm calls fetch only what changed.
  console.log(
    `\nrecall timings over ${cold.entries} entries, ${cold.bytes} bytes fetched by the cold call`,
  )
  console.log(
    `${'stage'.padEnd(8)}${'cold'.padStart(11)}${'warm p50'.padStart(11)}${'warm p95'.padStart(11)}`,
  )
  for (const stage of stages) {
    const xs = sorted(stage)
    console.log(`${stage.padEnd(8)}${fmt(cold[stage])}${fmt(median(xs))}${fmt(p95(xs))}`)
  }
  const totals = sorted('total')
  const p50 = median(totals)
  const p95Total = p95(totals)
  if (n >= SLO.entries) {
    const pass = p50 <= SLO.p50Ms && p95Total <= SLO.p95Ms
    console.log(
      `SLO ${pass ? 'PASS' : 'FAIL'}: warm p50 ${p50.toFixed(1)} ms (target ≤ ${SLO.p50Ms}), p95 ${p95Total.toFixed(1)} ms (target ≤ ${SLO.p95Ms})`,
    )
  } else {
    console.log(
      `SLO informational (${n} entries; targets are defined at ${SLO.entries}: warm p50 ≤ ${SLO.p50Ms} ms, p95 ≤ ${SLO.p95Ms} ms)`,
    )
  }
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
  const skipped = r.skipped ?? []
  const summary = [`${r.uploaded.length} uploaded`, `${r.unchanged.length} unchanged`]
  if (skipped.length) summary.push(`${skipped.length} rejected`)
  console.log(`pushed ${ns}: ${summary.join(', ')} → v${r.version}`)
  if (skipped.length) {
    // The store answers 200 even when it drops entries, so a push that looks
    // successful can have stored nothing. Name every dropped key and fail.
    console.error(
      `  ✗ ${skipped.length} entr${skipped.length === 1 ? 'y' : 'ies'} rejected by the store:`,
    )
    for (const x of skipped)
      console.error(`      ${flattenServerText(x.key, 300)} (${flattenServerText(x.reason, 80)})`)
    console.error('  nothing was saved for those keys — rename or resize them and push again')
    process.exitCode = 1
  }
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

/**
 * Print the paste-in block plus a freshly generated passphrase. The passphrase
 * is produced here, on this machine, and shown once: nothing sends it anywhere
 * and nothing can recover it, so the warning is the feature. The service key
 * is never printed, even when OPENRECALL_API_KEY is set: the block carries a
 * placeholder so the key stays out of scrollback, logs and agent transcripts.
 */
function cmdCard(owner: string, url: string | undefined) {
  const card = renderSetupCard('openclaude', {
    owner,
    url: url ?? process.env.OPENRECALL_URL ?? 'https://memory.twigpine.com',
    apiKey: '<paste your service key here>',
  })
  console.log(card)
  console.log(
    `Your new passphrase (shown once, back it up now):\n\n  ${generateRetypablePassphrase()}\n`,
  )
}

async function cmdServe() {
  if (typeof Bun !== 'undefined') {
    await import('../src/index.ts')
    return
  }

  // Run this installed version, offline, with the same cwd and environment.
  // --bun overrides the bundle's Node shebang and prevents a relaunch loop.
  process.exitCode = await new Promise<number>((done, reject) => {
    const child = spawn(
      'bun',
      ['run', '--bun', resolve(process.argv[1]), ...process.argv.slice(2)],
      {
        stdio: 'inherit',
      },
    )
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
    const handlers = signals.map(signal => {
      const forward = () => child.kill(signal)
      process.on(signal, forward)
      return { signal, forward }
    })
    const cleanup = () => {
      for (const { signal, forward } of handlers) process.off(signal, forward)
    }
    child.once('error', err => {
      cleanup()
      reject(
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error(
              'the server needs Bun (https://bun.sh). Install Bun and ensure `bun` is on PATH, ' +
                'then retry `openrecall serve`. Local memory needs no server: ' +
                '`openrecall init` then `openrecall setup all --write`.',
            )
          : err,
      )
    })
    child.once('exit', (code, signal) => {
      cleanup()
      if (signal) process.kill(process.pid, signal)
      done(code ?? 1)
    })
  })
}

const [cmd, ...rest] = process.argv.slice(2)
const args = parseArgs(rest)
const [a, b] = args.positional
try {
  switch (cmd) {
    // Consumers pin a minimum: an older binary that cannot read
    // OPENRECALL_PASSPHRASE_FILE fails with "no passphrase", which reads as the
    // operator's mistake rather than a stale install, so they need a way to
    // check. Read from the manifest so a release bump carries it.
    case '--version':
    case '-v':
      console.log(version())
      break
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
      await cmdStatus(args.flags.timings === true)
      break
    case 'doctor': {
      const { cmdDoctor } = await import('../src/cli/doctor.ts')
      if ((await cmdDoctor(a)) !== 0) process.exit(1)
      break
    }
    case 'push':
      if (!a) usage()
      await cmdPush(a, b)
      break
    case 'pull':
      if (!a) usage()
      await cmdPull(a, b)
      break
    case 'card':
      if (!a) usage()
      cmdCard(a, b)
      break
    case 'mcp':
      // Stdio MCP server. Imported lazily so push/pull/serve don't pay for it,
      // and CALLED rather than imported for effect: startup lives in a function
      // so it can preflight, and an import alone would exit zero having served
      // nothing.
      await (await import('../src/mcp/server.ts')).main()
      break
    case 'serve':
      await cmdServe()
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
      '  openrecall status [--timings]        show config and check the store; --timings measures recall per stage\n' +
      '  openrecall doctor [namespace]        audit memory organization and print proposed fixes (changes nothing)\n' +
      '  openrecall card <owner> [url]        print the service paste-in card + a new passphrase\n' +
      '  openrecall push <dir> [namespace]    encrypt + upload changed .md entries\n' +
      '  openrecall pull <dir> [namespace]    download + decrypt into <dir>\n' +
      '  openrecall mcp                       run the stdio MCP server (memory tools)\n' +
      '  openrecall serve                     run the openrecall server (needs Bun)',
  )
  process.exit(code)
}
