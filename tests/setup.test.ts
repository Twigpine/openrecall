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
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Launch, launchCommand, runSetup } from '../src/cli/setup.ts'
import { SKILL_MARKDOWN } from '../src/mcp/guide.ts'

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
})

describe('launchCommand', () => {
  test('pins absolute paths for an installed copy or checkout', () => {
    const l = launchCommand({ script: 'bin/openrecall.ts', execPath: '/x/bun' })
    expect(l.command).toBe('/x/bun')
    expect(l.args[0]).toEndWith('/bin/openrecall.ts')
    expect(l.args[1]).toBe('mcp')
  })

  test('uses npx when running from an npx/bunx cache, or when asked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openrecall-launch-'))
    roots.push(dir)
    const cached = join(dir, '_npx', 'abc', 'openrecall.js')
    mkdirSync(join(dir, '_npx', 'abc'), { recursive: true })
    writeFileSync(cached, '')
    expect(launchCommand({ script: cached })).toEqual({
      command: 'npx',
      args: ['-y', '@twigpine/openrecall', 'mcp'],
    })
    expect(launchCommand({ npx: true }).command).toBe('npx')
  })
})
