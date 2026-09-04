/**
 * Memory repository operations — the heart of the server.
 *
 * Reads/writes the per-namespace manifest + ciphertext entry blobs through the
 * BlobStore. Implements full-fetch, hashes-only fetch, and delta upsert. All
 * values flowing through here are ciphertext; this module cannot and does not
 * decrypt anything.
 *
 * Concurrency note: writes to a single namespace are serialized with an
 * in-process async lock so two concurrent PUTs can't clobber each other's
 * manifest update (read-modify-write). This is correct for a single instance;
 * the hosted multi-instance deployment will move the manifest to Postgres with
 * a row-level version check (see ROADMAP.md#scale). The lock is keyed by namespace so
 * unrelated namespaces never contend.
 */

import { config } from './config.ts'
import { namespaceChecksum, sha256Hex, sha256Prefixed } from './hash.ts'
import { withLock } from './lock.ts'
import { validateEntryKey } from './namespace.ts'
import { QuotaError, reserveAndCommit } from './quota.ts'
import { blobPrefix, contentPath, entryPath, getStore, manifestPath } from './store/index.ts'
import {
  emptyManifest,
  type Manifest,
  type MemoryData,
  type MemoryHashes,
  StaleBaseError,
  UnreadableManifestError,
  type UpsertRequest,
  type UpsertResponse,
} from './types.ts'

/**
 * Capabilities the hashes view advertises. Without this a client cannot tell a
 * server that enforces the write precondition from one that ignores an unknown
 * body field, so it would report a guarantee it is not getting.
 */
const SUPPORTS = ['base-precondition']

// ─── Manifest helpers ───────────────────────────────────────────────────
async function readManifest(nsSlug: string): Promise<Manifest> {
  const raw = await getStore().get(manifestPath(nsSlug))
  if (!raw) return emptyManifest()
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as Manifest
  } catch {
    // Absent and unreadable are different. Absent is a new namespace; unreadable
    // is a namespace whose index we cannot see, and starting clean there would
    // now be destructive: the commit path reclaims blobs the new manifest does
    // not reference, so an empty manifest would delete every live entry. Refuse
    // the write and let an operator look.
    throw new UnreadableManifestError()
  }
}

async function writeManifest(nsSlug: string, m: Manifest): Promise<void> {
  await getStore().put(manifestPath(nsSlug), new TextEncoder().encode(JSON.stringify(m)))
}

function checksumsFrom(m: Manifest): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, meta] of Object.entries(m.entries)) out[k] = meta.hash
  return out
}

// ─── Read paths ─────────────────────────────────────────────────────────

/** Hashes-only view: manifest metadata, no ciphertext bodies. */
export async function getHashes(namespace: string, nsSlug: string): Promise<MemoryHashes> {
  const m = await readManifest(nsSlug)
  const entryChecksums = checksumsFrom(m)
  return {
    namespace,
    version: m.version,
    lastModified: m.lastModified,
    checksum: namespaceChecksum(entryChecksums),
    entryChecksums,
    erasure: getStore().erasure,
    supports: SUPPORTS,
  }
}

/** Full view: fetch every ciphertext entry blob. */
export async function getData(namespace: string, nsSlug: string): Promise<MemoryData> {
  const m = await readManifest(nsSlug)
  const store = getStore()
  const entries: Record<string, string> = {}
  const entryChecksums: Record<string, string> = {}
  // Copied from the manifest the server already keeps, in the same pass and
  // under the same drift guard, so an entry can never be served with a
  // timestamp whose blob is missing. This is metadata the server authored
  // itself; nothing here reads or derives anything from plaintext.
  const entryUpdatedAt: Record<string, string> = {}

  await Promise.all(
    Object.entries(m.entries).map(async ([key, meta]) => {
      let bytes: Uint8Array | null = null
      try {
        bytes = (await store.get(contentPath(nsSlug, meta.hash))) ?? null
      } catch {
        // A hash that is not a digest cannot name a blob. Skip this entry the
        // same way a missing one is skipped: one unreadable entry must not take
        // the whole namespace's read down with it.
      }
      bytes ??= await store.get(entryPath(nsSlug, sha256Hex(key)))
      if (!bytes) return // manifest/blob drift — skip rather than 500
      entries[key] = Buffer.from(bytes).toString('base64')
      entryChecksums[key] = meta.hash
      entryUpdatedAt[key] = meta.updatedAt
    }),
  )

  return {
    namespace,
    version: m.version,
    lastModified: m.lastModified,
    checksum: namespaceChecksum(entryChecksums),
    erasure: store.erasure,
    content: { entries, entryChecksums, entryUpdatedAt },
  }
}

// ─── Write path ─────────────────────────────────────────────────────────

/**
 * Apply a delta upsert. Each entry value is base64 ciphertext. We:
 *   - validate the key (path traversal) and size, skipping bad entries
 *   - skip writes whose ciphertext hash already matches (true delta)
 *   - project the resulting manifest in memory and enforce per-namespace caps
 *   - enforce the per-owner quota and commit blobs+manifest atomically
 *
 * Nothing is written to the store until every cap passes, so an over-quota
 * request leaves the namespace untouched. `owner` is the authenticated account
 * (`local` for self-host open mode, which skips per-owner quotas).
 */
export async function upsert(
  namespace: string,
  nsSlug: string,
  owner: string,
  req: UpsertRequest,
  nowIso: string,
): Promise<UpsertResponse> {
  return withLock(`ns:${nsSlug}`, async () => {
    const store = getStore()
    const m = await readManifest(nsSlug)
    // The projection mutates `m.entries` in place, so capture what the currently
    // visible manifest points at before touching it; cleanup needs the old hashes.
    const prev = checksumsFrom(m)
    const touched = new Set<string>()

    // Compare the caller's base before any projection, against the manifest this
    // write would actually mutate. Every disagreeing key is collected so one
    // round trip tells the caller everything that moved under it.
    if (req.base) {
      const conflicts: Record<string, string | null> = {}
      for (const [key, expected] of Object.entries(req.base)) {
        const actual = m.entries[key]?.hash ?? null
        if (actual !== expected) conflicts[key] = actual
      }
      if (Object.keys(conflicts).length > 0) throw new StaleBaseError(conflicts)
    }

    const accepted: string[] = []
    const deleted: string[] = []
    const skipped: { key: string; reason: string }[] = []
    // Defer all mutations so we can reject the whole request on a cap breach.
    const blobWrites: { path: string; bytes: Uint8Array }[] = []

    // Deletions first (projected; store.delete deferred to commit).
    for (const key of req.deletions ?? []) {
      try {
        validateEntryKey(key)
      } catch {
        skipped.push({ key, reason: 'invalid_key' })
        continue
      }
      if (m.entries[key]) {
        touched.add(key)
        delete m.entries[key]
        deleted.push(key)
      }
    }

    // Enforce the namespace entry-count cap against the projected final size.
    const incomingNew = Object.keys(req.entries).filter(k => !(k in m.entries)).length
    if (Object.keys(m.entries).length + incomingNew > config.limits.maxEntriesPerNamespace) {
      throw new QuotaError('too_many_entries', 'namespace entry limit reached', {
        max_entries: config.limits.maxEntriesPerNamespace,
      })
    }

    for (const [key, b64] of Object.entries(req.entries)) {
      try {
        validateEntryKey(key)
      } catch {
        skipped.push({ key, reason: 'invalid_key' })
        continue
      }
      const bytes = decodeBase64(b64)
      if (!bytes) {
        skipped.push({ key, reason: 'invalid_base64' })
        continue
      }
      if (bytes.byteLength > config.limits.maxEntryBytes) {
        skipped.push({ key, reason: 'entry_too_large' })
        continue
      }
      const hash = sha256Prefixed(bytes)
      if (m.entries[key]?.hash === hash) {
        // Unchanged ciphertext — true delta, nothing to write.
        accepted.push(key)
        continue
      }
      blobWrites.push({ path: contentPath(nsSlug, hash), bytes })
      touched.add(key)
      m.entries[key] = { hash, size: bytes.byteLength, updatedAt: nowIso }
      accepted.push(key)
    }

    // Every blobWrites push is paired with a touched.add, so touched alone decides.
    const mutated = touched.size > 0
    if (mutated) {
      // Project the namespace's final footprint and enforce its byte cap.
      let nsBytes = 0
      for (const meta of Object.values(m.entries)) nsBytes += meta.size
      if (nsBytes > config.limits.maxNamespaceBytes) {
        throw new QuotaError('namespace_too_large', 'namespace storage limit reached', {
          max_bytes: config.limits.maxNamespaceBytes,
        })
      }

      const commit = async () => {
        // Blobs first, then the manifest that publishes them. A crash before
        // the manifest write leaves orphans no reader can see; a crash after it
        // leaves stale extras no reader can see. Either way the visible state is
        // consistent. Reclaim is deliberately NOT here: it runs after the write
        // is durable, because a failure to collect garbage must not fail, or
        // roll back, a write that already landed.
        for (const w of blobWrites) await store.put(w.path, w.bytes)
        m.version += 1
        m.lastModified = nowIso
        await writeManifest(nsSlug, m)
      }

      const projected = { entries: Object.keys(m.entries).length, bytes: nsBytes }
      if (owner === 'local') {
        // Self-host single user: no per-account aggregate quota.
        await commit()
      } else {
        await reserveAndCommit(owner, namespace, projected, nowIso, commit)
      }

      await reclaim(nsSlug, m, prev, touched)
    }

    return {
      namespace,
      version: m.version,
      checksum: namespaceChecksum(checksumsFrom(m)),
      erasure: store.erasure,
      accepted,
      // A key listed in both deletions and entries is projected as a delete and
      // then re-added, so reporting it in both arrays tells a client mirroring
      // `deleted` to drop a file the same response says it stored.
      deleted: deleted.filter(k => !(k in m.entries)),
      skipped,
    }
  })
}

/**
 * Delete ciphertext no visible manifest names.
 *
 * Driven by a listing rather than by the keys this request touched, because the
 * orphans that matter are the ones no key can reach: a write that died before
 * publishing left blobs the next manifest never mentions, and a delete whose
 * collection failed removed the key from the manifest, so nothing can name its
 * hash again. Sweeping the namespace's blob directory against the live hash set
 * finds both, which is what makes `erasure: 'erases'` true rather than a claim.
 *
 * Never throws. This runs after the write is durable and collects garbage that
 * is already invisible to every reader, so a store hiccup here must not turn a
 * landed write into a failure, nor skip the caller's quota accounting.
 *
 * Single-instance only, like the lock it runs under. The sweep deletes anything
 * under the namespace's blob prefix that the manifest it just wrote does not
 * name, which is correct while one process serializes every write to that
 * namespace and silent data loss the moment two do. It moves behind the same
 * row-version check as the lock when that lands (see lock.ts and PLAN §7).
 *
 * Costs one LIST per mutating write, deliberately: it replaces a delete per
 * touched key, most of which were no-ops, and it is the only way to see an
 * orphan no key can name.
 */
async function reclaim(
  nsSlug: string,
  m: Manifest,
  prev: Record<string, string>,
  touched: Set<string>,
): Promise<void> {
  try {
    const store = getStore()
    const live = new Set<string>()
    for (const meta of Object.values(m.entries)) live.add(contentPath(nsSlug, meta.hash))
    for (const path of await store.list(blobPrefix(nsSlug))) {
      if (!live.has(path)) await store.delete(path)
    }
    // Entries written before content addressing sit at a key-derived path the
    // sweep above does not cover, and only a key the pre-write manifest knew
    // can have one.
    for (const key of touched) {
      if (prev[key] !== undefined) await store.delete(entryPath(nsSlug, sha256Hex(key)))
    }
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'reclaim_failed',
        // The slug is already every storage path's own directory name, so it
        // discloses nothing new, and it is the only field that makes this line
        // actionable: without it an operator knows collection failed somewhere.
        nsSlug,
        reason: (err as Error)?.constructor?.name ?? 'unknown',
      })}\n`,
    )
  }
}

function decodeBase64(b64: string): Uint8Array | null {
  try {
    const buf = Buffer.from(b64, 'base64')
    // Round-trip guard: reject input that isn't valid base64.
    if (buf.toString('base64').replace(/=+$/, '') !== b64.replace(/=+$/, '')) return null
    return new Uint8Array(buf)
  } catch {
    return null
  }
}
