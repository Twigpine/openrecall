/**
 * HTTP request handler for the openrecall sync contract. Extracted from index.ts
 * so it can be unit-tested by calling handleRequest(new Request(...)) directly
 * without binding a socket.
 *
 * Routes:
 *   GET|HEAD /health
 *   GET|HEAD /api/memory/:ns               → full data (ciphertext entries)
 *   GET|HEAD /api/memory/:ns?view=hashes   → metadata + per-key checksums only
 *   GET|HEAD /api/memory/:ns?view=entry&key=:key → ONE entry's ciphertext
 *   POST     /api/memory/:ns?view=entries      → the ciphertext of the keys in the body
 *                                            `{ keys: string[] }`, as binary frames
 *   PUT      /api/memory/:ns               → delta upsert (+ optional deletions)
 *   DELETE   /api/memory/:ns?key=:key      → remove one entry
 *
 * Every other method on a known route is a 405 with an `Allow` header. A
 * malformed percent-escape in the path is a 400, not a 500.
 *
 * `view=entries` is the bulk read an incremental pull makes for the keys whose
 * hash moved since it last looked. It is a POST with a `view` query rather
 * than a GET or a path suffix because two thousand keys overflow a URL, and a
 * namespace may contain `/`, so a key after it would be ambiguous. The body
 * answers `application/octet-stream` in the frame layout src/frames.ts
 * documents, with `x-openrecall-frames: 1` so a client can tell it from a
 * JSON answer, and one status per key (`ok`, `not_found`, `unreadable`,
 * `invalid_key`) in place of per-request refusals. Its request-level refusals:
 *   404 empty             → no such namespace, as the other reads
 *   400 bad_request       → no `keys` array, or none, or more than the entry cap
 *   413 payload_too_large → the same body cap the PUT has
 *
 * `view=entry` is the bounded read. Proving a passphrase decrypts what is
 * stored needs one entry, and before it the only read returning ciphertext was
 * the full one, so that proof cost a namespace-sized transfer (capped at 2000
 * entries / 10 MB, roughly 13 MB of base64) on every startup. Its refusals are
 * deliberately distinct, because a client cannot act on a denial it cannot
 * name:
 *   404 empty             → no such namespace (same code the full read gives)
 *   404 entry_not_found   → namespace exists, this key does not
 *   503 entry_unreadable  → the manifest names the key, the store has no body
 *   400 invalid_key       → the key failed validateEntryKey
 *   400 bad_request       → no ?key= at all
 *
 * `:ns` may contain a single slash (repo:owner/name), so the path is parsed
 * manually rather than with a strict router.
 */

import { authenticate, authorizeNamespace } from './auth.ts'
import { config } from './config.ts'
import { encodeFrames, FRAMES_HEADER } from './frames.ts'
import { logRejection } from './log.ts'
import { getData, getEntries, getEntry, getHashes, upsert } from './memory.ts'
import {
  InvalidNameError,
  namespaceSlug,
  validateEntryKey,
  validateNamespace,
} from './namespace.ts'
import { QuotaError } from './quota.ts'
import { take } from './ratelimit.ts'
import {
  isBaseHash,
  parseEntriesRequest,
  parseUpsertRequest,
  StaleBaseError,
  UnreadableManifestError,
} from './types.ts'

// Applied to every response. The API serves JSON, and binary frames on one
// route, to programmatic clients only, so we lock down sniffing/caching/referrer
// leakage.
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
}

const UTF8 = new TextEncoder()

function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  const payload = JSON.stringify(body)
  return new Response(payload, {
    status,
    headers: {
      // Declared, not inferred: a bodyless Response (which is what HEAD sends)
      // is measured as zero bytes, so without this every HEAD would claim the
      // representation is empty while a GET of the same route returns a body.
      'content-length': String(UTF8.encode(payload).byteLength),
      'content-type': 'application/json',
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
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

const HEALTH_METHODS = 'GET, HEAD'
const MEMORY_METHODS = 'GET, HEAD, POST, PUT, DELETE'

function methodNotAllowed(method: string, allow: string): Response {
  return apiError(
    'method_not_allowed',
    `${method} is not supported on this route`,
    405,
    undefined,
    {
      allow,
    },
  )
}

/**
 * Strip the body for HEAD. Probes (`curl -I`, uptime checks, proxies) must see
 * the same status and headers a GET would produce, without a payload. The
 * `content-length` `json()` already declared rides along with the copied
 * headers, so HEAD reports the size of the representation rather than the zero
 * a bodyless `Response` would otherwise be measured as.
 */
function withoutBody(res: Response): Response {
  return new Response(null, { status: res.status, headers: res.headers })
}

type MemoryPath = { namespace: string } | { malformed: true }

/**
 * Parse `/api/memory/:ns`. The namespace may contain one slash
 * (`repo:owner/name`), so the path is split by hand rather than by a router.
 * A malformed percent-escape is client input, not a server fault: report it as
 * `malformed` (→ 400) instead of letting `URIError` escape as a 500.
 */
function parseMemoryPath(pathname: string): MemoryPath | null {
  const prefix = '/api/memory/'
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length)
  if (!rest) return null
  try {
    return { namespace: decodeURIComponent(rest) }
  } catch {
    return { malformed: true }
  }
}

/**
 * `content-length` as declared by the client, or null when absent. The runtime
 * already caps the real body (`maxRequestBodySize`), so this check is only the
 * friendly early-out — but a bogus header must not silently disable it.
 */
function declaredBodyBytes(req: Request): number | null | 'invalid' {
  const header = req.headers.get('content-length')
  if (header === null) return null
  const value = header.trim()
  if (!/^\d+$/.test(value)) return 'invalid'
  const bytes = Number(value)
  return Number.isSafeInteger(bytes) ? bytes : 'invalid'
}

function healthResponse(): Response {
  return json({ ok: true, service: 'openrecall' })
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
  // Last-resort envelope: an unexpected throw becomes a JSON 500 with security
  // headers and a rejection log line, rather than reaching the runtime bare.
  let res: Response
  try {
    res = await respond(req, ctx)
  } catch (err) {
    console.error(`[openrecall] handler error (${(err as Error)?.constructor?.name ?? 'unknown'})`)
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
  // Strip the body only after the log has read the error code. Doing it inside
  // respond() would make every HEAD refusal log `unknown`, because
  // handleRequest parses a clone of the response body to name the code.
  return req.method === 'HEAD' ? withoutBody(res) : res
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

  // Health is unauthenticated liveness. GET/HEAD bypass auth and the shared
  // bucket; other verbs fall through to the throttle below, so a method probe
  // cannot write unbounded rejection lines.
  const isHealth = pathname === '/health'
  if (isHealth && (req.method === 'GET' || req.method === 'HEAD')) return healthResponse()

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

  if (isHealth) return methodNotAllowed(req.method, HEALTH_METHODS)
  if (!parsed) return apiError('not_found', 'unknown route', 404)
  if ('malformed' in parsed) {
    return apiError('invalid_path', 'path is not valid percent-encoding', 400)
  }
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
    if (req.method === 'GET' || req.method === 'HEAD') {
      const read = async (): Promise<Response> => {
        const view = url.searchParams.get('view')
        if (view === 'hashes') {
          return json(await getHashes(namespace, nsSlug))
        }
        if (view === 'entry') {
          // Reached only after authorizeNamespace above, like every other branch
          // here. The key is attacker-controlled, so it is validated before it
          // can reach a storage path, exactly as the DELETE branch does.
          const key = url.searchParams.get('key')
          if (!key) return apiError('bad_request', 'view=entry requires ?key=<entryKey>', 400)
          try {
            validateEntryKey(key)
          } catch (err) {
            return apiError('invalid_key', (err as Error).message, 400)
          }
          const found = await getEntry(namespace, nsSlug, key)
          if (found.status === 'no_namespace') {
            return apiError('empty', 'no memory for this namespace yet', 404)
          }
          if (found.status === 'no_entry') {
            return apiError('entry_not_found', 'no such entry in this namespace', 404)
          }
          if (found.status === 'unreadable') {
            // The manifest names this key and the store cannot produce its body.
            // Not a 404: the entry is not absent, it is unserveable, and a client
            // told "not found" would conclude the memory was never written.
            return apiError('entry_unreadable', 'entry body is missing from the store', 503)
          }
          return json(found.entry)
        }
        const data = await getData(namespace, nsSlug)
        if (data.version === 0 && Object.keys(data.content.entries).length === 0) {
          return apiError('empty', 'no memory for this namespace yet', 404)
        }
        return json(data)
      }
      // await, not return: the rejection must be caught by this try block so a
      // corrupt manifest maps to 503 rather than escaping as a 500.
      return await read()
    }

    if (req.method === 'POST') {
      if (url.searchParams.get('view') !== 'entries') {
        return apiError('method_not_allowed', 'POST supports only ?view=entries', 405, undefined, {
          allow: MEMORY_METHODS,
        })
      }
      const declared = declaredBodyBytes(req)
      if (declared === 'invalid') {
        return apiError('bad_request', 'invalid content-length header', 400)
      }
      if (declared !== null && declared > config.limits.maxBodyBytes) {
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
      let keys: string[]
      try {
        keys = parseEntriesRequest(body)
      } catch (err) {
        return apiError('bad_request', (err as Error).message, 400)
      }
      // Bounded by the same cap a namespace is, since no namespace can hold
      // more keys than that and a request naming more is asking for work the
      // manifest cannot have. Each key's own validity is a per-frame status.
      const max = config.limits.maxEntriesPerNamespace
      if (keys.length === 0 || keys.length > max) {
        return apiError('bad_request', `\`keys\` must name between 1 and ${max} entries`, 400, {
          max_keys: max,
        })
      }
      const found = await getEntries(namespace, nsSlug, keys)
      if (found.status === 'no_namespace') {
        return apiError('empty', 'no memory for this namespace yet', 404)
      }
      const frames = encodeFrames(found.header, found.frames)
      // A Uint8Array is a BodyInit at runtime; the DOM typing of typed arrays
      // under TS 5.7 is what the cast is for, not the value.
      return new Response(frames as unknown as BodyInit, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          [FRAMES_HEADER]: '1',
          ...SECURITY_HEADERS,
        },
      })
    }

    if (req.method === 'PUT') {
      const declared = declaredBodyBytes(req)
      if (declared === 'invalid') {
        return apiError('bad_request', 'invalid content-length header', 400)
      }
      if (declared !== null && declared > config.limits.maxBodyBytes) {
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

    return methodNotAllowed(req.method, MEMORY_METHODS)
  } catch (err) {
    const manifest = manifestFailure(err)
    if (manifest) return manifest
    // The error's class only. A store error commonly carries an endpoint, a
    // bucket and an object path, and that path carries a namespace slug.
    console.error(`[openrecall] handler error (${(err as Error)?.constructor?.name ?? 'unknown'})`)
    return apiError('internal', 'internal error', 500)
  }
}
