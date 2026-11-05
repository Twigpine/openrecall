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
import { logEvent } from './log.ts'
import { validateEntryKey } from './namespace.ts'
import { QuotaError, reserveAndCommit } from './quota.ts'
import { blobPrefix, contentPath, entryPath, getStore, manifestPath } from './store/index.ts'
import {
  type EntryRead,
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
const SUPPORTS = ['base-precondition', 'entry-view']

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

/**
 * One entry's ciphertext: the content-addressed blob first, then the path from
 * before content addressing. Null when neither exists (manifest/blob drift).
 * Both reads go through here so the fallback and the drift handling cannot
 * diverge between the full view and the single-entry view.
 */
async function readEntryBytes(
  store: ReturnType<typeof getStore>,
  nsSlug: string,
  key: string,
  hash: string,
): Promise<Uint8Array | null> {
  let bytes: Uint8Array | null = null
  try {
    bytes = (await store.get(contentPath(nsSlug, hash))) ?? null
  } catch {
    // A hash that is not a digest cannot name a blob. Fall through to the older
    // path, the same way a missing blob does: one unreadable entry must not take
    // the whole read down with it.
  }
  return bytes ?? (await store.get(entryPath(nsSlug, sha256Hex(key)))) ?? null
}

/** Full view: fetch every ciphertext entry blob. */
export async function getData(namespace: string, nsSlug: string): Promise<MemoryData> {
  let m = await readManifest(nsSlug)
  const store = getStore()
  // Each body is kept with the manifest row it was read under, so the checksum
  // and timestamp served for a key always describe the bytes served for it.
  const bodies = new Map<string, { bytes: Uint8Array; meta: Manifest['entries'][string] }>()

  const readKeys = async (keys: string[]): Promise<string[]> => {
    const missing: string[] = []
    await Promise.all(
      keys.map(async key => {
        const meta = m.entries[key]
        if (!meta) return
        const bytes = await readEntryBytes(store, nsSlug, key, meta.hash)
        if (bytes) bodies.set(key, { bytes, meta })
        else missing.push(key)
      }),
    )
    return missing
  }

  let missing = await readKeys(Object.keys(m.entries))
  // This read takes no namespace lock (local mode's cross-process lock covers
  // writes only), so a write that lands between the manifest read and a blob
  // read can move a key to a new hash and reclaim the old blob. As getEntry
  // does, look again with the manifest that write published before calling
  // the key drift. Bounded, so a writer that never pauses cannot starve a
  // reader; whatever is still missing after that is manifest/blob drift, and
  // one lost body must not take the whole read down with it.
  for (let pass = 0; pass < 2 && missing.length > 0; pass++) {
    const latest = await readManifest(nsSlug)
    if (latest.version === m.version) break
    m = latest
    missing = await readKeys(missing.filter(key => Object.hasOwn(m.entries, key)))
  }

  const entries: Record<string, string> = {}
  const entryChecksums: Record<string, string> = {}
  // Copied from the manifest the server already keeps, in the same pass and
  // under the same drift guard, so an entry can never be served with a
  // timestamp whose blob is missing. This is metadata the server authored
  // itself; nothing here reads or derives anything from plaintext.
  const entryUpdatedAt: Record<string, string> = {}
  for (const [key, { bytes, meta }] of bodies) {
    entries[key] = Buffer.from(bytes).toString('base64')
    entryChecksums[key] = meta.hash
    entryUpdatedAt[key] = meta.updatedAt
  }

  return {
    namespace,
    version: m.version,
    lastModified: m.lastModified,
    checksum: namespaceChecksum(entryChecksums),
    erasure: store.erasure,
    content: { entries, entryChecksums, entryUpdatedAt },
  }
}

/**
 * Bounded view: one entry's ciphertext, selected by key.
 *
 * Deliberately NOT getData filtered after the fact. The point is that the
 * store is asked for one blob, so a caller proving it can decrypt what is
 * stored pays for one entry instead of the namespace's whole 10 MB cap.
 *
 * Drift is answered, not swallowed. getData skips an entry whose body is gone
 * because one bad blob must not take a namespace-wide read down with it, and
 * the caller still gets every other entry. Here there is no other entry: the
 * same skip would return "this namespace has no such key", which is false and
 * indistinguishable from a key that was never written. So a named-but-missing
 * body is its own refusal (`unreadable`) and an operator can see it.
 */
export async function getEntry(namespace: string, nsSlug: string, key: string): Promise<EntryRead> {
  let m = await readManifest(nsSlug)
  // Own property only: a key such as `constructor` must miss, not resolve to
  // something off the prototype and then fail as an unreadable body.
  let meta = Object.hasOwn(m.entries, key) ? m.entries[key] : undefined
  if (!meta) {
    // The same test the full read uses to answer `empty`, so the two reads
    // agree on what "this namespace does not exist yet" means.
    if (m.version === 0 && Object.keys(m.entries).length === 0) return { status: 'no_namespace' }
    return { status: 'no_entry' }
  }

  const store = getStore()
  let bytes = await readEntryBytes(store, nsSlug, key, meta.hash)
  if (!bytes) {
    // This read takes no namespace lock, so a write that lands between the
    // manifest read and the blob read can move the key to a new hash. Look once
    // more before calling it drift, which tells an operator to restore a backup.
    m = await readManifest(nsSlug)
    const again = Object.hasOwn(m.entries, key) ? m.entries[key] : undefined
    if (!again) return { status: 'no_entry' }
    meta = again
    bytes = await readEntryBytes(store, nsSlug, key, meta.hash)
    if (!bytes) return { status: 'unreadable' }
  }

  return {
    status: 'ok',
    entry: {
      namespace,
      version: m.version,
      lastModified: m.lastModified,
      erasure: store.erasure,
      key,
      entry: Buffer.from(bytes).toString('base64'),
      entryChecksum: meta.hash,
    },
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
      // Object.hasOwn, not truthiness: `m.entries[key]` resolves inherited
      // names like `constructor` from Object.prototype, which would report a
      // deletion (and bump the version) for a key that was never stored.
      if (Object.hasOwn(m.entries, key)) {
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
      deleted: deleted.filter(k => !Object.hasOwn(m.entries, k)),
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
    // The slug is what makes this actionable: without it an operator only knows
    // collection failed somewhere. It is already every storage path's own
    // directory name, so it discloses nothing a reader of the store lacks.
    logEvent({
      event: 'reclaim_failed',
      nsSlug,
      reason: (err as Error)?.constructor?.name ?? 'unknown',
    })
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
