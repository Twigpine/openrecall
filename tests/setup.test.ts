/**
 * `openrecall setup` against a fake HOME with stub agent CLIs that record their
 * arguments — so we test real file edits and real CLI invocations without
 * touching the developer's actual agent configs.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { type Launch, launchCommand, PORTABLE_WARNING, runSetup } from '../src/cli/setup.ts'
import { SKILL_MARKDOWN } from '../src/mcp/guide.ts'
import { nodeFloor, version } from '../src/version.ts'

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const LAUNCH: Launch = {
  command: '/opt/node/bin/node',
  args: ['/opt/openrecall/dist/openrecall.js', 'mcp'],
}

let home: string
let bin: string
let log: string
let env: Record<string, string>
let lines: string[]

function stub(name: string, exit = 0) {
  const p = join(bin, name)
  writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit ${exit}\n`)
  chmodSync(p, 0o755)
}

const run = (names: string[], write = true) =>
  runSetup(names, { write, env, launch: LAUNCH, out: l => lines.push(l) })
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'openrecall-setup-'))
  roots.push(root)
  home = join(root, 'home')
  bin = join(root, 'bin')
  log = join(root, 'calls.log')
  mkdirSync(home)
  mkdirSync(bin)
  env = {
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    OPENRECALL_HOME: join(home, '.openrecall'),
    XDG_CONFIG_HOME: join(home, '.config'),
  }
  lines = []
})

describe('openrecall setup', () => {
  test('dry run changes nothing and shows the exact commands', async () => {
    stub('claude')
    await run(['claude-code'], false)
    expect(calls()).toEqual([])
    expect(existsSync(join(home, '.claude'))).toBe(false)
    const text = lines.join('\n')
    expect(text).toContain(
      'claude mcp add --scope user openrecall -- /opt/node/bin/node /opt/openrecall/dist/openrecall.js mcp',
    )
    expect(text).toContain('Dry run')
  })

  test('claude-code: replaces any old entry, registers user-scope MCP, installs skill', async () => {
    stub('claude')
    expect(await run(['claude-code'])).toBe(true)
    expect(calls()).toEqual([
      'claude mcp remove --scope user openrecall',
      'claude mcp add --scope user openrecall -- /opt/node/bin/node /opt/openrecall/dist/openrecall.js mcp',
    ])
    const skill = join(home, '.claude', 'skills', 'openrecall-memory', 'SKILL.md')
    expect(readFileSync(skill, 'utf8')).toBe(SKILL_MARKDOWN)
  })

  test('zero: mcp add, shared skill, and a sandbox write grant for the local store only', async () => {
    stub('zero')
    const cfg = join(home, '.config', 'zero', 'config.json')
    mkdirSync(join(home, '.config', 'zero'), { recursive: true })
    writeFileSync(cfg, JSON.stringify({ activeProvider: 'x', sandbox: { network: 'deny' } }))
    chmodSync(cfg, 0o600)

    expect(await run(['zero'])).toBe(true)
    expect(calls()).toContain(
      'zero mcp add openrecall -- /opt/node/bin/node /opt/openrecall/dist/openrecall.js mcp',
    )
    expect(existsSync(join(home, '.agents', 'skills', 'openrecall-memory', 'SKILL.md'))).toBe(true)
    const doc = readJson(cfg)
    expect(doc.activeProvider).toBe('x') // untouched
    expect(doc.sandbox.network).toBe('deny') // never widened
    expect(doc.sandbox.additionalWriteRoots).toEqual([join(home, '.openrecall')])
    expect(existsSync(`${cfg}.openrecall-bak`)).toBe(true)
    expect(readFileSync(cfg).length).toBeGreaterThan(0)
    expect(statSync(cfg).mode & 0o777).toBe(0o600) // perms preserved

    lines = []
    await run(['zero']) // idempotent
    expect(readJson(cfg).sandbox.additionalWriteRoots).toHaveLength(1)
    expect(lines.join('\n')).toContain('already set')
  })

  test('json agents merge without clobbering other servers', async () => {
    const cursor = join(home, '.cursor', 'mcp.json')
    mkdirSync(join(home, '.cursor'))
    writeFileSync(cursor, JSON.stringify({ mcpServers: { other: { command: 'x' } } }))
    expect(await run(['cursor', 'gemini', 'opencode'])).toBe(true)

    expect(readJson(cursor).mcpServers).toEqual({
      other: { command: 'x' },
      openrecall: { command: LAUNCH.command, args: LAUNCH.args },
    })
    expect(readJson(join(home, '.gemini', 'settings.json')).mcpServers.openrecall.command).toBe(
      LAUNCH.command,
    )
    expect(readJson(join(home, '.config', 'opencode', 'opencode.json')).mcp.openrecall).toEqual({
      type: 'local',
      command: [LAUNCH.command, ...LAUNCH.args],
      enabled: true,
    })
  })

  test('refuses to rewrite a JSONC config and prints the snippet instead', async () => {
    const cursor = join(home, '.cursor', 'mcp.json')
    mkdirSync(join(home, '.cursor'))
    const jsonc = '{ // my servers\n  "mcpServers": {}\n}\n'
    writeFileSync(cursor, jsonc)
    expect(await run(['cursor'])).toBe(false)
    expect(readFileSync(cursor, 'utf8')).toBe(jsonc)
    expect(lines.join('\n')).toContain('"openrecall"')
  })

  test('a missing agent CLI fails loudly with the command to run', async () => {
    expect(await run(['codex'])).toBe(false)
    expect(lines.join('\n')).toContain('codex is not on PATH')
    expect(lines.join('\n')).toContain('codex mcp add openrecall --')
  })

  test('"all" picks only agents found on this machine; unknown names error', async () => {
    stub('claude')
    await run(['all'])
    const text = lines.join('\n')
    expect(text).toContain('Claude Code')
    expect(text).not.toContain('Windsurf')
    await expect(run(['nope'])).rejects.toThrow(/unknown agent/)
  })

  test('a portable launcher: the dry run says why, and warns once about the npx cost', async () => {
    await runSetup(['cursor', 'gemini', 'zero', 'claude-desktop'], {
      env,
      launcher: 'npx',
      out: l => lines.push(l),
    })
    const text = lines.join('\n')
    expect(text).toContain(
      `MCP command: npx -y @twigpine/openrecall@${version()} mcp (portable: requested)`,
    )
    // One global line, after the command, not one per agent.
    expect(text.split(`! ${PORTABLE_WARNING}`)).toHaveLength(2)
    expect(text.indexOf('MCP command:')).toBeLessThan(text.indexOf(PORTABLE_WARNING))
    expect(PORTABLE_WARNING).toContain('npm i -g @twigpine/openrecall')
    // The per-agent notes for the clients npx hurts most are still there.
    expect(text).toContain('Zero runs MCP servers in its sandbox with network denied')
    expect(text).toContain('Claude Desktop starts servers with a minimal PATH')
  })

  test('a pinned launcher carries no portable warning', async () => {
    stub('my-openrecall')
    const exe = join(bin, 'my-openrecall')
    await runSetup(['cursor', 'zero', 'claude-desktop'], {
      env,
      launcher: exe,
      out: l => lines.push(l),
    })
    let text = lines.join('\n')
    expect(text).toContain(`MCP command: ${exe} mcp (pinned: --launcher)`)
    expect(text).not.toContain('portable launcher')
    expect(text).not.toContain('network denied')
    expect(text).not.toContain('minimal PATH')
    expect(text).toContain(`"command": "${exe}"`)

    lines = []
    await run(['cursor'], false) // the suite's injected launch
    text = lines.join('\n')
    expect(text).toContain(`MCP command: ${LAUNCH.command} ${LAUNCH.args.join(' ')} (pinned)`)
    expect(text).not.toContain('portable launcher')
  })
})

describe('launchCommand', () => {
  const NPX: Launch = { command: 'npx', args: ['-y', `@twigpine/openrecall@${version()}`, 'mcp'] }
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openrecall-launch-'))
    roots.push(dir)
  })

  /** What `npx -y @twigpine/openrecall setup` runs from. */
  function cached(): string {
    const js = join(
      dir,
      '_npx',
      'abc',
      'node_modules',
      '@twigpine',
      'openrecall',
      'dist',
      'openrecall.js',
    )
    mkdirSync(dirname(js), { recursive: true })
    writeFileSync(js, '')
    return js
  }

  function executable(path: string): string {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '#!/bin/sh\n')
    chmodSync(path, 0o755)
    return path
  }

  /** A global install under `root`: bin/openrecall, as npm (symlink to the .js) or as a binary. */
  function globalInstall(root: string, kind: 'js' | 'binary'): string {
    const link = join(root, 'bin', 'openrecall')
    if (kind === 'binary') return executable(link)
    const js = executable(
      join(root, 'lib', 'node_modules', '@twigpine', 'openrecall', 'dist', 'openrecall.js'),
    )
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(js, link)
    return js
  }

  test('pins the runtime and script for an installed copy or checkout', () => {
    const l = launchCommand({ script: 'bin/openrecall.ts', execPath: '/x/bun', bun: true })
    expect(l.launch.command).toBe('/x/bun')
    expect(l.launch.args[0]).toEndWith('/bin/openrecall.ts')
    expect(l.launch.args[1]).toBe('mcp')
    expect(l.reason).toBe('pinned: installed script')
    expect(l.warnings).toEqual([])
  })

  test('a compiled binary pins itself, never npx', () => {
    // Under `bun build --compile`, argv[1] is a path on Bun's virtual
    // filesystem that realpath cannot stat. Both tells lead to the binary.
    const execPath = '/opt/openrecall-darwin-arm64'
    const want = {
      launch: { command: execPath, args: ['mcp'] },
      reason: 'pinned: standalone binary',
      warnings: [],
    }
    const env = { PATH: '/usr/bin' }
    expect(launchCommand({ script: '/$bunfs/root/openrecall', execPath, bun: true, env })).toEqual(
      want,
    )
    expect(launchCommand({ script: join(dir, 'gone'), execPath, bun: true, env })).toEqual(want)
  })

  test('from an npx cache, pins a global install found on PATH', () => {
    const js = globalInstall(dir, 'js')
    const env = { PATH: `${join(dir, 'bin')}:/usr/bin` }
    const common = { script: cached(), execPath: '/opt/node/bin/node', bun: false, env }
    expect(launchCommand({ ...common, nodeVersion: nodeFloor() })).toEqual({
      launch: { command: '/opt/node/bin/node', args: [realpathSync(js), 'mcp'] },
      reason: 'pinned: global install',
      warnings: [],
    })

    // The same install as a standalone binary runs on its own.
    rmSync(join(dir, 'bin'), { recursive: true })
    const exe = globalInstall(dir, 'binary')
    expect(launchCommand({ ...common, nodeVersion: '1.0.0' })).toEqual({
      launch: { command: realpathSync(exe), args: ['mcp'] },
      reason: 'pinned: global install',
      warnings: [], // pins no Node, so no floor to be below
    })
  })

  test("from an npx cache, the cache's own .bin on PATH does not count as an install", () => {
    // npx puts its cache's node_modules/.bin first on PATH while it runs.
    const js = cached()
    const dotBin = join(dir, '_npx', 'abc', 'node_modules', '.bin')
    mkdirSync(dotBin)
    symlinkSync(js, join(dotBin, 'openrecall'))
    const l = launchCommand({
      script: js,
      bun: false,
      nodeVersion: nodeFloor(),
      env: { PATH: dotBin },
    })
    expect(l).toEqual({ launch: NPX, reason: 'portable: no install found on PATH', warnings: [] })
  })

  test('nothing on PATH: the portable npx form, pinned to this version', () => {
    const env = { PATH: `${join(dir, 'empty')}:/usr/bin` }
    const l = launchCommand({ script: cached(), bun: false, nodeVersion: nodeFloor(), env })
    expect(l).toEqual({ launch: NPX, reason: 'portable: no install found on PATH', warnings: [] })
    expect(NPX.args[1]).toMatch(/^@twigpine\/openrecall@\d+\.\d+\.\d+/)
  })

  test('--launcher: npx on request, an absolute executable verbatim, anything else refused', () => {
    expect(launchCommand({ launcher: 'npx' })).toEqual({
      launch: NPX,
      reason: 'portable: requested',
      warnings: [],
    })
    expect(launchCommand({ npx: true }).launch).toEqual(NPX)

    const exe = executable(join(dir, 'my-openrecall'))
    expect(launchCommand({ launcher: exe })).toEqual({
      launch: { command: exe, args: ['mcp'] },
      reason: 'pinned: --launcher',
      warnings: [],
    })
    expect(() => launchCommand({ launcher: join(dir, 'missing') })).toThrow(
      /not an executable file/,
    )
    const plain = join(dir, 'plain')
    writeFileSync(plain, '')
    chmodSync(plain, 0o644)
    expect(() => launchCommand({ launcher: plain })).toThrow(/not an executable file/)
    expect(() => launchCommand({ launcher: dir })).toThrow(/not an executable file/)
    expect(() => launchCommand({ launcher: 'bin/openrecall.ts' })).toThrow(/absolute path/)
  })

  test('warns when the pinned Node is below the engines floor, under Node only', () => {
    const floor = nodeFloor()
    const [major] = floor.split('.')
    const older = `${Number(major) - 1}.99.99`
    const base = { script: 'bin/openrecall.ts', execPath: '/x/node', bun: false }

    const l = launchCommand({ ...base, nodeVersion: older })
    expect(l.reason).toBe('pinned: installed script')
    expect(l.warnings).toEqual([
      `this pins Node ${older}, below the floor ${floor}; upgrade Node, then rerun setup`,
    ])
    expect(launchCommand({ ...base, nodeVersion: floor }).warnings).toEqual([])
    expect(launchCommand({ ...base, nodeVersion: `${Number(major) + 1}.0.0` }).warnings).toEqual([])
    // Bun reports an emulated, older versions.node; that is not an old Node.
    expect(launchCommand({ ...base, bun: true, nodeVersion: '0.0.1' }).warnings).toEqual([])
  })
})

describe('openrecall setup (CLI)', () => {
  const ROOT = resolve(import.meta.dir, '..')
  const cli = (...args: string[]) => {
    // A real HOME here would read the developer's own config and agents.
    const r = Bun.spawnSync(
      [process.execPath, 'run', join(ROOT, 'bin/openrecall.ts'), 'setup', ...args],
      { env: { ...env, PATH: process.env.PATH ?? '' }, stdout: 'pipe', stderr: 'pipe' },
    )
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
  }

  test('--launcher reaches the dry run; --npx still means --launcher npx', () => {
    stub('my-openrecall')
    const exe = join(bin, 'my-openrecall')
    const r = cli('cursor', '--launcher', exe)
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.out).toContain(`MCP command: ${exe} mcp (pinned: --launcher)`)
    expect(r.out).toContain(`"command": "${exe}"`)
    expect(r.out).toContain('Dry run')
    expect(existsSync(join(home, '.cursor'))).toBe(false)

    const n = cli('cursor', '--npx')
    expect(n.code).toBe(0)
    expect(n.out).toContain(`"@twigpine/openrecall@${version()}"`)
    expect(n.out).toContain('portable launcher')

    const bad = cli('cursor', '--launcher', join(home, 'nope'))
    expect(bad.code).toBe(1)
    expect(bad.err).toContain('not an executable file')
  })
})
