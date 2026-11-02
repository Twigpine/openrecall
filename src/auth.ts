/**
 * Authentication — resolve a request's Bearer token to an owner id.
 *
 * Three modes, checked in order:
 *   1. ALLOW_UNAUTHENTICATED=true  → everything maps to owner "local" (self-host single user)
 *   2. STATIC_API_KEYS="owner:key,..." → in-memory map (self-host, no DB)
 *   3. Supabase lookup by sha256(token) → owner = user_id (hosted)
 *
 * The owner id namespaces a user's memory: a token for owner X can only touch
 * namespaces prefixed `user:X` (and any namespace it's explicitly granted —
 * ACLs land in a later phase). Auth concerns identity only; it never gets
 * near memory plaintext, which is encrypted client-side regardless.
 */

import { createHash } from 'node:crypto'
import { config } from './config.ts'

export type Identity = { owner: string }

// ─── Static key map (mode 2) ────────────────────────────────────────────
const staticKeys = new Map<string, string>() // token -> owner
for (const pair of config.auth.staticApiKeys.split(',')) {
  const t = pair.trim()
  if (!t) continue
  const idx = t.indexOf(':')
  if (idx <= 0) continue
  staticKeys.set(t.slice(idx + 1).trim(), t.slice(0, idx).trim())
}

// ─── Supabase lookup cache (mode 3) ─────────────────────────────────────
type CacheEntry = { value: string | null; expiresAt: number }
const cache = new Map<string, CacheEntry>()
const TTL_MS = Number(process.env.AUTH_CACHE_TTL_MS ?? 60_000)
const NEG_TTL_MS = Number(process.env.AUTH_CACHE_NEGATIVE_TTL_MS ?? 30_000)
const CACHE_MAX = Number(process.env.AUTH_CACHE_MAX ?? 5_000)

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function supabaseEnabled(): boolean {
  return config.auth.supabaseUrl.length > 0 && config.auth.supabaseSecretKey.length > 0
}

async function lookupSupabase(token: string): Promise<string | null> {
  const keyHash = hashToken(token)
  const now = Date.now()
  const hit = cache.get(keyHash)
  if (hit && hit.expiresAt > now) return hit.value

  const url =
    `${config.auth.supabaseUrl}/rest/v1/openrecall_api_keys` +
    `?select=owner_id&key_hash=eq.${keyHash}&revoked_at=is.null&limit=1`
  let owner: string | null = null
  try {
    const res = await fetch(url, {
      headers: {
        apikey: config.auth.supabaseSecretKey,
        authorization: `Bearer ${config.auth.supabaseSecretKey}`,
      },
    })
    if (res.ok) {
      const rows = (await res.json()) as { owner_id?: string }[]
      owner = rows[0]?.owner_id ?? null
    }
  } catch {
    // Network blip: fall through to cache miss (null). Don't hard-fail auth on
    // a transient — but also don't grant access; caller returns 401/503.
    owner = null
  }

  if (cache.size >= CACHE_MAX) {
    // Drop oldest 10% (Map preserves insertion order).
    let drop = Math.max(1, Math.floor(CACHE_MAX / 10))
    for (const k of cache.keys()) {
      cache.delete(k)
      if (--drop <= 0) break
    }
  }
  cache.set(keyHash, { value: owner, expiresAt: now + (owner ? TTL_MS : NEG_TTL_MS) })
  return owner
}

/** Extract the Bearer token from a request, if any. */
export function bearerToken(req: Request): string | null {
  const h = req.headers.get('authorization') ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(h.trim())
  return m ? m[1].trim() : null
}

/**
 * Resolve the caller's identity, or null if unauthenticated/invalid.
 */
export async function authenticate(req: Request): Promise<Identity | null> {
  if (config.auth.allowUnauthenticated) return { owner: 'local' }

  const token = bearerToken(req)
  if (!token) return null

  const staticOwner = staticKeys.get(token)
  if (staticOwner) return { owner: staticOwner }

  if (supabaseEnabled()) {
    const owner = await lookupSupabase(token)
    if (owner) return { owner }
  }
  return null
}

/**
 * Authorize an identity against a namespace.
 *
 * SECURITY: this is the only thing standing between tenants. It must be an
 * EXACT match, never a substring test — an earlier `namespace.includes(owner)`
 * rule let owner "ab" reach `repo:lab/...` or any namespace that merely
 * contained the owner id as a substring. The rule now is strict:
 *
 *   - `local` (ALLOW_UNAUTHENTICATED self-host) owns everything.
 *   - every other owner controls exactly their own `user:<owner>` subtree:
 *     `user:<owner>` itself and `user:<owner>/...` children, nothing else.
 *   - any other namespace (repo:/agent:/another user) requires an explicit ACL
 *     grant. Sharing/ACLs land in a later phase (PLAN §7); until then
 *     `hasAclGrant` is a closed door, so cross-tenant access is impossible.
 *
 * The owner segment is compared as a whole path segment (terminated by end-of-
 * string or `/`), so `user:ab` can never match `user:abc`.
 */
export function authorizeNamespace(id: Identity, namespace: string): boolean {
  if (id.owner === 'local') return true // self-host single user, open mode
  const root = `user:${id.owner}`
  if (namespace === root || namespace.startsWith(`${root}/`)) return true
  return hasAclGrant(id, namespace)
}

/**
 * ACL grant hook. v0.1 has no sharing, so this is a hard `false` — the single
 * place to wire namespace ACLs (repo/team membership, shared namespaces) when
 * they ship, without loosening the strict owner-subtree rule above.
 */
function hasAclGrant(_id: Identity, _namespace: string): boolean {
  return false
}
