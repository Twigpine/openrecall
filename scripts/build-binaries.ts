/**
 * Standalone binaries, for a machine with neither Bun nor Node.
 *
 * `bun build --compile` bakes the runtime in, so these are the only artifact
 * that needs no install of anything. They are large (tens of MB each) because
 * of that; that is the trade, not a defect.
 *
 * The memory guide (SKILL.md) and the package version are imported as text and
 * JSON, so the compile embeds them with no plugin and nothing is read from disk
 * at runtime. The Node build in scripts/build.ts relies on the same imports.
 *
 * Run: bun run scripts/build-binaries.ts [outdir]
 */

import { mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outdir = process.argv[2] ?? join(root, 'binaries')

/**
 * The platforms a release ships. Kept here rather than in the workflow so the
 * list is one thing, and so a local run produces what CI produces.
 *
 * The musl builds are not fully self-contained: they link against libstdc++ and
 * libgcc, so a bare Alpine cannot load them until `apk add libstdc++`. Measured,
 * not assumed. The glibc builds do run on a stock debian:12-slim with neither
 * runtime present. The README says so; if these targets change, say so there.
 */
const TARGETS = [
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-linux-x64-musl',
  'bun-linux-arm64-musl',
  'bun-darwin-x64',
  'bun-darwin-arm64',
  'bun-windows-x64',
] as const

await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })

const only = process.env.BINARY_TARGETS?.split(',').filter(Boolean)
const targets = only?.length ? TARGETS.filter(t => only.includes(t)) : TARGETS

for (const target of targets) {
  const name = `openrecall-${target.replace(/^bun-/, '')}${target.includes('windows') ? '.exe' : ''}`
  const outfile = join(outdir, name)
  const built = await Bun.build({
    entrypoints: [join(root, 'bin/openrecall.ts')],
    target: 'bun',
    compile: { target, outfile },
    minify: true,
  })
  if (!built.success) {
    for (const log of built.logs) console.error(log)
    throw new Error(`build: ${target} failed`)
  }
  console.log(`built ${name}`)
}

// Checksums beside the binaries: a downloaded binary is the one artifact a user
// cannot inspect before running.
const names = (await readdir(outdir)).filter(n => n.startsWith('openrecall-')).sort()
const sums = (
  await Promise.all(
    names.map(async n => {
      const hex = new Bun.CryptoHasher('sha256')
        .update(await Bun.file(join(outdir, n)).arrayBuffer())
        .digest('hex')
      // sha256sum's text format, so `sha256sum -c SHA256SUMS` verifies it.
      return `${hex}  ${n}\n`
    }),
  )
).join('')
await Bun.write(join(outdir, 'SHA256SUMS'), sums)
console.log(sums.trim())
