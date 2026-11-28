/**
 * Local mode across processes: several agents, one store directory.
 *
 * Each child is a `bun -e` script that builds a client the way the CLI and the
 * MCP server do (resolveSettings + makeClient) against one shared
 * OPENRECALL_HOME. The parent only orchestrates and plants lock files: the test
 * preload freezes this process's server config (5-entry caps, its own
 * DATA_DIR), so every read and write under test runs in a child whose
 * environment is scrubbed of it.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const homes: string[] = []
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true })
})

function freshHome(): string {
  const h = mkdtempSync(join(tmpdir(), 'openrecall-concurrency-'))
  homes.push(h)
  return h
}

const NS = 'user:shared'

/** The inherited environment without the test preload's server settings. */
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k, v]) =>
      v !== undefined && !/^(STORE|DATA_DIR|ALLOW_UNAUTHENTICATED|MAX_|OPENRECALL_)/.test(k),
  ),
) as Record<string, string>

const PRELUDE = `
  const { resolveSettings } = await import(process.cwd() + '/src/cli/settings.ts')
  const { makeClient } = await import(process.cwd() + '/src/cli/client.ts')
  const client = await makeClient(resolveSettings(process.env))
  const ns = ${JSON.stringify(NS)}
`

type Child = {
  /** Resolves with the first stdout line matching `re`; rejects on timeout or exit. */
  waitFor: (re: RegExp, timeoutMs?: number) => Promise<string>
  /** Every stdout line seen so far. */
  lines: () => string[]
  /** Exit code and stderr once the child is gone. */
  done: () => Promise<{ code: number; stderr: string }>
}

function spawnChild(home: string, script: string, env: Record<string, string> = {}): Child {
  const proc = Bun.spawn([process.execPath, '-e', PRELUDE + script], {
    cwd: process.cwd(),
    env: {
      ...baseEnv,
      OPENRECALL_HOME: home,
      OPENRECALL_PASSPHRASE: 'shared-passphrase',
      // The in-process server rate-limits its one local owner (120/min, burst
      // 240); a reader pulling in a tight loop is the point here, not that.
      RATE_LIMIT_PER_MINUTE: '1000000',
      RATE_LIMIT_BURST: '1000000',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stderr = new Response(proc.stderr).text()
  const seen: string[] = []
  let ended = false
  const pump = (async () => {
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        seen.push(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
      }
    }
    if (buffer) seen.push(buffer)
    ended = true
  })()
  return {
    lines: () => [...seen],
    waitFor: async (re, timeoutMs = 30_000) => {
      const until = Date.now() + timeoutMs
      for (;;) {
        const hit = seen.find(l => re.test(l))
        if (hit !== undefined) return hit
        if (ended) throw new Error(`child exited without printing ${re}: ${await stderr}`)
        if (Date.now() > until) {
          proc.kill()
          throw new Error(`timed out waiting for ${re}`)
        }
        await new Promise(r => setTimeout(r, 10))
      }
    },
    done: async () => {
      const [code, err] = await Promise.all([proc.exited, stderr])
      await pump
      return { code, stderr: err }
    },
  }
}

/** Wait for a child to exit cleanly and return its last stdout line. */
async function finish(c: Child): Promise<string> {
  const { code, stderr } = await c.done()
  expect(code, `child stderr: ${stderr}`).toBe(0)
  return c.lines().at(-1) ?? ''
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('local mode across processes', () => {
  test('three writers, ten keys each: no update is lost and the version counts every write', async () => {
    const home = freshHome()
    const writers = [0, 1, 2].map(i =>
      spawnChild(
        home,
        `
          for (let k = 0; k < 10; k++) {
            await client.push(ns, { ['w' + process.env.WRITER + '/k' + k + '.md']: 'from writer ' + process.env.WRITER + ' key ' + k })
          }
          console.log('done')
        `,
        { WRITER: String(i) },
      ),
    )
    for (const w of writers) await finish(w)

    const reader = spawnChild(
      home,
      `
        const p = await client.pull(ns)
        console.log(JSON.stringify({ version: p.version, keys: Object.keys(p.entries).sort() }))
      `,
    )
    const r = JSON.parse(await finish(reader)) as { version: number; keys: string[] }
    const expected = [0, 1, 2].flatMap(w => Array.from({ length: 10 }, (_, k) => `w${w}/k${k}.md`))
    expect(r.keys).toEqual(expected.sort())
    // Thirty mutating writes, each one a manifest version: a lost update would
    // show here as a version below the key count it somehow still reached.
    expect(r.version).toBe(30)
  }, 60_000)

  test('a reader never sees a torn namespace while a writer replaces an entry', async () => {
    const home = freshHome()
    // Stable siblings verify that the retry returns the whole namespace.
    const STABLE = 800
    await finish(
      spawnChild(
        home,
        `
          const seed = {}
          for (let i = 0; i < ${STABLE}; i++) seed['stable/' + i + '.md'] = 'stable body ' + i
          seed['hot.md'] = 'hot 0'
          await client.push(ns, seed)
          console.log('seeded')
        `,
      ),
    )

    // Pause the reader between its manifest read and its read of the hot blob. The writer commits and reclaims the old blob during that pull.
    const resume = join(home, 'replacement-complete')
    const reader = spawnChild(
      home,
      `
      const { existsSync } = await import('node:fs')
      const { getStore } = await import(process.cwd() + '/src/store/index.ts')
      const store = getStore()
      const hotHash = (await client.hashes(ns))['hot.md'].slice(7)
      const get = store.get.bind(store)
      let paused = false
      store.get = async path => {
        if (!paused && path.endsWith('/blobs/' + hotHash)) {
          paused = true
          console.log('reading')
          const until = Date.now() + 10_000
          while (!existsSync(${JSON.stringify(resume)})) {
            if (Date.now() > until) throw new Error('writer did not finish')
            await new Promise(r => setTimeout(r, 5))
          }
        }
        return get(path)
      }
      const result = await client.pull(ns)
      console.log(JSON.stringify({ count: Object.keys(result.entries).length, hot: result.entries['hot.md'] }))
    `,
    )
    await reader.waitFor(/^reading$/)
    try {
      await finish(
        spawnChild(home, `await client.push(ns, { 'hot.md': 'replacement' }); console.log('done')`),
      )
    } finally {
      writeFileSync(resume, '')
    }
    const result = JSON.parse(await finish(reader))
    expect(result).toEqual({ count: STABLE + 1, hot: 'replacement' })
  }, 60_000)

  test('a GET takes no lock: a held lock file blocks a push but not a pull', async () => {
    const home = freshHome()
    await finish(spawnChild(home, `await client.push(ns, { 'a.md': 'a' }); console.log('seeded')`))

    // What another process mid-write leaves on disk: a fresh lock file.
    const lock = join(home, 'data', '.lock')
    writeFileSync(lock, '99999 0123456789abcdef\n')
    try {
      const puller = spawnChild(
        home,
        `
          const first = Object.keys((await client.pull(ns)).entries)
          const second = Object.keys((await client.pull(ns)).entries)
          console.log(JSON.stringify({ first, second }))
        `,
      )
      const pulled = JSON.parse(await finish(puller)) as {
        first: string[]
        second: string[]
      }
      expect(pulled.first).toEqual(['a.md'])
      expect(pulled.second).toEqual(['a.md'])
      const pusher = spawnChild(
        home,
        `
          await client.hashes(ns) // a read, so it returns while the lock is held
          console.log('ready')
          await client.push(ns, { 'b.md': 'b' })
          console.log('pushed')
        `,
      )
      await pusher.waitFor(/^ready$/)
      await sleep(300)
      expect(pusher.lines()).not.toContain('pushed')
      rmSync(lock)
      await pusher.waitFor(/^pushed$/)
      await finish(pusher)
    } finally {
      rmSync(lock, { force: true })
    }

    const after = JSON.parse(
      await finish(
        spawnChild(
          home,
          `console.log(JSON.stringify(Object.keys((await client.pull(ns)).entries).sort()))`,
        ),
      ),
    ) as string[]
    expect(after).toEqual(['a.md', 'b.md'])
  }, 60_000)
})
