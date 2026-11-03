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
 * enough. Every request takes a cross-process lock (an atomic `mkdir`) so
 * concurrent read-modify-write cycles on a manifest can't lose updates.
 */

import { mkdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { FetchLike } from '../../client/index.ts'

/** Base URL the local transport answers to. Never leaves the process. */
export const LOCAL_ORIGIN = 'http://openrecall.local'

const LOCK_WAIT_MS = 10_000
/** A lock older than this is from a crashed process; requests take milliseconds. */
const LOCK_STALE_MS = 30_000

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function withDirLock<T>(lockDir: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      await mkdir(lockDir)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const age = await stat(lockDir).then(
        s => Date.now() - s.mtimeMs,
        () => 0, // released between our mkdir and stat — just retry
      )
      if (age > LOCK_STALE_MS) {
        await rm(lockDir, { recursive: true, force: true })
        continue
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for the local memory lock (${lockDir})`)
      }
      await sleep(10 + Math.random() * 40)
    }
  }
  try {
    return await fn()
  } finally {
    await rm(lockDir, { recursive: true, force: true })
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

  const lockDir = join(root, '.lock')
  return (input, init) => withDirLock(lockDir, () => handleRequest(new Request(input, init)))
}
