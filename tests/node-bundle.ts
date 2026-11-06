/**
 * A Node bundle of the CLI, built from the current source once per test
 * process, for the suites that launch it under `node`.
 *
 * Those suites used to look for dist/openrecall.js and skip when it was absent,
 * which tied the Node launcher's coverage to whether and when someone last ran
 * `bun run build`: absent, the launcher went untested without a word; present
 * but stale, it tested last week's code and passed against a source that no
 * longer worked under Node. Building it here removes both states. The whole of
 * scripts/build.ts is not run from here because its tsc step takes seconds and
 * rewrites dist/client while tests/package.test.ts is reading it.
 *
 * The bundle is built in a child `bun`, not with `Bun.build` in this process:
 * inside `bun test` the bundler fails to resolve files directly under src/
 * ("Could not resolve ../src/version.ts") until the runtime resolver has
 * touched one of them, which looks like a directory cache shared with the
 * test-file scanner (Bun 1.3.11). A child has no such state, and the same call
 * from `bun -e` or `bun run build` has never failed. Measured: ~30 ms for the
 * child against ~20 ms in-process.
 *
 * The output dir is named after this process, and each build first removes
 * the dirs of earlier processes that are gone, because `bun test` does not run
 * `exit` handlers registered while a module loads: a cleanup hook alone left a
 * copy behind on every run.
 *
 * A plain module: nothing from `bun:test`, and nothing at import time beyond a
 * PATH lookup, so a suite that imports it registers no cases and builds
 * nothing it did not ask for.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `node` on PATH, or null, in which case the launcher tests skip. */
export const NODE = Bun.which('node')
if (!NODE) {
  console.warn('tests/node-bundle.ts: no `node` on PATH, so the Node launcher is not tested')
}

const BUILD = fileURLToPath(new URL('../scripts/build.ts', import.meta.url))
const PREFIX = 'openrecall-bundle-'

let bundle: Promise<string> | undefined

/** The executable entry of a bundle built from the current source. */
export function nodeBundle(): Promise<string> {
  bundle ??= build()
  return bundle
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // Exists but is someone else's: leave its directory alone too.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Remove the bundles of test processes that no longer exist. */
function sweep(): void {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(PREFIX)) continue
    const pid = Number(name.slice(PREFIX.length))
    if (!Number.isInteger(pid) || pid === process.pid || alive(pid)) continue
    rmSync(join(tmpdir(), name), { recursive: true, force: true })
  }
}

async function build(): Promise<string> {
  sweep()
  const dir = join(tmpdir(), `${PREFIX}${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir)
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }))
  // The module type the shipped dist/ inherits from the package manifest;
  // without it Node has to sniff the files for ESM syntax first.
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n')
  const code = `import { bundleCli } from ${JSON.stringify(BUILD)}
process.stdout.write(await bundleCli(${JSON.stringify(dir)}))
`
  const child = Bun.spawn([process.execPath, '-e', code], { stdout: 'pipe', stderr: 'pipe' })
  const [entry, err, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (status !== 0 || !entry) throw new Error(`bundling the CLI for Node failed:\n${err}`)
  return entry
}
