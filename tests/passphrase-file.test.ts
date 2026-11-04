/**
 * OPENRECALL_PASSPHRASE_FILE through the shared settings and the CLI, not only
 * the MCP startup check: precedence, the no-fallback rule, and `init`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassphraseFileError, resolveSettings } from '../src/cli/settings.ts'

const ROOT = resolve(import.meta.dir, '..')
let dir = ''
let home = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'openrecall-ppfile-'))
  home = join(dir, 'home')
  mkdirSync(home)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const write = (name: string, body: string) => {
  const p = join(dir, name)
  writeFileSync(p, body)
  return p
}
const env = (over: Record<string, string | undefined>) => ({ OPENRECALL_HOME: home, ...over })

describe('resolveSettings with a passphrase file', () => {
  test('the file wins over the variable and over config.json, and a trailing newline is dropped', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ passphrase: 'from-config' }))
    const file = write('good', 'from-file\r\n')
    const s = resolveSettings(
      env({ OPENRECALL_PASSPHRASE_FILE: file, OPENRECALL_PASSPHRASE: 'from-env' }),
    )
    expect(s.passphrase).toBe('from-file')
    // Control: without the file, the variable beats the config file.
    expect(resolveSettings(env({ OPENRECALL_PASSPHRASE: 'from-env' })).passphrase).toBe('from-env')
    rmSync(join(home, 'config.json'))
  })

  test('an unusable file throws instead of falling back to another source', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ passphrase: 'from-config' }))
    const cases = {
      missing: join(dir, 'does-not-exist'),
      empty: write('empty', '  \n'),
      directory: dir,
    }
    for (const [name, path] of Object.entries(cases)) {
      let thrown: unknown
      try {
        resolveSettings(
          env({ OPENRECALL_PASSPHRASE_FILE: path, OPENRECALL_PASSPHRASE: 'from-env' }),
        )
      } catch (err) {
        thrown = err
      }
      expect(`${name}: ${thrown instanceof PassphraseFileError}`).toBe(`${name}: true`)
    }
    rmSync(join(home, 'config.json'))
  })
})

function cli(args: string[], extra: Record<string, string | undefined>) {
  const r = Bun.spawnSync(['bun', 'run', join(ROOT, 'bin/openrecall.ts'), ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: dir, OPENRECALL_HOME: home, ...extra },
  })
  return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode }
}

describe('the CLI honours the file', () => {
  test('init stores no second passphrase when a file supplies it', () => {
    const file = write('init-file', 'file-supplied-passphrase\n')
    const r = cli(['init'], { OPENRECALL_PASSPHRASE_FILE: file })
    expect(r.code).toBe(0)
    expect(r.out).toContain('OPENRECALL_PASSPHRASE_FILE')
    const stored = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as {
      passphrase?: string
    }
    expect(stored.passphrase).toBeUndefined()
    rmSync(join(home, 'config.json'))
  })

  test('push refuses on an unreadable file and names it, rather than using another key', () => {
    const src = join(dir, 'mem')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'a.md'), 'x')
    const r = cli(['push', src, 'user:me'], {
      OPENRECALL_PASSPHRASE_FILE: join(dir, 'nope'),
      OPENRECALL_PASSPHRASE: 'fallback-must-not-be-used',
    })
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('OPENRECALL_PASSPHRASE_FILE')
    expect(r.err + r.out).not.toContain('fallback-must-not-be-used')
  })
})

describe('a relative passphrase file path', () => {
  test('is refused, not resolved against the launcher directory', () => {
    write('rel', 'secret\n')
    expect(() => resolveSettings(env({ OPENRECALL_PASSPHRASE_FILE: 'rel' }))).toThrow(
      PassphraseFileError,
    )
  })
})
