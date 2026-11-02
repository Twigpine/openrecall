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
import { entryPath, getStore, manifestPath } from './store/index.ts'
import {
  emptyManifest,
  type Manifest,
  type MemoryData,
  type MemoryHashes,
  type UpsertRequest,
  type UpsertResponse,
} from './types.ts'

// ─── Manifest helpers ───────────────────────────────────────────────────
async function readManifest(nsSlug: string): Promise<Manifest> {
  const raw = await getStore().get(manifestPath(nsSlug))
  if (!raw) return emptyManifest()
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as Manifest
  } catch {
    // A corrupt manifest shouldn't brick the namespace; start clean. Entry
    // blobs are still on disk and a re-push will rebuild the manifest.
    return emptyManifest()
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
  }
}

/** Full view: fetch every ciphertext entry blob. */
export async function getData(namespace: string, nsSlug: string): Promise<MemoryData> {
  const m = await readManifest(nsSlug)
  const store = getStore()
  const entries: Record<string, string> = {}
  const entryChecksums: Record<string, string> = {}

  await Promise.all(
    Object.entries(m.entries).map(async ([key, meta]) => {
      const bytes = await store.get(entryPath(nsSlug, sha256Hex(key)))
      if (!bytes) return // manifest/blob drift — skip rather than 500
      entries[key] = Buffer.from(bytes).toString('base64')
      entryChecksums[key] = meta.hash
    }),
  )

  return {
    namespace,
    version: m.version,
    lastModified: m.lastModified,
    checksum: namespaceChecksum(entryChecksums),
    content: { entries, entryChecksums },
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
    const accepted: string[] = []
    const deleted: string[] = []
    const skipped: { key: string; reason: string }[] = []
    // Defer all mutations so we can reject the whole request on a cap breach.
    const blobWrites: { path: string; bytes: Uint8Array }[] = []
    const blobDeletes: string[] = []

    // Deletions first (projected; store.delete deferred to commit).
    for (const key of req.deletions ?? []) {
      try {
        validateEntryKey(key)
      } catch {
        skipped.push({ key, reason: 'invalid_key' })
        continue
      }
      if (m.entries[key]) {
        blobDeletes.push(entryPath(nsSlug, sha256Hex(key)))
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
      blobWrites.push({ path: entryPath(nsSlug, sha256Hex(key)), bytes })
      m.entries[key] = { hash, size: bytes.byteLength, updatedAt: nowIso }
      accepted.push(key)
    }

    const mutated = blobWrites.length > 0 || blobDeletes.length > 0
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
        for (const w of blobWrites) await store.put(w.path, w.bytes)
        for (const d of blobDeletes) await store.delete(d)
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
    }

    return {
      namespace,
      version: m.version,
      checksum: namespaceChecksum(checksumsFrom(m)),
      accepted,
      deleted,
      skipped,
    }
  })
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
