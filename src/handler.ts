/**
 * HTTP request handler for the openrecall sync contract. Extracted from index.ts
 * so it can be unit-tested by calling handleRequest(new Request(...)) directly
 * without binding a socket.
 *
 * Routes:
 *   GET  /health
 *   GET  /api/memory/:ns               → full data (ciphertext entries)
 *   GET  /api/memory/:ns?view=hashes   → metadata + per-key checksums only
 *   PUT  /api/memory/:ns               → delta upsert (+ optional deletions)
 *   DELETE /api/memory/:ns?key=:key    → remove one entry
 *
 * `:ns` may contain a single slash (repo:owner/name), so the path is parsed
 * manually rather than with a strict router.
 */

import { authenticate, authorizeNamespace } from './auth.ts'
import { config } from './config.ts'
import { logRejection } from './log.ts'
import { getData, getHashes, upsert } from './memory.ts'
import {
  InvalidNameError,
  namespaceSlug,
  validateEntryKey,
  validateNamespace,
} from './namespace.ts'
import { QuotaError } from './quota.ts'
import { take } from './ratelimit.ts'
import { isBaseHash, parseUpsertRequest, StaleBaseError, UnreadableManifestError } from './types.ts'

// Applied to every response. The API serves only JSON and is consumed by
// programmatic clients, so we lock down sniffing/caching/referrer leakage.
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
}

function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...SECURITY_HEADERS, ...extraHeaders },
  })
}

function apiError(
  code: string,
  message: string,
  status: number,
  details?: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
) {
  return json({ error: { code, message, ...(details ? { details } : {}) } }, status, extraHeaders)
}

function parseMemoryPath(pathname: string): { namespace: string } | null {
  const prefix = '/api/memory/'
  if (!pathname.startsWith(prefix)) return null
  const rest = decodeURIComponent(pathname.slice(prefix.length))
  if (!rest) return null
  return { namespace: rest }
}

/**
 * Map the two refusals `upsert` can raise. Deliberately not folded into the
 * outer catch: that would widen these statuses to cover every read path in the
 * handler, so a future read that threw QuotaError would silently answer 413
 * instead of 500. Returns null for anything else, which the caller rethrows.
 */
function upsertFailure(err: unknown): Response | null {
  if (err instanceof QuotaError) return apiError(err.code, err.message, 413, err.details)
  if (err instanceof StaleBaseError) return apiError(err.code, err.message, 409, err.details)
  return null
}

/**
 * A namespace whose index cannot be parsed answers 503 with its own code rather
 * than a generic 500, on reads as well as writes. The refusal is right, but
 * "internal error" tells a caller to retry something no retry can fix, and
 * leaves an operator unable to tell this apart from any other server fault.
 */
function manifestFailure(err: unknown): Response | null {
  if (err instanceof UnreadableManifestError) return apiError(err.code, err.message, 503)
  return null
}

/**
 * Log every refusal from one place, after the response is built, so the code
 * recorded is literally the code the caller received and no future refusal
 * branch can be added without being covered.
 */
export async function handleRequest(req: Request): Promise<Response> {
  const ctx: RequestContext = { ...DEFAULT_CONTEXT }
  // respond() parses the path before its own try block, so a malformed percent
  // escape throws past it. Without this guard that reaches the runtime as an
  // unhandled error: no envelope, no security headers, and no log line, which
  // would make the claim above false for a request anyone can send.
  let res: Response
  try {
    res = await respond(req, ctx)
  } catch (err) {
    console.error(`[memlawb] handler error (${(err as Error)?.constructor?.name ?? 'unknown'})`)
    res = apiError('internal', 'internal error', 500)
  }
  if (res.status >= 400) {
    let code = 'unknown'
    try {
      const body = (await res.clone().json()) as { error?: { code?: string } }
      if (body.error?.code) code = body.error.code
    } catch {
      // A refusal with a non-JSON body still gets a line; the code stays unknown.
    }
    logRejection({ owner: ctx.owner, code, status: res.status, route: ctx.route })
  }
  return res
}

/** Per-request facts the rejection log needs, filled in as they become known. */
type RequestContext = { owner: string; route: string }

/**
 * What a request is assumed to be before anything is known about it. Exported
 * so the defaults are pinned somewhere: under an open-auth configuration every
 * caller authenticates, so no test driving the handler can observe them.
 */
export const DEFAULT_CONTEXT: Readonly<RequestContext> = Object.freeze({
  owner: 'anonymous',
  route: 'other',
})

/**
 * Which token bucket a request draws from: its own account when it
 * authenticated, one shared anonymous bucket when it did not. Keying everything
 * on the shared bucket would let anonymous abuse throttle real accounts; keying
 * nothing on it leaves the pre-auth refusal branches, which now write a log
 * line each, unthrottled entirely.
 */
export function bucketKey(identity: { owner: string } | null): string {
  return identity?.owner ?? 'anonymous'
}

async function respond(req: Request, ctx: RequestContext): Promise<Response> {
  const url = new URL(req.url)
  const { pathname } = url

  if (pathname === '/health') {
    return json({ ok: true, service: 'openrecall' })
  }

  const parsed = parseMemoryPath(pathname)
  if (parsed) ctx.route = 'memory'

  // Authenticate before refusing anything, so the throttle below can key on the
  // caller when there is one. Every refusal writes a log line, and the unknown
  // route and unauthorized branches used to sit ahead of the bucket entirely,
  // which let an unauthenticated caller turn a trivially cheap request into
  // unbounded log volume on the machine holding every tenant's ciphertext.
  const identity = await authenticate(req)
  ctx.owner = bucketKey(identity)

  // One shared bucket for callers who did not authenticate, their own bucket
  // for those who did, so anonymous abuse cannot throttle a real account.
  const rate = take(ctx.owner, Date.now())
  if (!rate.ok) {
    return apiError('rate_limited', 'too many requests', 429, undefined, {
      'retry-after': String(rate.retryAfterSec),
    })
  }

  if (!parsed) return apiError('not_found', 'unknown route', 404)
  if (!identity) return apiError('unauthorized', 'missing or invalid API key', 401)

  let namespace: string
  try {
    namespace = validateNamespace(parsed.namespace)
  } catch (err) {
    if (err instanceof InvalidNameError) return apiError('invalid_namespace', err.message, 400)
    throw err
  }
  if (!authorizeNamespace(identity, namespace)) {
    return apiError('forbidden', 'not permitted for this namespace', 403)
  }
  const nsSlug = namespaceSlug(namespace)

  try {
    if (req.method === 'GET') {
      if (url.searchParams.get('view') === 'hashes') {
        return json(await getHashes(namespace, nsSlug))
      }
      const data = await getData(namespace, nsSlug)
      if (data.version === 0 && Object.keys(data.content.entries).length === 0) {
        return apiError('empty', 'no memory for this namespace yet', 404)
      }
      return json(data)
    }

    if (req.method === 'PUT') {
      const len = Number(req.headers.get('content-length') ?? 0)
      if (len > config.limits.maxBodyBytes) {
        return apiError('payload_too_large', 'request body too large', 413, {
          max_bytes: config.limits.maxBodyBytes,
        })
      }
      let body: unknown
      try {
        body = await req.json()
      } catch {
        return apiError('bad_request', 'body is not valid JSON', 400)
      }
      let parsedReq: ReturnType<typeof parseUpsertRequest>
      try {
        parsedReq = parseUpsertRequest(body)
      } catch (err) {
        return apiError('bad_request', (err as Error).message, 400)
      }
      try {
        const result = await upsert(
          namespace,
          nsSlug,
          identity.owner,
          parsedReq,
          new Date().toISOString(),
        )
        return json(result)
      } catch (err) {
        const mapped = upsertFailure(err)
        if (mapped) return mapped
        throw err
      }
    }

    if (req.method === 'DELETE') {
      const key = url.searchParams.get('key')
      if (!key) return apiError('bad_request', 'DELETE requires ?key=<entryKey>', 400)
      try {
        validateEntryKey(key)
      } catch (err) {
        return apiError('invalid_key', (err as Error).message, 400)
      }
      // The base rides the query here rather than a body, so it needs its own
      // shape check: parseUpsertRequest never sees a DELETE.
      const rawBase = url.searchParams.get('base')
      if (rawBase !== null && !isBaseHash(rawBase)) {
        return apiError('bad_request', '`base` must be a sha256:<hex> hash', 400)
      }
      const base = rawBase === null ? undefined : { [key]: rawBase }
      try {
        const result = await upsert(
          namespace,
          nsSlug,
          identity.owner,
          { entries: {}, deletions: [key], base },
          new Date().toISOString(),
        )
        return json(result)
      } catch (err) {
        const mapped = upsertFailure(err)
        if (mapped) return mapped
        throw err
      }
    }

    return apiError('method_not_allowed', `${req.method} not supported`, 405)
  } catch (err) {
    const manifest = manifestFailure(err)
    if (manifest) return manifest
    // The error's class only. A store error commonly carries an endpoint, a
    // bucket and an object path, and that path carries a namespace slug.
    console.error(`[openrecall] handler error (${(err as Error)?.constructor?.name ?? 'unknown'})`)
    return apiError('internal', 'internal error', 500)
  }
}
