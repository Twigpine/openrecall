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
import { getData, getHashes, upsert } from './memory.ts'
import {
  InvalidNameError,
  namespaceSlug,
  validateEntryKey,
  validateNamespace,
} from './namespace.ts'
import { QuotaError } from './quota.ts'
import { take } from './ratelimit.ts'
import { getStore } from './store/index.ts'
import { parseUpsertRequest, StaleBaseError } from './types.ts'

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

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const { pathname } = url

  if (pathname === '/health') {
    return json({ ok: true, store: getStore().describe(), service: 'openrecall' })
  }

  const parsed = parseMemoryPath(pathname)
  if (!parsed) return apiError('not_found', 'unknown route', 404)

  const identity = await authenticate(req)
  if (!identity) return apiError('unauthorized', 'missing or invalid API key', 401)

  const rate = take(identity.owner, Date.now())
  if (!rate.ok) {
    return apiError('rate_limited', 'too many requests', 429, undefined, {
      'retry-after': String(rate.retryAfterSec),
    })
  }

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
        if (err instanceof QuotaError) {
          return apiError(err.code, err.message, 413, err.details)
        }
        if (err instanceof StaleBaseError) {
          return apiError(err.code, err.message, 409, err.details)
        }
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
      if (rawBase !== null && !/^sha256:[0-9a-f]{64}$/.test(rawBase)) {
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
        if (err instanceof QuotaError) {
          return apiError(err.code, err.message, 413, err.details)
        }
        if (err instanceof StaleBaseError) {
          return apiError(err.code, err.message, 409, err.details)
        }
        throw err
      }
    }

    return apiError('method_not_allowed', `${req.method} not supported`, 405)
  } catch (err) {
    console.error('[openrecall] handler error', err)
    return apiError('internal', 'internal error', 500)
  }
}
