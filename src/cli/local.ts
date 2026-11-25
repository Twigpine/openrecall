/**
 * Local mode — memory with no server.
 *
 * The client runs the server's own request handler in-process against an fs
 * BlobStore under ~/.openrecall/data. Everything on disk is still ciphertext:
 * the client encrypts before the "request" ever reaches the handler, exactly
 * as it would over HTTP.
 *
 * Several agents (Claude Code, Zero, OpenClaude, …) each spawn their own MCP
 * process against the same directory, so the server's in-process lock is not
 * enough. Every write takes a cross-process lock (an atomically linked owner file)
 * so concurrent read-modify-write cycles on a manifest can't lose updates and
 * the reclaim sweep after a write can't delete another writer's blobs before
 * their manifest publishes them.
 *
 * Reads take no lock. A blob is written temp-then-rename, and before the
 * manifest that names it, so a reader sees a whole blob or none. The one race
 * left — a reader holding a manifest from before a write that replaced a blob
 * and reclaimed the old one — is answered by re-reading the manifest, which
 * `getData` and `getEntry` both do. Measured on a 5,000-entry store, the
 * mkdir/rm pair the old lock cost every request tripled a full read (an APFS
 * name-cache effect), and a recall is a read.
 */

import { randomBytes } from 'node:crypto'
import { link, mkdir, open, readFile, rm, stat, unlink, utimes } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { FetchLike } from '../../client/index.ts'

/** Base URL the local transport answers to. Never leaves the process. */
export const LOCAL_ORIGIN = 'http://openrecall.local'

const LOCK_WAIT_MS = 10_000
const LOCK_STALE_MS = 30_000
const REAP_GUARD_STALE_MS = 5_000
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export class LocalLockTimeout extends Error {}

/** A suspended local process still owns its lock. Only ESRCH establishes that it died. */
async function abandoned(path: string, ageMs: number): Promise<boolean> {
  const info = await stat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null
    throw err
  })
  if (!info || Date.now() - info.mtimeMs <= ageMs) return false
  const stamp = await readFile(info.isDirectory() ? join(path, 'pid') : path, 'utf8').catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return info.isDirectory() ? '' : null
      throw err
    },
  )
  if (stamp === null) return false
  const pid = Number(/^(\d+)(?:\s|$)/.exec(stamp)?.[1])
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return true
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/** Publish the complete owner stamp atomically. Readers can never observe a half-written lock. */
export async function withLockFile<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const token = randomBytes(8).toString('hex')
  const stamp = `${process.pid} ${token}\n`
  const candidate = `${path}.owner-${process.pid}-${token}`
  const deadline = Date.now() + LOCK_WAIT_MS
  const take = async <V>(target: string, ageMs: number, run: () => Promise<V>): Promise<V> => {
    for (;;) {
      try {
        await link(candidate, target)
        break
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }
      if (Date.now() >= deadline)
        throw new LocalLockTimeout(`timed out waiting for the local memory lock (${path})`)
      if (await abandoned(target, ageMs)) {
        // All reapers of this generation serialize on the same guard. A dead
        // guard is reclaimed by the same protocol, with its own guard.
        await take(`${target}.reap`, REAP_GUARD_STALE_MS, async () => {
          if (await abandoned(target, ageMs)) await rm(target, { recursive: true, force: true })
        })
      } else await sleep(10 + Math.random() * 40)
    }
    try {
      return await run()
    } finally {
      if ((await readFile(target, 'utf8').catch(() => null)) === stamp) await unlink(target)
    }
  }
  const handle = await open(candidate, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(stamp)
    } finally {
      await handle.close()
    }
    return await take(path, LOCK_STALE_MS, async () => {
      // Older versions judge by age alone. Keep the same inode fresh for them.
      const heartbeat = setInterval(() => {
        const now = new Date()
        utimes(candidate, now, now).catch(() => {})
      }, LOCK_STALE_MS / 3)
      heartbeat.unref()
      try {
        return await fn()
      } finally {
        clearInterval(heartbeat)
      }
    })
  } finally {
    await unlink(candidate).catch(() => {})
  }
}

/**
 * Build a fetch that serves the memory API in-process from `dataDir`.
 *
 * The server reads its config from the environment once, on first import, so
 * this pins the fs store + single-user mode BEFORE loading the handler, then
 * verifies the handler really is bound to `dataDir`.
 */
export async function localFetch(dataDir: string): Promise<FetchLike> {
  const root = resolve(dataDir)
  await mkdir(root, { recursive: true, mode: 0o700 })

  process.env.STORE = 'fs'
  process.env.DATA_DIR = root
  process.env.ALLOW_UNAUTHENTICATED = 'true'
  const [{ handleRequest }, { getStore }] = await Promise.all([
    import('../handler.ts'),
    import('../store/index.ts'),
  ])
  const bound = getStore().describe()
  if (bound !== `fs:${root}`) {
    throw new Error(`local mode expected store fs:${root} but the server is bound to ${bound}`)
  }

  const lockPath = join(root, '.lock')
  return (input, init) => {
    const run = () => handleRequest(new Request(input, init))
    // PUT and DELETE both reach `upsert`, the read-modify-write the lock
    // exists for. A GET reads without it (see the module comment), and so
    // does the POST of the bulk entries view, which is a read that carries
    // its key list in a body; every recall is one or both of those.
    const method = (init?.method ?? 'GET').toUpperCase()
    return method === 'PUT' || method === 'DELETE' ? withLockFile(lockPath, run) : run()
  }
}
