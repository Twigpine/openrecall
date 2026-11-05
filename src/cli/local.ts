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
 * enough. Every write takes a cross-process lock (a file created with O_EXCL)
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
import { mkdir, open, readFile, rm, stat, unlink, utimes } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { FetchLike } from '../../client/index.ts'

/** Base URL the local transport answers to. Never leaves the process. */
export const LOCAL_ORIGIN = 'http://openrecall.local'

const LOCK_WAIT_MS = 10_000
/**
 * A lock whose mtime is older than this is from a crashed process. The holder
 * touches the file every LOCK_STALE_MS / 3 while it works, so only a holder
 * whose event loop has been blocked for the whole window can be mistaken for
 * one that died.
 */
const LOCK_STALE_MS = 30_000
const HEARTBEAT_MS = LOCK_STALE_MS / 3

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Run `fn` holding the cross-process lock at `lockPath`.
 *
 * Acquire is `open(path, 'wx')` (O_CREAT | O_EXCL): atomic on POSIX and on
 * Windows, under Bun and under Node, with no native addon. The file holds
 * `<pid> <token>` so release can tell its own lock from one another process
 * took after breaking this one as stale, and leaves the latter alone.
 *
 * The path is the same `.lock` an older version took with `mkdir`, on purpose:
 * during an upgrade a mixed pair still contends (mkdir fails EEXIST on a file,
 * 'wx' fails EEXIST on a directory), and a stale directory is broken the same
 * way as a stale file.
 */
export async function withLockFile<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const stamp = `${process.pid} ${randomBytes(8).toString('hex')}\n`
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx')
      try {
        await handle.writeFile(stamp)
      } finally {
        // Closed before anything could unlink it: Windows refuses otherwise.
        await handle.close()
      }
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const age = await stat(lockPath).then(
        s => Date.now() - s.mtimeMs,
        () => 0, // released between our open and stat — just retry
      )
      if (age > LOCK_STALE_MS) {
        // Recursive so a `.lock` directory left by an older version goes too.
        await rm(lockPath, { recursive: true, force: true })
        continue
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for the local memory lock (${lockPath})`)
      }
      await sleep(10 + Math.random() * 40)
    }
  }
  // Keep the lock young while fn runs, so a slow holder is never broken as
  // stale by a waiter. unref: a heartbeat must never keep the process alive.
  const heartbeat = setInterval(() => {
    const now = new Date()
    utimes(lockPath, now, now).catch(() => {})
  }, HEARTBEAT_MS)
  heartbeat.unref()
  try {
    return await fn()
  } finally {
    clearInterval(heartbeat)
    await release(lockPath, stamp)
  }
}

/**
 * Unlink the lock only while it still carries our stamp. If a waiter judged it
 * stale, removed it and took its place, the file is theirs now, and deleting
 * it would let a third process in beside them.
 */
async function release(lockPath: string, stamp: string): Promise<void> {
  const current = await readFile(lockPath, 'utf8').catch(() => null)
  if (current !== stamp) return
  await unlink(lockPath).catch(() => {})
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
