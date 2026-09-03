/**
 * Namespace and entry-key validation.
 *
 * A *namespace* is the unit of scoping/sharing (e.g. `user:abc`, `repo:owner/name`).
 * An *entry key* is a path within a namespace mirroring the memdir layout
 * (e.g. `MEMORY.md`, `feedback/testing.md`).
 *
 * Both are attacker-controlled (they come straight off the request), so they
 * are strictly validated before ever touching a storage path. This is the
 * server's port of openclaude's `validateTeamMemKey` path-traversal guard.
 */

import { sha256Hex } from './hash.ts'

export class InvalidNameError extends Error {}

// Namespaces: lowercase scope + ':' + segment(s). Conservative allowlist.
//   user:9f3a...        repo:twigpine/openrecall        agent:intern
const NAMESPACE_RE = /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9._/-]{1,128}$/

/**
 * Validate a namespace id. Throws InvalidNameError on anything suspicious.
 * Returns the namespace unchanged so it can be used inline.
 */
export function validateNamespace(ns: string): string {
  if (typeof ns !== 'string' || !NAMESPACE_RE.test(ns)) {
    throw new InvalidNameError(`invalid namespace: ${JSON.stringify(ns)}`)
  }
  if (ns.includes('..') || ns.includes('//')) {
    throw new InvalidNameError('namespace must not contain ".." or "//"')
  }
  return ns
}

// Entry keys: relative posix-ish paths. No leading slash, no traversal,
// no backslashes, no NUL, must end in a sane file segment.
const ENTRY_KEY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,254})$/

export function validateEntryKey(key: string): string {
  if (typeof key !== 'string' || !ENTRY_KEY_RE.test(key)) {
    throw new InvalidNameError(`invalid entry key: ${JSON.stringify(key)}`)
  }
  if (
    key.includes('..') ||
    key.includes('//') ||
    key.startsWith('/') ||
    key.endsWith('/') ||
    key.includes('\0') ||
    key.includes('\\')
  ) {
    throw new InvalidNameError(`unsafe entry key: ${JSON.stringify(key)}`)
  }
  return key
}

/**
 * Turn a namespace into a single flat, path-safe storage segment.
 *
 * The slug is the ONLY thing separating one tenant's `ns/<slug>/...` storage
 * (and its `ns:<slug>` write lock) from another's, so it must be injective: two
 * distinct namespaces must never share a slug. We hash the namespace with
 * sha256 — the same way entry ciphertext becomes a flat blob filename
 * (`contentPath(nsSlug, ciphertextHash)`; `entryPath` remains for entries
 * written before content addressing). sha256 is collision-resistant (finding
 * two distinct namespaces with the same slug is computationally infeasible, not
 * impossible by construction), the output is all-lowercase-hex (so
 * case-insensitive filesystems can't re-collide it), and it needs no per-grammar
 * reasoning.
 *
 * The earlier `replace(/[:/]/g, '__')` was NOT injective: it collapsed both `:`
 * and `/` to `__`, and `_` is a legal namespace char, so `user:a/b` and
 * `user:a__b` both became `user__a__b` — cross-tenant storage collision. The
 * tradeoff for hashing is opaque directory names: entry keys still live
 * (plaintext) in each manifest, and the manifest carries no namespace field, so
 * namespace→dir is one-way (sha256(ns)) and a bare `ns/<slug>/` dir can't be
 * mapped back to its namespace without a known namespace list. (The raw
 * namespace string is still recorded in the owner's own quota record,
 * `owners/<sha256(owner)>/usage.json` — not in the ns/ tree.)
 */
export function namespaceSlug(ns: string): string {
  return sha256Hex(ns)
}
