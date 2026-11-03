/**
 * Per-owner (account) quota accounting.
 *
 * Per-namespace caps (entry count, byte size) are enforced inline in memory.ts
 * because they're computable from a single manifest. Per-OWNER caps need state
 * that spans an owner's namespaces, so we keep a small usage record in the same
 * crypto-blind BlobStore: it counts namespaces and ciphertext bytes only — no
 * plaintext, ever.
 *
 * The record is self-healing: every successful write recomputes the calling
 * namespace's contribution, so a crash between manifest-write and usage-write
 * only over/under-counts that one namespace until its next write.
 */

import { config } from './config.ts'
import { sha256Hex } from './hash.ts'
import { withLock } from './lock.ts'
import { getStore } from './store/index.ts'

export type NsUsage = { entries: number; bytes: number }
type OwnerUsage = { namespaces: Record<string, NsUsage>; updatedAt: string }

/** Thrown when a per-namespace or per-owner cap would be exceeded. → HTTP 413. */
export class QuotaError extends Error {
  readonly code: string
  readonly details: Record<string, number>
  constructor(code: string, message: string, details: Record<string, number>) {
    super(message)
    this.code = code
    this.details = details
  }
}

export function usagePath(owner: string): string {
  // Hash the owner id so the storage layout never embeds a raw (possibly
  // user-derived) identifier, matching how namespaces/entries are pathed.
  return `owners/${sha256Hex(owner)}/usage.json`
}

async function readUsage(owner: string): Promise<OwnerUsage> {
  const raw = await getStore().get(usagePath(owner))
  if (!raw) return { namespaces: {}, updatedAt: new Date(0).toISOString() }
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as OwnerUsage
  } catch {
    return { namespaces: {}, updatedAt: new Date(0).toISOString() }
  }
}

/**
 * Validate the projected usage for one namespace against the owner's caps and,
 * only if it passes, run `commit` (which writes the namespace's blobs/manifest)
 * and persist the updated usage — all under the owner lock so concurrent writes
 * to different namespaces of the same owner can't jointly bust a cap.
 *
 * Throws QuotaError (without committing) when a cap would be exceeded.
 */
export async function reserveAndCommit(
  owner: string,
  namespace: string,
  projected: NsUsage,
  nowIso: string,
  commit: () => Promise<void>,
): Promise<void> {
  await withLock(`owner:${owner}`, async () => {
    const usage = await readUsage(owner)
    const next: Record<string, NsUsage> = { ...usage.namespaces }
    if (projected.entries === 0 && projected.bytes === 0) delete next[namespace]
    else next[namespace] = projected

    const nsCount = Object.keys(next).length
    if (nsCount > config.limits.maxNamespacesPerOwner) {
      throw new QuotaError('too_many_namespaces', 'account namespace limit reached', {
        max_namespaces: config.limits.maxNamespacesPerOwner,
      })
    }
    let totalBytes = 0
    for (const u of Object.values(next)) totalBytes += u.bytes
    if (totalBytes > config.limits.maxOwnerBytes) {
      throw new QuotaError('owner_quota_exceeded', 'account storage quota exceeded', {
        max_bytes: config.limits.maxOwnerBytes,
      })
    }

    await commit()
    await getStore().put(
      usagePath(owner),
      new TextEncoder().encode(JSON.stringify({ namespaces: next, updatedAt: nowIso })),
    )
  })
}
