/**
 * In-process keyed async lock — serializes read-modify-write critical sections
 * by string key. Correct for a SINGLE server instance; the hosted beta runs one
 * machine (fly.toml `min_machines_running = 1`) deliberately for this reason.
 * Horizontal scale moves these invariants to Postgres row-version checks
 * (ROADMAP.md#scale); do not scale out before that lands.
 *
 * Shared by the namespace write path (`ns:<slug>`) and the per-owner quota
 * accounting (`owner:<id>`). Always acquire in a consistent order (ns then
 * owner) to stay deadlock-free.
 */

const locks = new Map<string, Promise<unknown>>()

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>(r => (release = r))
  locks.set(
    key,
    prev.then(() => next),
  )
  await prev.catch(() => {}) // wait our turn; ignore prior errors
  try {
    return await fn()
  } finally {
    release()
    // Clean up if we're the tail of the chain to avoid unbounded growth.
    if (locks.get(key) === next) locks.delete(key)
  }
}
