/**
 * Build what the npm package ships, in two parts.
 *
 * 1. The CLI + MCP server for Node, so agents can launch it with plain
 *    `npx -y @twigpine/openrecall mcp` — no Bun required. Dependencies (MCP
 *    SDK, zod) and SKILL.md are inlined. `serve` uses Bun APIs (Bun.serve /
 *    Bun.S3Client); under Node, the CLI launches the same installed bundle with
 *    Bun from PATH.
 *
 *    Two files: dist/openrecall.cli.js is the bundle, and dist/openrecall.js,
 *    the `bin` entry, is a shim that turns on Node's on-disk compile cache and
 *    imports it. The cache covers only modules loaded after it is enabled, so
 *    a call inside the bundle could never cache the bundle itself.
 *
 * 2. The client as a library, dist/client/, for agents that import
 *    `@twigpine/openrecall` rather than spawn the MCP server: plain ESM plus
 *    declarations, which is what the package `exports` point at. Emitted by
 *    tsc rather than bundled so each built file is exactly one source
 *    (tsconfig.client.json); a bundle per entry point would give the root
 *    and `./secretscan` their own copies of SecretFoundError.
 *
 * `bundleCli` is exported for tests/node-bundle.ts, which builds part 1 into a
 * temp dir so the Node launcher is tested from the current source. The full
 * build below runs only when this file is the entry (`bun run build`).
 */

import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENTRY = fileURLToPath(new URL('../bin/openrecall.ts', import.meta.url))

/** The bundle, beside the shim. */
export const CLI_BUNDLE = 'openrecall.cli.js'
/** The executable the package's `bin` points at. */
export const CLI_ENTRY = 'openrecall.js'

const SHIM = `#!/usr/bin/env node
// Node compiles ${CLI_BUNDLE} on every launch. The compile cache keeps the
// result on disk between launches and covers only modules loaded after it is
// enabled, which is why this file exists. Bun needs neither.
if (typeof Bun === 'undefined') {
  const { enableCompileCache } = await import('node:module')
  enableCompileCache?.()
}
await import('./${CLI_BUNDLE}')
`

/**
 * Bundle the CLI for Node into `outdir` and return the path of its executable
 * entry, `outdir/openrecall.js`.
 */
export async function bundleCli(outdir: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [ENTRY],
    outdir,
    naming: CLI_BUNDLE,
    target: 'node',
    format: 'esm',
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error(`bundling ${ENTRY} failed`)
  }
  // Bun carries the source's `#!/usr/bin/env bun` line through; the shim is
  // the executable, so the bundle gets none.
  const bundle = join(outdir, CLI_BUNDLE)
  await writeFile(bundle, (await readFile(bundle, 'utf8')).replace(/^#!.*\n/, ''))
  const entry = join(outdir, CLI_ENTRY)
  await writeFile(entry, SHIM)
  await chmod(entry, 0o755)
  return entry
}

if (import.meta.main) {
  await rm('dist', { recursive: true, force: true })
  const entry = await bundleCli('dist')
  const kb = Math.round((await stat(join('dist', CLI_BUNDLE))).size / 1024)
  console.log(`built ${entry} -> dist/${CLI_BUNDLE} (${kb} KB)`)

  const tsc = Bun.spawnSync(['bunx', 'tsc', '-p', 'tsconfig.client.json'], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (tsc.exitCode !== 0) process.exit(tsc.exitCode)
  console.log('built dist/client/{index,crypto,secretscan}.{js,d.ts}')
}
