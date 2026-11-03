/**
 * Every bare import in shipped code is a declared dependency.
 *
 * `src/mcp/server.ts` imported `zod` for a long time while only the MCP SDK was
 * declared. It resolved anyway, because npm and Bun hoist a transitive
 * dependency to the top of `node_modules` where a bare specifier finds it. That
 * is not a guarantee: a stricter installer does not hoist, and the day the SDK
 * drops or renames its own dependency the import breaks for consumers while
 * every gate in this repo stays green, because this repo's own install still
 * has the package.
 *
 * It is the shape of bug that only ever appears in someone else's project,
 * which is why it needs a test here rather than a note.
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')

/**
 * What a consumer's installer resolves bare imports for. dist/client/ is tsc
 * output, one file per source, so its imports are looked up in the consumer's
 * node_modules and have to be real `dependencies`.
 */
const UNBUNDLED = ['client']

/**
 * Inlined into dist/openrecall.js at build time (scripts/build.ts), so a bare
 * import here needs to resolve at build, which `devDependencies` covers, and
 * nothing at install. It still has to be declared somewhere: an import that
 * only resolves because a transitive dependency was hoisted breaks the build
 * the day that dependency changes.
 */
const BUNDLED = ['src', 'bin']

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

/**
 * Bare specifiers only: a relative path is this repo's own code. Anchored to a
 * statement so prose in a comment ("matched nothing" from "matched something")
 * is not read as an import.
 */
function bareImports(src: string): string[] {
  const out: string[] = []
  const stmt =
    /^\s*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'".][^'"]*)['"]|^\s*import\s*['"]([^'".][^'"]*)['"]|\bimport\(\s*['"]([^'".][^'"]*)['"]\s*\)/gm
  for (const m of src.matchAll(stmt)) {
    const spec = (m[1] ?? m[2] ?? m[3]) as string
    if (spec.startsWith('node:') || spec.startsWith('bun:')) continue
    // A subpath import still resolves against the package name.
    out.push(
      spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] as string),
    )
  }
  return out
}

function importsUnder(dirs: string[]): Map<string, string> {
  const used = new Map<string, string>()
  for (const dir of dirs) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      for (const spec of bareImports(readFileSync(file, 'utf8'))) {
        if (!used.has(spec)) used.set(spec, file.slice(ROOT.length + 1))
      }
    }
  }
  return used
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const undeclared = (used: Map<string, string>, declared: Set<string>) =>
  [...used]
    .filter(([spec]) => !declared.has(spec))
    .map(([spec, file]) => `${spec} (imported by ${file})`)

describe('shipped code declares what it imports', () => {
  test('unbundled library code imports only real dependencies, not merely hoisted ones', () => {
    const declared = new Set(Object.keys(pkg.dependencies ?? {}))
    expect(undeclared(importsUnder(UNBUNDLED), declared)).toEqual([])
    // Controls: the walk saw client files, and the check does flag a specifier
    // that is only a devDependency, so an empty result is not an empty walk.
    expect(sourceFiles(join(ROOT, 'client')).length).toBeGreaterThan(0)
    const devOnly = Object.keys(pkg.devDependencies ?? {})[0] as string
    expect(undeclared(new Map([[devOnly, 'client/x.ts']]), declared)).toHaveLength(1)
  })

  test('bundled code imports only declared packages, so the build never leans on hoisting', () => {
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ])
    const used = importsUnder(BUNDLED)

    // Positive control: the walk actually found the imports it claims to check.
    // Without this the assertion below holds just as well over an empty set.
    expect(used.has('@modelcontextprotocol/sdk')).toBe(true)
    expect(used.has('zod')).toBe(true)

    expect(undeclared(used, declared)).toEqual([])
  })

  test('the scanner reads statements, not prose', () => {
    expect(bareImports('// "matched nothing" from "matched something"\n')).toEqual([])
    expect(bareImports("import { z } from 'zod'\nimport('left-pad')\n")).toEqual([
      'zod',
      'left-pad',
    ])
  })
})
