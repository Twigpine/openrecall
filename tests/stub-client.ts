/**
 * The one in-memory stand-in for `MemlawbClient`, in a plain module.
 *
 * It lives here rather than inside a test file because importing it from one
 * suite into another drags that suite's side effects along: tests/mcp-tools.test.ts
 * boots a real Bun.serve in a `beforeAll`, so a file that only wanted the stub
 * was starting an HTTP server and registering another suite's cases as a
 * condition of getting it. This module imports nothing from `bun:test` and does
 * nothing at import time.
 *
 * There is one of these on purpose. It used to answer `push` with
 * `{ version, uploaded, skipped, deleted }` — a field the real `PushResult`
 * does not have, in place of `unchanged`, and without `namespace` — while a
 * second, differently-wrong stub lived in tests/recall-regression.test.ts.
 * Both reached `makeTools` through an `as unknown as MemlawbClient` cast, which
 * is what let a stub disagree with the client it stands in for. The casts are
 * gone: `makeTools` takes the structural `MemoryClient`, so tsc checks every
 * method here against `client/index.ts`.
 *
 * It exists at all because the real-server harness cannot host the cap-boundary
 * and failure-injection cases: tests/setup.ts pins MAX_ENTRIES_PER_NAMESPACE=5
 * and MAX_NAMESPACE_BYTES=5000, so a 250KB save trips the server's quota gates
 * before the tool under test is ever exercised. `pullError` injects a
 * client-layer failure.
 */

import type { PullResult, PushResult } from '../client/index.ts'

export function makeStubClient(entries: Record<string, string> = {}) {
  const store = { ...entries }
  let pullError: Error | undefined
  return {
    setPullError(e: Error | undefined) {
      pullError = e
    },
    async pull(namespace: string): Promise<PullResult> {
      if (pullError) throw pullError
      return { namespace, version: 1, entries: { ...store } }
    },
    async push(namespace: string, next: Record<string, string>): Promise<PushResult> {
      Object.assign(store, next)
      return {
        namespace,
        version: 1,
        uploaded: Object.keys(next),
        unchanged: [],
        deleted: [],
      }
    },
    async hashes(_namespace: string): Promise<Record<string, string>> {
      return Object.fromEntries(Object.keys(store).map(k => [k, 'stub-hash']))
    },
    async delete(_namespace: string, key: string): Promise<void> {
      delete store[key]
    },
  }
}
