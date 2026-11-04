/**
 * The image and the manifest cannot drift apart on the runtime version.
 *
 * The Dockerfile pinned `oven/bun:1.1-alpine` while package.json declared
 * `bun >=1.2.0`. Nothing failed: the image builds, the server starts, and the
 * engine floor is a string nobody executes. It surfaces as a runtime feature
 * missing on a deployment, which is the worst place to find it.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')

/** Lowest version the range admits. Enough for `>=x.y.z`, which is what we use. */
function floorOf(range: string): number[] {
  const m = range.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!m) throw new Error(`unsupported engines range: ${range}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function imageVersion(dockerfile: string): number[] {
  const m = dockerfile.match(/^FROM\s+oven\/bun:([0-9.]+)/m)
  if (!m) throw new Error('no oven/bun base image found in Dockerfile')
  const parts = (m[1] as string).split('.').map(Number)
  // A tag may be `1.2` rather than `1.2.3`; treat the missing component as 0,
  // which is the lowest version that tag can resolve to.
  while (parts.length < 3) parts.push(0)
  return parts
}

const cmp = (a: number[], b: number[]) =>
  a[0] !== b[0]
    ? (a[0] as number) - (b[0] as number)
    : a[1] !== b[1]
      ? (a[1] as number) - (b[1] as number)
      : (a[2] as number) - (b[2] as number)

describe('the image satisfies the runtime floor the package declares', () => {
  test('the Dockerfile base is at least the declared bun engine', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      engines: { bun: string }
    }
    const declared = floorOf(pkg.engines.bun)
    const image = imageVersion(readFileSync(join(ROOT, 'Dockerfile'), 'utf8'))

    // Positive control: both were actually parsed, so the comparison below is
    // over real values rather than two empty defaults.
    expect(declared.length).toBe(3)
    expect(image.length).toBe(3)

    expect(cmp(image, declared)).toBeGreaterThanOrEqual(0)
  })
})
