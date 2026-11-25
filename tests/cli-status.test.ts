/**
 * `openrecall status --timings` against a throwaway local store: it prints the
 * per-stage table and the SLO line, and never the recalled content, which is
 * memory and not a diagnostic.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const home = mkdtempSync(join(tmpdir(), 'openrecall-status-home-'))
const dir = mkdtempSync(join(tmpdir(), 'openrecall-status-notes-'))
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
      OPENRECALL_PASSPHRASE: 'status-pass',
    },
  })
  return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode }
}

describe('openrecall status --timings', () => {
  test('prints a per-stage table and an informational SLO line, never the content', () => {
    writeFileSync(join(dir, 'prefs.md'), `The user likes ${SECRET_WORD} and terse answers.\n`)
    writeFileSync(join(dir, 'deploy.md'), 'Project conventions: deploys go through Fly.\n')
    const pushed = cli(['push', dir])
    expect(`${pushed.code}: ${pushed.err}`).toBe('0: ')

    const r = cli(['status', '--timings'])
    expect(`${r.code}: ${r.err}`).toBe('0: ')
    expect(r.out).toContain('2 entries')
    expect(r.out).toMatch(/recall timings over 2 entries, \d+ bytes fetched on the cold call/)
    expect(r.out).toMatch(/stage\s+cold\s+warm p50\s+warm p95/)
    for (const stage of ['fetch', 'decrypt', 'rank', 'format', 'total']) {
      expect(r.out).toMatch(new RegExp(`^${stage}\\s+[\\d.]+ ms\\s+[\\d.]+ ms\\s+[\\d.]+ ms$`, 'm'))
    }
    expect(r.out).toContain('SLO informational (2 entries')
    expect(r.out).not.toContain(SECRET_WORD)
    expect(r.out).not.toContain('terse answers')
    expect(r.out).not.toContain('project conventions and user preferences')
  })

  test('SLO eligibility uses the sampled workload when the namespace shrinks after status', async () => {
    let reads = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        reads++
        if (reads === 1)
          return Response.json({
            version: 1,
            supports: [],
            entryChecksums: Object.fromEntries(
              Array.from({ length: 2000 }, (_, i) => [`n${i}.md`, 'old']),
            ),
          })
        return Response.json(
          { error: { code: 'empty', message: 'empty namespace' } },
          { status: 404 },
        )
      },
    })
    try {
      const proc = Bun.spawn(
        ['bun', 'run', join(ROOT, 'bin/openrecall.ts'), 'status', '--timings'],
        {
          env: {
            PATH: process.env.PATH ?? '',
            HOME: home,
            OPENRECALL_HOME: home,
            OPENRECALL_URL: server.url.href,
            OPENRECALL_CACHE: 'off',
            OPENRECALL_PASSPHRASE: 'status-pass',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      expect(code, err).toBe(0)
      expect(out).toContain('2000 entries')
      expect(out).toContain('SLO informational (0 entries')
    } finally {
      server.stop(true)
    }
  })

  test('plain status prints no timings', () => {
    const r = cli(['status'])
    expect(r.code).toBe(0)
    expect(r.out).not.toContain('recall timings')
  })
})
