/**
 * The rejection log.
 *
 * Observability here is one line per refused request, and the field set is an
 * allowlist rather than a denylist. The space of things that must never appear
 * in a log on a crypto-blind server is open-ended (entry keys, raw namespaces,
 * ciphertext, tokens, whatever a future error object carries), so a denylist
 * only ever catches what someone thought to forbid. A fixed set of five fields
 * cannot carry any of it, because there is nowhere for it to go.
 *
 * A namespace slug is deliberately absent. It reads as opaque, but it is a hash
 * of a low-entropy namespace like `user:alice`, so it is a stable per-tenant
 * identifier anyone can reverse by dictionary.
 */

/** The complete set of keys a rejection line may carry. */
export const ALLOWED_FIELDS = ['timestamp', 'owner', 'code', 'status', 'route'] as const

/**
 * One refusal. The typed shape has no index signature on purpose: a field that
 * is not one of these has no way into the object, so the allowlist is enforced
 * by the compiler and not only by the test.
 */
export type Rejection = {
  timestamp: string
  /** The authenticated account, or `anonymous` before authentication. */
  owner: string
  /** The API error code already returned to the caller. */
  code: string
  status: number
  /** Route class, not the path: `memory` or `other`. Never a namespace. */
  route: string
}

type Sink = ((line: Rejection) => void) | null
let sink: Sink = null

/** Tests capture lines instead of writing them. Passing null restores stderr. */
export function setRejectionSink(next: Sink): void {
  sink = next
}

export function logRejection(fields: Omit<Rejection, 'timestamp'>): void {
  const line: Rejection = { timestamp: new Date().toISOString(), ...fields }
  if (sink) {
    sink(line)
    return
  }
  process.stderr.write(`${JSON.stringify(line)}\n`)
}
