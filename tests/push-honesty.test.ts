/**
 * A push is only as trustworthy as its report.
 *
 * The store validates entry keys and sizes per key: it skips a bad entry and
 * still answers 200 (see `skipped` in src/memory.ts). The client must never
 * count a skipped key as uploaded, and a delete must say whether it actually
 * removed anything. These tests pin both halves of that contract against the
 * real request handler, so an agent is never told memory was saved when the
 * store stored nothing.
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { OpenRecallClient } from '../client/index.ts'
import { config } from '../src/config.ts'
import { handleRequest } from '../src/handler.ts'
import { stripFrontmatter } from '../src/mcp/frontmatter.ts'
import { makeTools } from '../src/mcp/tools.ts'

const ROOT = resolve(import.meta.dir, '..')

/** Serve the real handler in-process, exactly like local mode does. */
const client = () =>
  new OpenRecallClient({
    url: 'http://openrecall.test',
    passphrase: 'test-passphrase',
    scanMode: 'off',
    fetch: (input, init) => handleRequest(new Request(input, init)),
  })

const tools = (ns: string) => makeTools(client(), ns)

describe('push reports what the store accepted', () => {
  test('a rejected key is not uploaded and is reported with its reason', async () => {
    const ns = 'user:honesty-invalid'
    const c = client()
    const r = await c.push(ns, { '../escape.md': 'payload' })

    expect(r.uploaded).toEqual([])
    expect(r.skipped).toEqual([{ key: '../escape.md', reason: 'invalid_key' }])
    expect(r.version).toBe(0)
    expect((await c.pull(ns)).entries).toEqual({})
  })

  test('a partial push uploads the good keys and names only the bad ones', async () => {
    const ns = 'user:honesty-partial'
    const c = client()
    const r = await c.push(ns, {
      'ok.md': 'kept',
      '../escape.md': 'dropped',
      'nested/also-ok.md': 'kept too',
    })

    expect(r.uploaded.sort()).toEqual(['nested/also-ok.md', 'ok.md'])
    expect(r.skipped).toEqual([{ key: '../escape.md', reason: 'invalid_key' }])
    expect(Object.keys((await c.pull(ns)).entries).sort()).toEqual(['nested/also-ok.md', 'ok.md'])
  })

  test('an oversized entry is reported as skipped, not uploaded', async () => {
    const ns = 'user:honesty-oversized'
    const c = client()
    const tooBig = 'x'.repeat(config.limits.maxEntryBytes + 1)
    const r = await c.push(ns, { 'huge.md': tooBig })

    expect(r.uploaded).toEqual([])
    expect(r.skipped).toEqual([{ key: 'huge.md', reason: 'entry_too_large' }])
    expect((await c.pull(ns)).entries['huge.md']).toBeUndefined()
  })

  test('a rejected deletion is reported and does not count as deleted', async () => {
    const ns = 'user:honesty-deletions'
    const c = client()
    await c.push(ns, { 'keep.md': 'still here' })
    const r = await c.push(ns, {}, { deletions: ['../escape.md'] })

    expect(r.deleted).toEqual([])
    expect(r.skipped).toEqual([{ key: '../escape.md', reason: 'invalid_key' }])
    expect((await c.pull(ns)).entries['keep.md']).toBe('still here')
  })

  test('uploaded and unchanged are reported separately in one push', async () => {
    const ns = 'user:honesty-mixed'
    const c = client()
    await c.push(ns, { 'a.md': 'A' })
    const r = await c.push(ns, { 'a.md': 'A', 'b.md': 'B', '../x.md': 'X' })

    expect(r.unchanged).toEqual(['a.md'])
    expect(r.uploaded).toEqual(['b.md'])
    expect(r.skipped).toEqual([{ key: '../x.md', reason: 'invalid_key' }])
  })

  test('an own __proto__ key reaches the store and is refused there', async () => {
    // A plain `{}` used as the upload map would route this key through the
    // prototype setter, drop it from the body, and leave the client reporting
    // "unchanged" for a key the server never saw. The store must get the chance
    // to reject it.
    const ns = 'user:honesty-proto'
    const c = client()
    const entries = JSON.parse('{"__proto__":"payload"}') as Record<string, string>
    const r = await c.push(ns, entries)

    expect(r.uploaded).toEqual([])
    expect(r.skipped).toEqual([{ key: '__proto__', reason: 'invalid_key' }])
  })
})

describe('delete reports whether anything was removed', () => {
  test('deleted is true once, then false for the same key', async () => {
    const ns = 'user:honesty-delete-result'
    const c = client()
    await c.push(ns, { 'gone.md': 'bye' })

    const first = await c.delete(ns, 'gone.md')
    expect(first.deleted).toBe(true)

    const second = await c.delete(ns, 'gone.md')
    expect(second.deleted).toBe(false)
  })

  test('deleted is false for a key that was never stored', async () => {
    const c = client()
    const r = await c.delete('user:honesty-delete-missing', 'missing.md')

    expect(r.deleted).toBe(false)
    expect(r.version).toBe(0)
  })
})

describe('MCP tools never claim a write the store refused', () => {
  test('memory_save fails with the reason instead of saying "saved"', async () => {
    const ns = 'user:honesty-mcp-save'
    const r = await tools(ns).save('../escape.md', 'dropped', ns)

    expect(r.isError).toBe(true)
    expect(r.text).toContain('invalid_key')
    expect(r.text).toContain('starts with a letter or digit')
    expect(r.text).not.toContain('saved "../escape.md"')
    expect((await client().pull(ns)).entries).toEqual({})
  })

  test('memory_save still reports a normal save', async () => {
    const ns = 'user:honesty-mcp-save-ok'
    const r = await tools(ns).save('prefs.md', 'likes terse answers', ns)

    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('saved "prefs.md"')
    // The stored body is the content under the client's frontmatter stamp.
    expect(stripFrontmatter((await client().pull(ns)).entries['prefs.md'] as string)).toBe(
      'likes terse answers',
    )
  })

  test('memory_delete says nothing was deleted when the key is absent', async () => {
    const ns = 'user:honesty-mcp-delete'
    const r = await tools(ns).delete('missing.md', ns)

    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('nothing to delete')
  })

  test('memory_delete confirms a real deletion', async () => {
    const ns = 'user:honesty-mcp-delete-ok'
    const t = tools(ns)
    await t.save('gone.md', 'bye', ns)

    const r = await t.delete('gone.md', ns)
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('deleted "gone.md"')
    expect((await client().pull(ns)).entries).toEqual({})
  })
})

describe('openrecall push reports rejected entries', () => {
  test('exits non-zero and names every key the store refused', () => {
    // The CLI is where a human notices silent loss, so its exit status is part
    // of the contract: a push that stored nothing must fail the command.
    const home = mkdtempSync(join(tmpdir(), 'openrecall-push-'))
    const dir = join(home, 'memories')
    mkdirSync(dir)
    writeFileSync(join(dir, 'ok.md'), 'fine')
    writeFileSync(join(dir, '.hidden.md'), 'refused')
    writeFileSync(join(dir, '.other.md'), 'refused too')
    const env = { ...process.env } as Record<string, string | undefined>
    env.OPENRECALL_HOME = home
    env.OPENRECALL_PASSPHRASE = 'test-passphrase'
    env.OPENRECALL_SCAN = 'off'
    // Force local mode and drop inherited store settings, so an outer shell
    // cannot route this push at a remote server or a different data directory.
    env.OPENRECALL_URL = 'local'
    delete env.OPENRECALL_API_KEY
    delete env.OPENRECALL_DATA_DIR
    delete env.OPENRECALL_NAMESPACE
    // The file, when set by the outer environment, wins over the value above.
    delete env.OPENRECALL_PASSPHRASE_FILE
    try {
      const r = Bun.spawnSync(['bun', 'run', join(ROOT, 'bin/openrecall.ts'), 'push', dir], {
        env,
      })
      const output = r.stdout.toString() + r.stderr.toString()
      expect(r.exitCode).toBe(1)
      expect(output).toContain('.hidden.md')
      expect(output).toContain('.other.md')
      expect(output).toContain('invalid_key')
      expect(output).toContain('1 uploaded')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
