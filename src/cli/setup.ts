/**
 * `openrecall setup` — connect agents to the same OpenRecall memory.
 *
 * Every agent registers the identical, secret-free MCP command; the passphrase
 * and store live in ~/.openrecall/config.json. Where an agent loads skills, we
 * also install the memory skill, because some agents (Zero) don't pass MCP
 * server instructions to the model and rely on the skill for the discipline.
 *
 * Without --write this is a dry run that prints exactly what it would do.
 * With --write it uses each agent's own `mcp add` CLI when there is one
 * (removing a previous `openrecall` entry first, so reruns update it) and
 * otherwise merges into the agent's JSON config, keeping a `.openrecall-bak`
 * backup of any file it changes.
 */

import { spawnSync } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { SKILL_MARKDOWN, SKILL_NAME } from '../mcp/guide.ts'
import { nodeFloor, version } from '../version.ts'
import { describeTarget } from './client.ts'
import { LOCAL_URL, resolveSettings, type Settings } from './settings.ts'

export const SERVER_NAME = 'openrecall'
export const PACKAGE = '@twigpine/openrecall'

export type Launch = { command: string; args: string[] }
type Env = Record<string, string | undefined>
type Json = Record<string, unknown>

// ─── Launcher ────────────────────────────────────────────────────────────

/** A launch plus why it was chosen; `setup` prints the reason in its dry run. */
export type Launcher = { launch: Launch; reason: string; warnings: string[] }

export type LaunchOptions = {
  /** `auto` (default), `npx`, or an absolute path to an openrecall executable. */
  launcher?: string
  /** Alias for `launcher: 'npx'`. */
  npx?: boolean
  /** Where to look for a global install (PATH). Defaults to process.env. */
  env?: Env
  // The rest describe the running process and exist so tests can stand in for
  // a compiled binary, an npx cache or an old Node without being one.
  script?: string
  execPath?: string
  bun?: boolean
  nodeVersion?: string
}

/** Every agent start through npx pays this; said once, in `setup`, not per agent. */
export const PORTABLE_WARNING =
  'portable launcher: every agent start pays ~1 s of npx resolution and needs network the first time. ' +
  `Install once (npm i -g ${PACKAGE}) and rerun setup to pin an absolute path; ` +
  'rerun setup after upgrading, because this pin is version-specific.'

/** An npx/bunx download cache: a path that may be gone tomorrow. */
const inThrowawayCache = (p: string) => /[\\/](_npx|bunx-[^\\/]*)[\\/]/.test(p)

/** `bun build --compile` mounts its sources on a virtual filesystem. */
const inCompiledBundle = (p: string) =>
  p.startsWith('/$bunfs/') || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(p)

/**
 * The command agents should run. Pinning an absolute path is the goal: it
 * starts in ~50 ms, works offline, in GUI apps with a minimal PATH and in
 * sandboxes without network. In order:
 *
 *  1. `--launcher npx` or `/abs/path`: as asked.
 *  2. A compiled binary: itself. Its sources live on Bun's virtual filesystem,
 *     so `realpath` fails for it; before this it fell through to npx, the one
 *     artifact that should never need it.
 *  3. The running script, when it is not in an npx/bunx cache: the runtime
 *     that is running it plus the script (an install or a checkout).
 *  4. From a cache: a global `openrecall` on PATH, if there is one.
 *  5. Otherwise the portable `npx -y @twigpine/openrecall@<version> mcp`,
 *     pinned to this version so an agent never silently picks up another.
 */
export function launchCommand(opts: LaunchOptions = {}): Launcher {
  const env = opts.env ?? process.env
  const execPath = opts.execPath ?? process.execPath
  const bun = opts.bun ?? typeof Bun !== 'undefined'
  const pinned = (launch: Launch, reason: string): Launcher => ({
    launch,
    reason: `pinned: ${reason}`,
    warnings: launch.command === execPath && !bun ? nodeFloorWarnings(opts.nodeVersion) : [],
  })
  const npx: Launch = { command: 'npx', args: ['-y', `${PACKAGE}@${version()}`, 'mcp'] }

  const launcher = opts.launcher || (opts.npx ? 'npx' : 'auto')
  if (launcher === 'npx') return { launch: npx, reason: 'portable: requested', warnings: [] }
  if (launcher !== 'auto') {
    if (!isAbsolute(launcher)) {
      throw new Error(`--launcher must be auto, npx, or an absolute path (got "${launcher}")`)
    }
    if (!isExecutableFile(launcher)) {
      throw new Error(`--launcher: ${launcher} is not an executable file`)
    }
    return {
      launch: { command: launcher, args: ['mcp'] },
      reason: 'pinned: --launcher',
      warnings: [],
    }
  }

  const self: Launch = { command: execPath, args: ['mcp'] }
  const raw = opts.script ?? process.argv[1]
  if (raw && inCompiledBundle(raw)) return pinned(self, 'standalone binary')
  let script: string | undefined
  if (raw) {
    try {
      script = realpathSync(raw)
    } catch {
      // Only a compiled binary runs a script Bun cannot stat.
      if (bun) return pinned(self, 'standalone binary')
    }
  }
  if (script && !inThrowawayCache(script)) {
    return pinned({ command: execPath, args: [script, 'mcp'] }, 'installed script')
  }

  const installed = findOnPath('openrecall', env, p => !inThrowawayCache(p))
  if (installed) {
    return installed.endsWith('.js')
      ? pinned({ command: execPath, args: [installed, 'mcp'] }, 'global install')
      : pinned({ command: installed, args: ['mcp'] }, 'global install')
  }
  return { launch: npx, reason: 'portable: no install found on PATH', warnings: [] }
}

export const isPortable = (l: Launch) => l.command === 'npx'

function isExecutableFile(p: string): boolean {
  try {
    accessSync(p, constants.X_OK)
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Pinning the Node that ran `setup` pins its version too. Below the floor the
 * agent's first start would fail with a syntax error far from here, so say it
 * now. Only real Node: Bun reports an emulated, older `versions.node`.
 */
function nodeFloorWarnings(nodeVersion = process.versions.node): string[] {
  const floor = nodeFloor()
  if (!below(nodeVersion, floor)) return []
  return [`this pins Node ${nodeVersion}, below the floor ${floor}; upgrade Node, then rerun setup`]
}

function below(a: string, b: string): boolean {
  const num = (s: string | undefined) => Number.parseInt(s ?? '0', 10) || 0
  const x = a.split('.')
  const y = b.split('.')
  for (let i = 0; i < 3; i++) if (num(x[i]) !== num(y[i])) return num(x[i]) < num(y[i])
  return false
}

// ─── Actions ─────────────────────────────────────────────────────────────

type Action =
  | { kind: 'cli'; bin: string; remove: string[]; add: string[] }
  | { kind: 'json'; path: string; snippet: Json; apply: (doc: Json) => boolean; what: string }
  | { kind: 'skill'; dir: string }
  | { kind: 'manual'; text: string }
  | { kind: 'note'; text: string }

type Ctx = { env: Env; home: string; launch: Launch; settings: Settings }

export type Agent = {
  id: string
  name: string
  detect: (ctx: Ctx) => boolean
  plan: (ctx: Ctx) => Action[]
}

function obj(parent: Json, key: string): Json {
  const v = parent[key]
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Json
  const fresh: Json = {}
  parent[key] = fresh
  return fresh
}

/** Put `entry` at doc[container][openrecall]; false if already identical. */
function setServer(container: string, entry: Json): (doc: Json) => boolean {
  return doc => {
    const servers = obj(doc, container)
    if (JSON.stringify(servers[SERVER_NAME]) === JSON.stringify(entry)) return false
    servers[SERVER_NAME] = entry
    return true
  }
}

const stdioEntry = (l: Launch): Json => ({ command: l.command, args: l.args })

function jsonServer(path: string, container: string, entry: Json): Action {
  return {
    kind: 'json',
    path,
    snippet: { [container]: { [SERVER_NAME]: entry } },
    apply: setServer(container, entry),
    what: 'MCP server',
  }
}

function cliAdd(bin: string, remove: string[], addPrefix: string[], l: Launch): Action {
  return {
    kind: 'cli',
    bin,
    remove: [...remove, SERVER_NAME],
    add: [...addPrefix, SERVER_NAME, '--', l.command, ...l.args],
  }
}

/**
 * The first `bin` on env.PATH whose real path `accept`s, resolved through any
 * symlink (a global npm install is `bin/openrecall -> …/dist/openrecall.js`),
 * or null. The filter matters: npx puts its own cache's `.bin` first on PATH,
 * and pinning that would pin a directory that may be gone tomorrow.
 */
export function findOnPath(
  bin: string,
  env: Env,
  accept: (resolved: string) => boolean = () => true,
): string | null {
  const exts = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : ['']
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, bin + ext)
      if (!existsSync(candidate)) continue
      let resolved: string
      try {
        resolved = realpathSync(candidate)
      } catch {
        continue
      }
      if (accept(resolved)) return resolved
    }
  }
  return null
}

const onPath = (bin: string, env: Env) => findOnPath(bin, env) !== null

const xdgConfig = (ctx: Ctx) => ctx.env.XDG_CONFIG_HOME || join(ctx.home, '.config')
const sharedSkills = (ctx: Ctx) => join(ctx.home, '.agents', 'skills')

// ─── Agents ──────────────────────────────────────────────────────────────

export const AGENTS: Agent[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    detect: ctx =>
      onPath('claude', ctx.env) ||
      existsSync(ctx.env.CLAUDE_CONFIG_DIR || join(ctx.home, '.claude')),
    plan: ctx => [
      cliAdd(
        'claude',
        ['mcp', 'remove', '--scope', 'user'],
        ['mcp', 'add', '--scope', 'user'],
        ctx.launch,
      ),
      {
        kind: 'skill',
        dir: join(ctx.env.CLAUDE_CONFIG_DIR || join(ctx.home, '.claude'), 'skills'),
      },
    ],
  },
  {
    id: 'zero',
    name: 'Zero',
    detect: ctx => onPath('zero', ctx.env) || existsSync(join(xdgConfig(ctx), 'zero')),
    plan: ctx => {
      const config = join(xdgConfig(ctx), 'zero', 'config.json')
      const local = ctx.settings.url === LOCAL_URL
      const actions: Action[] = [
        cliAdd('zero', ['mcp', 'remove'], ['mcp', 'add'], ctx.launch),
        // Zero ignores MCP server instructions; the skill carries the guidance.
        { kind: 'skill', dir: sharedSkills(ctx) },
      ]
      if (local) {
        // Zero sandboxes MCP servers to workspace writes only; let OpenRecall
        // write its own store (and nothing else).
        const root = ctx.settings.home
        actions.push({
          kind: 'json',
          path: config,
          snippet: { sandbox: { additionalWriteRoots: [root] } },
          what: `sandbox write access to ${root}`,
          apply: doc => {
            const sandbox = obj(doc, 'sandbox')
            const roots = Array.isArray(sandbox.additionalWriteRoots)
              ? (sandbox.additionalWriteRoots as unknown[])
              : []
            if (roots.includes(root)) return false
            sandbox.additionalWriteRoots = [...roots, root]
            return true
          },
        })
      }
      if (!local || isPortable(ctx.launch)) {
        actions.push({
          kind: 'note',
          text:
            'Zero runs MCP servers in its sandbox with network denied, so `npx` downloads and remote sync are blocked. Install once (`npm i -g @twigpine/openrecall`) and rerun `openrecall setup zero --write` for local mode; for a remote store also set `"sandbox": {"network": "allow"}` in ' +
            config,
        })
      }
      actions.push({
        kind: 'note',
        text: 'Zero shows MCP tools in Ask mode (Auto mode hides tools that need approval).',
      })
      return actions
    },
  },
  {
    id: 'openclaude',
    name: 'OpenClaude',
    detect: ctx =>
      onPath('openclaude', ctx.env) ||
      existsSync(ctx.env.OPENCLAUDE_CONFIG_DIR || join(ctx.home, '.openclaude')),
    plan: ctx => [
      cliAdd(
        'openclaude',
        ['mcp', 'remove', '-s', 'user'],
        ['mcp', 'add', '-s', 'user'],
        ctx.launch,
      ),
      // OpenClaude reads ~/.agents/skills by default (shared with Zero).
      { kind: 'skill', dir: sharedSkills(ctx) },
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    detect: ctx =>
      onPath('codex', ctx.env) || existsSync(ctx.env.CODEX_HOME || join(ctx.home, '.codex')),
    plan: ctx => [
      cliAdd('codex', ['mcp', 'remove'], ['mcp', 'add'], ctx.launch),
      { kind: 'skill', dir: join(ctx.env.CODEX_HOME || join(ctx.home, '.codex'), 'skills') },
    ],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    detect: ctx => existsSync(join(ctx.home, '.cursor')),
    plan: ctx => [
      jsonServer(join(ctx.home, '.cursor', 'mcp.json'), 'mcpServers', stdioEntry(ctx.launch)),
    ],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    detect: ctx => existsSync(join(ctx.home, '.gemini')),
    plan: ctx => [
      jsonServer(join(ctx.home, '.gemini', 'settings.json'), 'mcpServers', stdioEntry(ctx.launch)),
    ],
  },
  {
    id: 'opencode',
    name: 'opencode',
    detect: ctx => onPath('opencode', ctx.env) || existsSync(join(xdgConfig(ctx), 'opencode')),
    plan: ctx => {
      const dir = join(xdgConfig(ctx), 'opencode')
      const entry = {
        type: 'local',
        command: [ctx.launch.command, ...ctx.launch.args],
        enabled: true,
      }
      if (existsSync(join(dir, 'opencode.jsonc'))) {
        return [
          {
            kind: 'manual',
            text: `add to ${join(dir, 'opencode.jsonc')}:\n${indent(JSON.stringify({ mcp: { [SERVER_NAME]: entry } }, null, 2))}`,
          },
        ]
      }
      return [jsonServer(join(dir, 'opencode.json'), 'mcp', entry)]
    },
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    detect: ctx => existsSync(join(ctx.home, '.codeium', 'windsurf')),
    plan: ctx => [
      jsonServer(
        join(ctx.home, '.codeium', 'windsurf', 'mcp_config.json'),
        'mcpServers',
        stdioEntry(ctx.launch),
      ),
    ],
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    detect: ctx => existsSync(dirname(claudeDesktopConfig(ctx))),
    plan: ctx => {
      const actions: Action[] = [
        jsonServer(claudeDesktopConfig(ctx), 'mcpServers', stdioEntry(ctx.launch)),
      ]
      if (isPortable(ctx.launch)) {
        actions.push({
          kind: 'note',
          text: 'Claude Desktop starts servers with a minimal PATH. If `npx` is not found, install globally (`npm i -g @twigpine/openrecall`) and rerun setup to pin absolute paths. Restart the app after changes.',
        })
      }
      return actions
    },
  },
  {
    id: 'vscode',
    name: 'VS Code',
    detect: ctx => onPath('code', ctx.env),
    plan: ctx => [
      {
        kind: 'manual',
        text: `add to .vscode/mcp.json in your workspace (or run "MCP: Add Server"):\n${indent(
          JSON.stringify(
            { servers: { [SERVER_NAME]: { type: 'stdio', ...stdioEntry(ctx.launch) } } },
            null,
            2,
          ),
        )}`,
      },
    ],
  },
]

function claudeDesktopConfig(ctx: Ctx): string {
  if (process.platform === 'darwin') {
    return join(ctx.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  if (process.platform === 'win32') {
    return join(
      ctx.env.APPDATA || join(ctx.home, 'AppData', 'Roaming'),
      'Claude',
      'claude_desktop_config.json',
    )
  }
  return join(xdgConfig(ctx), 'Claude', 'claude_desktop_config.json')
}

// ─── File helpers (exported for tests) ───────────────────────────────────

/** Merge into a plain-JSON file. Throws if the file exists but isn't plain JSON. */
export function mergeJsonFile(
  path: string,
  apply: (doc: Json) => boolean,
): 'created' | 'updated' | 'unchanged' {
  const exists = existsSync(path)
  let doc: Json = {}
  if (exists) {
    const raw = readFileSync(path, 'utf8')
    if (raw.trim()) {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not a JSON object')
      }
      doc = parsed as Json
    }
  }
  if (!apply(doc)) return 'unchanged'
  mkdirSync(dirname(path), { recursive: true })
  const mode = exists ? statSync(path).mode & 0o777 : undefined
  if (exists) copyFileSync(path, `${path}.openrecall-bak`)
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`)
  if (mode !== undefined) chmodSync(path, mode)
  return exists ? 'updated' : 'created'
}

export function installSkill(skillsDir: string): 'created' | 'updated' | 'unchanged' {
  const path = join(skillsDir, SKILL_NAME, 'SKILL.md')
  const exists = existsSync(path)
  if (exists && readFileSync(path, 'utf8') === SKILL_MARKDOWN) return 'unchanged'
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, SKILL_MARKDOWN)
  return exists ? 'updated' : 'created'
}

// ─── Runner ──────────────────────────────────────────────────────────────

function indent(text: string, pad = '      '): string {
  return text
    .split('\n')
    .map(l => pad + l)
    .join('\n')
}

function shellQuote(args: string[]): string {
  return args.map(a => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')
}

function tilde(p: string, home: string): string {
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p
}

function perform(a: Action, ctx: Ctx, write: boolean, out: (l: string) => void): boolean {
  const t = (p: string) => tilde(p, ctx.home)
  switch (a.kind) {
    case 'cli': {
      const cmd = `${a.bin} ${shellQuote(a.add)}`
      if (!write) {
        out(`  · would run: ${cmd}`)
        return true
      }
      if (!onPath(a.bin, ctx.env)) {
        out(`  ✗ ${a.bin} is not on PATH — run it yourself:\n      ${cmd}`)
        return false
      }
      spawnSync(a.bin, a.remove, { stdio: 'ignore', env: ctx.env as NodeJS.ProcessEnv })
      const r = spawnSync(a.bin, a.add, { encoding: 'utf8', env: ctx.env as NodeJS.ProcessEnv })
      if (r.status === 0) {
        out(`  ✓ MCP server registered (${a.bin} mcp add)`)
        return true
      }
      const why = `${r.stderr || r.stdout || r.error?.message || ''}`
        .trim()
        .split('\n')
        .slice(-3)
        .join(' ')
      out(`  ✗ \`${a.bin} mcp add\` failed: ${why}\n      run it yourself: ${cmd}`)
      return false
    }
    case 'json': {
      if (!write) {
        out(
          `  · would add ${a.what} to ${t(a.path)}:\n${indent(JSON.stringify(a.snippet, null, 2))}`,
        )
        return true
      }
      try {
        const r = mergeJsonFile(a.path, a.apply)
        const verb =
          r === 'unchanged' ? '• already set:' : r === 'created' ? '✓ created' : '✓ updated'
        out(
          `  ${verb} ${a.what} → ${t(a.path)}${r === 'updated' ? ' (backup: .openrecall-bak)' : ''}`,
        )
        return true
      } catch (err) {
        out(
          `  ✗ couldn't edit ${t(a.path)} (${(err as Error).message}); add this yourself:\n${indent(JSON.stringify(a.snippet, null, 2))}`,
        )
        return false
      }
    }
    case 'skill': {
      const path = join(a.dir, SKILL_NAME, 'SKILL.md')
      if (!write) {
        out(`  · would install skill → ${t(path)}`)
        return true
      }
      const r = installSkill(a.dir)
      out(`  ${r === 'unchanged' ? '• skill up to date' : '✓ skill installed'} → ${t(path)}`)
      return true
    }
    case 'manual':
      out(`  → ${a.text}`)
      return true
    case 'note':
      out(`  ! ${a.text}`)
      return true
  }
}

export type SetupOptions = {
  write?: boolean
  /** `auto` (default), `npx`, or an absolute path; see launchCommand. */
  launcher?: string
  /** Alias for `launcher: 'npx'`. */
  npx?: boolean
  env?: Env
  /** Use this launch as is (tests). */
  launch?: Launch
  out?: (line: string) => void
}

/** Returns false if any action failed. */
export async function runSetup(names: string[], opts: SetupOptions = {}): Promise<boolean> {
  const env = opts.env ?? process.env
  const out = opts.out ?? ((l: string) => console.log(l))
  const home = env.HOME || homedir()
  const settings = resolveSettings(env)
  const chosen: Launcher = opts.launch
    ? { launch: opts.launch, reason: isPortable(opts.launch) ? 'portable' : 'pinned', warnings: [] }
    : launchCommand({ launcher: opts.launcher, npx: opts.npx, env })
  const { launch } = chosen
  const ctx: Ctx = { env, home, launch, settings }

  if (names.length === 0) {
    out('Agents OpenRecall can connect (✓ = found on this machine):\n')
    for (const a of AGENTS) out(`  ${a.detect(ctx) ? '✓' : ' '} ${a.id.padEnd(15)} ${a.name}`)
    out(
      '\npreview:  openrecall setup all\n' +
        'apply:    openrecall setup all --write      (or name agents: setup claude-code zero --write)',
    )
    return true
  }

  const known = new Map(AGENTS.map(a => [a.id, a]))
  const unknown = names.filter(n => n !== 'all' && !known.has(n))
  if (unknown.length) {
    throw new Error(
      `unknown agent(s): ${unknown.join(', ')} — choose from: ${[...known.keys()].join(', ')}, all`,
    )
  }
  const selected = names.includes('all')
    ? AGENTS.filter(a => a.detect(ctx))
    : names.map(n => known.get(n) as Agent)
  if (selected.length === 0) throw new Error('no supported agents found on this machine')

  out(`OpenRecall → ${describeTarget(settings)} · namespace ${settings.namespace}`)
  out(`MCP command: ${shellQuote([launch.command, ...launch.args])} (${chosen.reason})`)
  for (const w of chosen.warnings) out(`! ${w}`)
  if (isPortable(launch)) out(`! ${PORTABLE_WARNING}`)
  if (!settings.passphrase) out('! no passphrase yet — run `openrecall init` before using memory')
  if (opts.write && settings.url === LOCAL_URL)
    mkdirSync(settings.home, { recursive: true, mode: 0o700 })

  let ok = true
  for (const agent of selected) {
    out(`\n${agent.name}`)
    for (const action of agent.plan(ctx)) ok = perform(action, ctx, !!opts.write, out) && ok
  }
  out(
    opts.write
      ? '\nDone. Restart each agent (or start a new session) to load OpenRecall.'
      : '\nDry run — nothing changed. Re-run with --write to apply.',
  )
  return ok
}
