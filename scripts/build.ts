/**
 * Bundle the CLI + MCP server into one Node-compatible file, dist/openrecall.js,
 * so agents can launch it with plain `npx -y @twigpine/openrecall mcp` — no
 * Bun required. Dependencies (MCP SDK, zod) and SKILL.md are inlined.
 *
 * `serve` is the one Bun-only command (Bun.serve / Bun.S3Client); the CLI
 * refuses it with a clear message when run under Node.
 */

import { chmod, readFile, rm, writeFile } from 'node:fs/promises'

await rm('dist', { recursive: true, force: true })
const result = await Bun.build({
  entrypoints: ['bin/openrecall.ts'],
  outdir: 'dist',
  naming: 'openrecall.js',
  target: 'node',
  format: 'esm',
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const out = 'dist/openrecall.js'
const code = (await readFile(out, 'utf8')).replace(/^#!.*\n/, '')
await writeFile(out, `#!/usr/bin/env node\n${code}`)
await chmod(out, 0o755)
const kb = Math.round(Buffer.byteLength(code) / 1024)
console.log(`built ${out} (${kb} KB)`)
