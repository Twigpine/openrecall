/**
 * Per-owner token-bucket rate limiter (in-memory — single machine, like the
 * locks in lock.ts; horizontal scale moves this to a shared store). Refills at
 * `perMinute` tokens/min up to `burst` capacity. Each request costs one token.
 *
 * Time is injected so it's deterministic to test; the server passes Date.now().
 */

import { config } from './config.ts'

type Bucket = { tokens: number; updatedAt: number }

const buckets = new Map<string, Bucket>()
const CAP = config.rateLimit.burst
const REFILL_PER_MS = config.rateLimit.perMinute / 60_000

export type RateResult = { ok: boolean; retryAfterSec: number }

/**
 * Consume one token for `owner`. Returns ok=false with a Retry-After hint when
 * the bucket is empty. `perMinute <= 0` disables limiting entirely.
 */
export function take(owner: string, now: number): RateResult {
  if (config.rateLimit.perMinute <= 0) return { ok: true, retryAfterSec: 0 }

  let b = buckets.get(owner)
  if (!b) {
    b = { tokens: CAP, updatedAt: now }
    buckets.set(owner, b)
  } else {
    const refill = (now - b.updatedAt) * REFILL_PER_MS
    if (refill > 0) {
      b.tokens = Math.min(CAP, b.tokens + refill)
      b.updatedAt = now
    }
  }

  if (b.tokens >= 1) {
    b.tokens -= 1
    return { ok: true, retryAfterSec: 0 }
  }
  // Seconds until one token is available again.
  const retryAfterSec = Math.max(1, Math.ceil((1 - b.tokens) / REFILL_PER_MS / 1000))
  return { ok: false, retryAfterSec }
}

/** Test-only: clear all buckets. */
export function _reset(): void {
  buckets.clear()
}

/**
 * Drop every bucket. Tests only: the buckets are per owner and in-process, and
 * bun shares one process across test files, so a test that deliberately
 * exhausts a bucket would otherwise refuse requests in every later suite.
 */
export function resetRateLimit(): void {
  buckets.clear()
}
