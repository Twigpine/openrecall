/**
 * A stand-in for OpenRecallClient, for tool tests that need a specific server
 * refusal on demand.
 *
 * The denial matrix cannot be driven through the real harness: auth mode, quota
 * caps and the rate limiter are frozen at config import time for the whole test
 * process, so one process cannot produce a 401, a 403, a quota 413 and a 429.
 * The stub raises the exact typed error the client would raise instead.
 *
 * It is only worth anything if it stays honest about the real contract, so it
 * implements the same structural `MemoryClient` the tools take, and the
 * assignment below fails type-check the moment OpenRecallClient stops satisfying
 * that type.
 */

import {
  type OpenRecallClient,
  OpenRecallHttpError,
  type PullResult,
  type PushResult,
} from '../client/index.ts'
import type { MemoryClient } from '../src/mcp/tools.ts'

export class StubClient implements MemoryClient {
  /** Plaintext this stub pretends the server holds. */
  entries: Record<string, string> = {}
  /** Thrown by the next call to any method. Set it to render a denial. */
  error: unknown = null
  /**
   * Keys the pretend server refuses, key -> reason. A real 2xx push can store
   * nothing and list the key here, so a stub that always reports every key as
   * uploaded cannot express the case the tools have to render.
   *
   * Every configured key is reported in `skipped`, whether or not this push
   * sent it: the server also lists refused deletion keys, which never appear in
   * `entries`, so a caller must match on the key it sent rather than on
   * `skipped` being non-empty.
   */
  refuse: Record<string, string> = {}
  version = 1

  private raise() {
    if (this.error) throw this.error
  }

  async push(
    _namespace: string,
    entries: Record<string, string>,
    opts?: { deletions?: string[] },
  ): Promise<PushResult> {
    this.raise()
    const uploaded = Object.keys(entries).filter(k => !(k in this.refuse))
    const skipped = Object.entries(this.refuse).map(([key, reason]) => ({ key, reason }))
    // A refused key is stored nowhere, which is the half of the contract that
    // makes reporting it as saved a lie.
    for (const k of uploaded) this.entries[k] = entries[k] as string
    const deleted = opts?.deletions ?? []
    for (const k of deleted) delete this.entries[k]
    if (uploaded.length || deleted.length) this.version += 1
    return {
      namespace: _namespace,
      version: this.version,
      uploaded,
      unchanged: [],
      deleted,
      skipped,
    }
  }

  async pull(namespace: string): Promise<PullResult> {
    this.raise()
    return { namespace, version: this.version, entries: { ...this.entries }, updatedAt: {} }
  }

  /**
   * The same refusals the real client raises for the single-entry view: `empty`
   * when the pretend server holds nothing at all, `entry_not_found` when it
   * holds other keys but not this one.
   */
  async entry(_namespace: string, entryKey: string): Promise<string> {
    this.raise()
    if (Object.keys(this.entries).length === 0) throw httpError(404, 'empty')
    if (!Object.hasOwn(this.entries, entryKey)) throw httpError(404, 'entry_not_found')
    return this.entries[entryKey] as string
  }

  async hashes(_namespace: string): Promise<Record<string, string>> {
    this.raise()
    const out: Record<string, string> = {}
    for (const k of Object.keys(this.entries)) out[k] = `sha256:${'0'.repeat(64)}`
    return out
  }

  async delete(_namespace: string, entryKey: string): Promise<void> {
    this.raise()
    delete this.entries[entryKey]
  }
}

/** Build the typed refusal the client raises for a non-2xx response. */
export function httpError(
  status: number,
  code: string,
  details?: Record<string, unknown>,
): OpenRecallHttpError {
  const body = JSON.stringify({ error: { code, message: code, ...(details ? { details } : {}) } })
  return new OpenRecallHttpError(`openrecall ${status}: ${body}`, status, code, details)
}

/**
 * The real client must satisfy the structural type the stub implements. If it
 * drifts (a renamed method, a changed signature), this assignment is a
 * type-check error rather than a stub that silently tests a contract nobody
 * ships.
 */
export const clientSatisfiesMemoryClient: MemoryClient = null as unknown as OpenRecallClient

/**
 * The one in-memory stand-in for `OpenRecallClient`, in a plain module.
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
 * Both reached `makeTools` through an `as unknown as OpenRecallClient` cast, which
 * is what let a stub disagree with the client it stands in for. The casts are
 * gone: `makeTools` takes the structural `MemoryClient`, so tsc checks every
 * method here against `client/index.ts`.
 *
 * It exists at all because the real-server harness cannot host the cap-boundary
 * and failure-injection cases: tests/setup.ts pins MAX_ENTRIES_PER_NAMESPACE=5
 * and MAX_NAMESPACE_BYTES=5000, so a 250KB save trips the server's quota gates
 * before the tool under test is ever exercised. `pullError` injects a
 * client-layer failure into every read (`pull` and `entry` alike).
 */

export function makeStubClient(entries: Record<string, string> = {}) {
  const store = { ...entries }
  let pullError: Error | undefined
  return {
    setPullError(e: Error | undefined) {
      pullError = e
    },
    async entry(_namespace: string, entryKey: string): Promise<string> {
      if (pullError) throw pullError
      if (Object.keys(store).length === 0) throw httpError(404, 'empty')
      if (!Object.hasOwn(store, entryKey)) throw httpError(404, 'entry_not_found')
      return store[entryKey] as string
    },
    async pull(namespace: string): Promise<PullResult> {
      if (pullError) throw pullError
      // Empty, as the real client returns for a server that sends no
      // timestamps. Nothing the tools do reads it yet.
      // Version 0 for a namespace nobody has written, as on the real server: an
      // empty body at a version past zero is how the tools recognize lost data.
      return {
        namespace,
        version: Object.keys(store).length ? 1 : 0,
        entries: { ...store },
        updatedAt: {},
      }
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
