/**
 * Startup store probe.
 *
 * `/health` is unauthenticated, so it reports liveness and nothing else: a
 * store round trip there would be an anonymous write against the store holding
 * every tenant's ciphertext, and its description would leak whatever the driver
 * labels itself with. Reachability is still worth knowing, so it is checked once
 * at startup, before the socket binds, where an operator sees the result and a
 * broken store keeps the process from serving at all.
 *
 * The probe writes under its own prefix. Tenant data lives under `ns/` and
 * `owners/`, so nothing a tenant can address collides with it.
 */

import { randomUUID } from 'node:crypto'
import { getStore } from './index.ts'

/** Reserved for the probe. Disjoint from every tenant path prefix. */
export const PROBE_PREFIX = 'probe/'

export type ProbeResult = { ok: boolean; detail?: string }

/**
 * Write, read back, compare, and remove one object. Returns rather than throws
 * so the caller decides what a failure means. The failure detail is the error's
 * class, never its message: a store error commonly carries an endpoint, a
 * bucket and an object path, and that path carries a namespace slug.
 */
export async function probeStore(): Promise<ProbeResult> {
  const store = getStore()
  const path = `${PROBE_PREFIX}${randomUUID()}`
  const payload = new TextEncoder().encode(randomUUID())
  try {
    await store.put(path, payload)
    const read = await store.get(path)
    if (!read || Buffer.compare(Buffer.from(read), Buffer.from(payload)) !== 0) {
      return { ok: false, detail: 'store round trip returned different bytes' }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, detail: `store unreachable (${(err as Error).constructor.name})` }
  } finally {
    await store.delete(path).catch(() => {})
  }
}
