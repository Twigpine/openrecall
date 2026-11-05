/**
 * The frame codec exists twice (src/frames.ts for the server, client/frames.ts
 * for the client) because the import boundary forbids sharing it. Two copies
 * can drift, so this pins that they are the same bytes, that what the server
 * copy encodes the client copy decodes, and that the client copy as shipped
 * (dist/client/frames.js, plain ESM) does the same under Node, which is what
 * a library consumer runs. Needs `bun run build` first for the Node half, as
 * CI does through `verify`; it skips that half otherwise, as the stdio suite
 * does for dist/openrecall.js.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { decodeFrames as decodeClient, FrameFormatError } from '../client/frames.ts'
import { encodeFrames, type Frame, type FramesHeader } from '../src/frames.ts'

const REPO_ROOT = resolve(import.meta.dir, '..')
const DIST = join(REPO_ROOT, 'dist/client/frames.js')
const NODE = Bun.which('node')

const header: FramesHeader = {
  namespace: 'user:cross',
  version: 7,
  lastModified: '2026-09-04T00:00:00.000Z',
  erasure: 'erases',
  count: 3,
}
const frames: Frame[] = [
  {
    meta: {
      key: 'a.md',
      hash: `sha256:${'ab'.repeat(32)}`,
      size: 5,
      updatedAt: '2026-09-04T00:00:00.000Z',
      status: 'ok',
    },
    bytes: new Uint8Array([0, 1, 2, 255, 128]),
  },
  {
    meta: { key: 'b.md', hash: null, size: 0, updatedAt: null, status: 'not_found' },
    bytes: new Uint8Array(0),
  },
  {
    meta: {
      key: 'ünï/cødé.md',
      hash: `sha256:${'cd'.repeat(32)}`,
      size: 0,
      updatedAt: null,
      status: 'unreadable',
    },
    bytes: new Uint8Array(0),
  },
]
const encoded = encodeFrames(header, frames)

describe('the frame codec, both copies', () => {
  test('the two source files are byte-identical', () => {
    expect(readFileSync(join(REPO_ROOT, 'src/frames.ts'), 'utf8')).toBe(
      readFileSync(join(REPO_ROOT, 'client/frames.ts'), 'utf8'),
    )
  })

  test('what the server copy encodes, the client copy decodes, under Bun', () => {
    const d = decodeClient(encoded)
    expect(d.header).toEqual(header)
    expect(d.frames.map(f => f.meta)).toEqual(frames.map(f => f.meta))
    expect([...(d.frames[0]?.bytes ?? [])]).toEqual([0, 1, 2, 255, 128])
    expect(() => decodeClient(encoded.subarray(0, encoded.length - 3))).toThrow(FrameFormatError)
  })

  test.skipIf(!existsSync(DIST) || !NODE)(
    'and the shipped client copy does the same under Node',
    () => {
      const script = `
      const { decodeFrames } = await import(${JSON.stringify(DIST)})
      const buf = Buffer.from(${JSON.stringify(Buffer.from(encoded).toString('hex'))}, 'hex')
      const d = decodeFrames(new Uint8Array(buf))
      let truncated = null
      try { decodeFrames(new Uint8Array(buf.subarray(0, buf.length - 3))) } catch (e) { truncated = e.name }
      console.log(JSON.stringify({ header: d.header, metas: d.frames.map(f => f.meta), first: [...d.frames[0].bytes], truncated }))
    `
      const r = Bun.spawnSync([NODE as string, '--input-type=module', '-e', script], {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(`${r.exitCode}: ${r.stderr.toString()}`).toBe('0: ')
      const got = JSON.parse(r.stdout.toString().trim()) as {
        header: FramesHeader
        metas: Frame['meta'][]
        first: number[]
        truncated: string | null
      }
      expect(got.header).toEqual(header)
      expect(got.metas).toEqual(frames.map(f => f.meta))
      expect(got.first).toEqual([0, 1, 2, 255, 128])
      expect(got.truncated).toBe('FrameFormatError')
    },
  )
})
