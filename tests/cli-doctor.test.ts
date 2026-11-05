/**
 * `openrecall doctor` against a throwaway local store: it prints the meters
 * line and the proposals for the seeded namespace, records its marker, and
 * never prints a note's body, which is memory and not a diagnostic.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const home = mkdtempSync(join(tmpdir(), 'openrecall-doctor-home-'))
const dir = mkdtempSync(join(tmpdir(), 'openrecall-doctor-notes-'))
afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

const SECRET_WORD = 'xylophone-marmalade'

function cli(args: string[]) {
  // An explicit env: the test preload's STORE/DATA_DIR/caps must not leak into
  // the child, which resolves its own local store under OPENRECALL_HOME.
  const r = Bun.spawnSync(['bun', 'run', join(ROOT, 'bin/openrecall.ts'), ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      OPENRECALL_HOME: home,
      OPENRECALL_PASSPHRASE: 'doctor-pass',
    },
  })
  return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode }
}

describe('openrecall doctor', () => {
  test('prints the meters line and the proposals for a seeded store, never the content', () => {
    writeFileSync(join(dir, 'prefs.md'), `The user likes ${SECRET_WORD} and terse answers.\n`)
    writeFileSync(join(dir, 'deploy.md'), 'Project conventions: deploys go through Fly.\n')
    const pushed = cli(['push', dir])
    expect(`${pushed.code}: ${pushed.err}`).toBe('0: ')

    const r = cli(['doctor'])
    expect(`${r.code}: ${r.err}`).toBe('0: ')
    expect(r.out.startsWith('doctor report for user:me:\n')).toBe(true)
    expect(r.out).toMatch(
      /^entries 2\/2000 · bytes [\d.]+ (B|KB)\/10 MB · index 0\/200 lines, 0\/25 KB · history 0 · trash 0$/m,
    )
    // A raw `push` writes no index and no stamps, which is what the doctor says.
    expect(r.out).toContain('\nindex-missing (1):\n')
    expect(r.out).toContain('\nuntyped (2):\n')
    expect(r.out).toContain('- deploy.md: no type field')
    expect(r.out).not.toContain(SECRET_WORD)
    expect(r.out).not.toContain('terse answers')
    expect(r.out).not.toContain('deploys go through')
    // Recorded like an agent's run, so the next MCP start does not repeat it.
    expect(existsSync(join(home, 'state', 'doctor.json'))).toBe(true)
  })

  test('a namespace argument is audited instead; an invalid one is an error', () => {
    const r = cli(['doctor', 'user:me/empty'])
    expect(`${r.code}: ${r.err}`).toBe('0: ')
    expect(r.out).toContain('doctor report for user:me/empty:\nentries 0/2000 · ')
    expect(r.out).toContain('\nno findings')
    const bad = cli(['doctor', 'not a namespace'])
    expect(bad.code).toBe(1)
    expect(bad.err).toContain('error:')
    expect(bad.out).toBe('')
  })

  test('usage names the command', () => {
    const r = cli(['help'])
    expect(r.out).toContain('openrecall doctor [namespace]')
  })
})
