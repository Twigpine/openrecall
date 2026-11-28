/**
 * `openrecall --version` reports the version.
 *
 * Not cosmetic. Consumers pin a minimum: zero's enable notice tells an operator
 * to check their openrecall with exactly this command, because a binary too old to
 * read OPENRECALL_PASSPHRASE_FILE fails with "no passphrase", which reads as a
 * configuration mistake rather than an out-of-date binary. Before this existed
 * the command fell through to usage and exited non-zero, so the advice sent
 * people somewhere that told them nothing.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { CLI_BUNDLE } from '../scripts/build.ts'
import { NODE, nodeBundle } from './node-bundle.ts'

const ROOT = resolve(import.meta.dir, '..')
const VERSION = (
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
).version

function run(args: string[]) {
  const r = Bun.spawnSync(['bun', 'run', join(ROOT, 'bin/openrecall.ts'), ...args])
  return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode }
}

describe('openrecall --version', () => {
  test('reports the package version and exits zero', () => {
    for (const flag of ['--version', '-v']) {
      const r = run([flag])
      expect(`${flag} exit ${r.code}`).toBe(`${flag} exit 0`)
      expect(r.out.trim()).toBe(VERSION)
    }
  })

  test('the version is the real one, not a hardcoded string', () => {
    // Reading it from package.json is what keeps a consumer's minimum-version
    // check honest after a release bump.
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
    expect(run(['--version']).out).toContain(VERSION)
  })

  // The Node build is a separate artifact from source, and a version that was
  // right under Bun and broken in the bundle is the failure this guards. The
  // bundle is built from the current source for this run (tests/node-bundle.ts),
  // so a stale dist/ can neither fail nor pass it; only a machine with no
  // `node` skips it.
  test.skipIf(!NODE)('the Node bundle reports the same version', async () => {
    const r = Bun.spawnSync([NODE as string, await nodeBundle(), '--version'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.toString().trim()).toBe(VERSION)
  })

  test('the entry is a shim over the bundle, and the bundle carries the version', async () => {
    // The layout scripts/build.ts documents: a one-screen shim that enables
    // Node's compile cache and imports the bundle beside it. A version that
    // ended up read from disk at runtime, rather than inlined, would fail the
    // second line.
    const entry = await nodeBundle()
    expect(readFileSync(entry, 'utf8')).toContain(`await import('./${CLI_BUNDLE}')`)
    expect(readFileSync(join(dirname(entry), CLI_BUNDLE), 'utf8')).toContain(`"${VERSION}"`)
  })

  test('an unknown flag still prints usage and fails', () => {
    // Control: this is a new accepted argument, not a change that makes every
    // argument acceptable.
    const r = run(['--nope'])
    expect(r.code).not.toBe(0)
    expect(r.out + r.err).toMatch(/usage:/)
  })
})
