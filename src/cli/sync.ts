/**
 * `openrecall sync` — bidirectional mirroring between a memory directory and
 * one namespace.
 *
 * `push` and `pull` are one-directional by design: push uploads what a
 * directory holds, pull downloads what a namespace holds. Agents that read
 * memory FILES rather than call MCP tools (Claude Code and OpenClaude memory
 * directories) change both sides at different times, and neither command can
 * reconcile that. This module does, and it is on the roadmap as
 * "Memory-directory sync" (ROADMAP.md#agent-integrations).
 *
 * The round trip is planned from the hashes view alone: deterministic
 * encryption means a locally computed ciphertext hash is the SAME hash the
 * server reports, so unchanged entries cost no transfer in either direction.
 * The pair's own state file adds the third comparison that hashes alone cannot
 * make: whether each side changed since the last sync. Without that baseline a
 * clock-skewed local mtime could overwrite newer remote content even though the
 * local bytes never changed.
 *
 * Conflict policy, deliberately conservative:
 *   - one side changed        → that side wins
 *   - both changed, timestamps say which is newer → the newer side wins
 *   - both changed, no timestamps (old server)    → NOTHING is written for
 *     that key; the report names it and the operator re-runs with
 *     `--prefer local` or `--prefer remote`. Guessing here is how a month of
 *     memory edits gets silently discarded, and the guesser never finds out.
 *   - a remote deletion is reported rather than applied automatically, because
 *     removing local files is destructive; `--prefer remote` removes them.
 *
 * Deletions are opt-in (`--prune`) and state-guarded: a remote entry is only
 * pruned when a PREVIOUS sync of this same (directory, namespace) pair saw a
 * local file for it AND the remote hash is still the one that sync recorded.
 * Without that guard, pruning would delete every entry a colleague or another
 * agent saved remotely — a mirror that destroys the very concurrency it exists
 * to serve.
 */

import { constants, watch as fsWatch } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { OpenRecallClient } from '../../client/index.ts'
import { flattenServerText } from '../../client/index.ts'
import { sha256Hex } from '../hash.ts'

/** Only markdown files mirror, matching what `push` uploads and agents keep. */
const MEMORY_EXTENSION = '.md'

/**
 * At this many pending downloads one full pull beats the equivalent number of
 * single-entry reads. Below it, `view=entry` moves exactly the bytes needed
 * and nothing else.
 */
const PULL_WHEN_DOWNLOADS_AT_LEAST = 8

/** Default quiet period that coalesces a burst of filesystem events. */
const WATCH_DEBOUNCE_MS = 500

/** Poll cadence when directory watching is unavailable or requested. */
const POLL_FALLBACK_SEC = 5

// ─── Walking a memory directory ──────────────────────────────────────────

export type MemoryFile = { key: string; path: string }

/** A directory walk plus whether it saw the whole tree. */
export type MemoryListing = { files: MemoryFile[]; complete: boolean }

/**
 * Every `.md` file under `dir`, at any depth, with `/`-separated entry keys.
 *
 * `complete` is false when the recursive listing failed. That distinction is
 * load-bearing for `--prune`: a missing root and an empty directory both
 * produce no files, but only the empty directory proves local files were
 * deleted.
 *
 * No depth cap. `push`'s walker used to stop at three path segments while
 * `pull` happily wrote files at any depth an entry key named, so a directory
 * synced down and pushed back silently DROPPED its deeper files — the
 * asymmetry a mirror cannot have. Entry keys the server accepts are what
 * decides depth, not a walker's constant.
 */
export async function listMemoryFiles(dir: string): Promise<MemoryListing> {
  let entries: string[]
  try {
    entries = await readdir(dir, { recursive: true })
  } catch {
    return { files: [], complete: false }
  }

  const files: MemoryFile[] = []
  let complete = true
  for (const rel of entries) {
    if (!rel.endsWith(MEMORY_EXTENSION)) continue
    const path = join(dir, rel)
    // A directory named `notes.md` passes the suffix test. It is not an entry,
    // and reading it would fail with EISDIR and abort the whole run.
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) {
      // A vanished file makes the listing incomplete; a directory does not.
      if (info === null) complete = false
      continue
    }
    files.push({ key: rel.split(sep).join('/'), path })
  }
  return {
    files: files.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    complete,
  }
}

/** Every `.md` file under `dir`, at any depth, with `/`-separated entry keys. */
export async function walkMemoryFiles(dir: string): Promise<MemoryFile[]> {
  return (await listMemoryFiles(dir)).files
}

/**
 * Where an entry key lands on disk, or null when following it would leave
 * `root`.
 *
 * Keys are validated before they reach the server, so a stored key cannot
 * contain `..` — but a download turns a key back into a filesystem path, and
 * the guard belongs at the boundary where that happens, not in the assumption
 * that every writer validated. A refused key is skipped and reported, never
 * written somewhere the caller did not name.
 */
export function safeJoin(root: string, key: string): string | null {
  const segments = key.split('/')
  if (segments.some(s => s === '' || s === '.' || s === '..')) return null
  const dest = resolve(root, ...segments)
  if (dest === root || !isInside(root, dest)) return null
  return dest
}

/** True when `path` is `root` itself or below it. */
function isInside(root: string, path: string): boolean {
  if (path === root) return true
  return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/**
 * Resolve a key beneath `root` without letting an existing symlink component
 * point the operation outside the mirror.
 *
 * Parent directories are created one segment at a time and re-resolved when a
 * symlink is met, so `mkdir` never follows a symlink out of the root. The
 * final component is treated according to the operation: writes refuse a
 * symlink, while removals may unlink the link itself without touching its
 * target.
 */
async function canonicalTarget(
  root: string,
  key: string,
  allowFinalSymlink: boolean,
): Promise<string | null> {
  const dest = safeJoin(root, key)
  if (dest === null) return null
  await mkdir(root, { recursive: true })
  const rootReal = await realpath(root).catch(() => null)
  if (rootReal === null) return null

  const segments = key.split('/')
  let current = rootReal
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as string
    const next = join(current, segment)
    const info = await lstat(next).then(
      value => value,
      (err: unknown) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      },
    )
    const last = i === segments.length - 1
    if (last) {
      if (info?.isSymbolicLink() && !allowFinalSymlink) return null
      if (info !== null && !info.isSymbolicLink() && !info.isFile()) return null
      return next
    }
    if (info === null) {
      await mkdir(next)
      current = next
      continue
    }
    if (info.isSymbolicLink()) {
      const real = await realpath(next).catch(() => null)
      if (real === null || !isInside(rootReal, real)) return null
      const target = await stat(real).catch(() => null)
      if (!target?.isDirectory()) return null
      current = real
      continue
    }
    if (!info.isDirectory()) return null
    current = next
  }
  return null
}

/**
 * Write a downloaded entry without following a symlink at the destination.
 *
 * `canonicalTarget` already resolves every parent and rejects a final symlink,
 * but an editor or another process can create one between that check and this
 * write. `O_NOFOLLOW` makes the final open fail instead of writing through it.
 */
async function writeDownloadedFile(path: string, plaintext: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
  )
  try {
    await handle.writeFile(plaintext, 'utf8')
  } finally {
    await handle.close()
  }
}

// ─── Planning (pure) ─────────────────────────────────────────────────────

/** A local file's deterministic ciphertext hash and its write time. */
export type LocalEntry = { hash: string; mtimeMs: number }

/** A server entry's ciphertext hash and the write time it reported, if any. */
export type RemoteEntry = { hash: string; updatedAt?: string }

/** What the previous sync of this pair recorded for each key. */
export type SyncBaselines = Record<string, string | null>

/** Why a local file is being uploaded. */
export type UploadReason = 'remote-missing' | 'local-newer' | 'prefer-local'

/** Why a remote entry is being downloaded. */
export type DownloadReason = 'local-missing' | 'remote-newer' | 'prefer-remote'

/** One planned operation for a key; `runSync` executes these in kind order. */
export type SyncAction =
  | { kind: 'upload'; key: string; reason: UploadReason }
  | { kind: 'download'; key: string; reason: DownloadReason; remoteAt: number | null }
  | { kind: 'unchanged'; key: string }
  | { kind: 'unresolved'; key: string }
  | { kind: 'prune'; key: string }
  | { kind: 'remove-local'; key: string }
  | { kind: 'remote-deleted'; key: string }

/** The full set of actions a sync plans from one metadata read. */
export type SyncPlan = { actions: SyncAction[] }

/**
 * Decide, per key, what a sync owes to do. Pure: no clock, no filesystem, no
 * network — every time value is supplied by the caller, which is what makes
 * conflict ordering testable rather than a race with `Date.now()`.
 *
 * `baselines` is the last-synced ciphertext hash per key. A side whose current
 * hash still matches it is unchanged, even when its local mtime is later than
 * the other side's write time. `null` means a legacy state entry knew the key
 * but not its hash, so neither side can be proven unchanged.
 *
 * A local key with a baseline but no remote entry is a remote deletion. It is
 * reported rather than silently re-uploaded; `--prefer local` restores it and
 * `--prefer remote` removes the local file.
 *
 * `prune` allows a remote-only key to be deleted only when its baseline hash
 * still matches the current remote hash. A newer remote write is downloaded,
 * never deleted.
 */
export function planSync(input: {
  local: Record<string, LocalEntry>
  remote: Record<string, RemoteEntry>
  prefer?: 'local' | 'remote'
  baselines?: SyncBaselines
  prune?: boolean
}): SyncPlan {
  const baselines = input.baselines ?? {}
  const keys = new Set([...Object.keys(input.local), ...Object.keys(input.remote)])
  const actions: SyncAction[] = []

  const baselineOf = (key: string): string | null | undefined =>
    Object.hasOwn(baselines, key) ? baselines[key] : undefined
  const known = (key: string): boolean => Object.hasOwn(baselines, key)
  const changed = (hash: string, baseline: string | null | undefined): boolean =>
    baseline === undefined || baseline === null || hash !== baseline

  for (const key of keys) {
    // Own properties only: a key like `constructor` must miss, never resolve
    // to something off the prototype.
    const l = Object.hasOwn(input.local, key) ? input.local[key] : undefined
    const r = Object.hasOwn(input.remote, key) ? input.remote[key] : undefined
    const baseline = baselineOf(key)

    if (l && r) {
      if (l.hash === r.hash) {
        actions.push({ kind: 'unchanged', key })
        continue
      }
      const localChanged = changed(l.hash, baseline)
      const remoteChanged = changed(r.hash, baseline)
      if (localChanged && remoteChanged) {
        if (input.prefer === 'local') {
          actions.push({ kind: 'upload', key, reason: 'prefer-local' })
          continue
        }
        if (input.prefer === 'remote') {
          actions.push({ kind: 'download', key, reason: 'prefer-remote', remoteAt: remoteTime(r) })
          continue
        }
        const remoteAt = remoteTime(r)
        if (remoteAt === null) {
          // Both sides changed and the server said nothing about when. Refuse
          // to guess; the report tells the operator which keys need a decision.
          actions.push({ kind: 'unresolved', key })
          continue
        }
        // Strictly newer wins; a tie goes to local, because an equal timestamp
        // with different content is a clock story, and the working copy is the
        // one a human can see.
        actions.push(
          remoteAt > l.mtimeMs
            ? { kind: 'download', key, reason: 'remote-newer', remoteAt }
            : { kind: 'upload', key, reason: 'local-newer' },
        )
        continue
      }
      // One side changed and the other provably did not. The changed side wins
      // regardless of the two write times: a later mtime on unchanged bytes is
      // clock skew, not evidence about content.
      if (localChanged) {
        actions.push({ kind: 'upload', key, reason: 'local-newer' })
        continue
      }
      if (remoteChanged) {
        actions.push({
          kind: 'download',
          key,
          reason: 'remote-newer',
          remoteAt: remoteTime(r),
        })
        continue
      }
      // Different hashes that both equal the baseline mean the state file is
      // inconsistent. Refuse to pick a side.
      actions.push({ kind: 'unresolved', key })
      continue
    }

    if (l) {
      if (known(key)) {
        if (input.prefer === 'local') {
          actions.push({ kind: 'upload', key, reason: 'prefer-local' })
        } else if (input.prefer === 'remote') {
          actions.push({ kind: 'remove-local', key })
        } else {
          actions.push({ kind: 'remote-deleted', key })
        }
      } else {
        actions.push({ kind: 'upload', key, reason: 'remote-missing' })
      }
      continue
    }

    if (r) {
      const canPrune =
        input.prune === true &&
        input.prefer !== 'remote' &&
        known(key) &&
        typeof baseline === 'string' &&
        baseline === r.hash
      const reason: DownloadReason =
        typeof baseline === 'string' && baseline !== r.hash ? 'remote-newer' : 'local-missing'
      actions.push(
        canPrune
          ? { kind: 'prune', key }
          : { kind: 'download', key, reason, remoteAt: remoteTime(r) },
      )
    }
  }

  return { actions }
}

/** The entry's write time as ms-since-epoch, or null when nothing says. */
function remoteTime(r: RemoteEntry): number | null {
  if (typeof r.updatedAt !== 'string') return null
  const ms = Date.parse(r.updatedAt)
  return Number.isFinite(ms) ? ms : null
}

// ─── Prune state ─────────────────────────────────────────────────────────

/** The on-disk state: per (directory, namespace) pair, per-key baselines. */
type SyncStateFile = { version: 2; pairs: Record<string, SyncBaselines> }

/** A state file with no pairs; used when the file is absent or unusable. */
const emptyState = (): SyncStateFile => ({ version: 2, pairs: {} })

/** Narrow parsed JSON to a plain object, excluding arrays and null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The state key for one (directory, namespace) pair. */
export function syncStateKey(dir: string, namespace: string): string {
  return sha256Hex(`${namespace}\n${resolve(dir)}`)
}

/**
 * Read the pair state, discarding anything that is not the shape this module
 * writes.
 *
 * Version 1 stored only key names (`string[]`). Those become baselines of
 * `null`: the pair still knows the key was local, but cannot prove either side
 * unchanged or that a remote hash is safe to prune. A damaged or foreign file
 * prunes nothing, which is the only safe fallback.
 */
async function readSyncState(path: string): Promise<SyncStateFile> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!isRecord(parsed) || (parsed.version !== 1 && parsed.version !== 2)) return emptyState()
    if (!isRecord(parsed.pairs)) return emptyState()

    const pairs: Record<string, SyncBaselines> = {}
    for (const [stateKey, raw] of Object.entries(parsed.pairs)) {
      if (Array.isArray(raw)) {
        // Legacy v1 pair state: known-local keys, hash unknown.
        if (!raw.every(k => typeof k === 'string')) continue
        const baselines: SyncBaselines = {}
        for (const key of raw) baselines[key] = null
        pairs[stateKey] = baselines
        continue
      }
      if (!isRecord(raw)) continue
      const baselines: SyncBaselines = {}
      for (const [key, hash] of Object.entries(raw)) {
        if (typeof hash === 'string' || hash === null) baselines[key] = hash
      }
      pairs[stateKey] = baselines
    }
    return { version: 2, pairs }
  } catch {
    return emptyState()
  }
}

/** Persist the pair state with owner-only permissions. */
async function writeSyncState(path: string, state: SyncStateFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

// ─── Running a sync ──────────────────────────────────────────────────────

export type SyncOptions = {
  namespace: string
  /** Force conflict resolution to one side, overriding recency. */
  prefer?: 'local' | 'remote'
  /** Delete remote entries whose local file this pair previously synced. */
  prune?: boolean
  /** Plan and report without writing files, entries or state. */
  dryRun?: boolean
  /** Where the prune state lives; omit to neither read nor write it. */
  statePath?: string
}

/** Why a planned download wrote nothing: gone, unsafe, or locally edited. */
export type DownloadSkipReason = 'vanished' | 'unsafe_key' | 'local-changed'

/** Everything one sync moved, refused, skipped, or left for the operator. */
export type SyncReport = {
  namespace: string
  dryRun: boolean
  uploaded: { key: string; reason: UploadReason }[]
  downloaded: { key: string; reason: DownloadReason }[]
  unchanged: string[]
  unresolved: string[]
  pruned: string[]
  /** Remote deletions surfaced when no preference was given. */
  remoteDeleted: string[]
  /** Local files removed because `--prefer remote` won a remote deletion. */
  removedLocal: string[]
  /** Keys the store refused, verbatim from its response. */
  skipped: { key: string; reason: string }[]
  /** Downloads that were planned but not written. */
  downloadSkipped: { key: string; reason: DownloadSkipReason }[]
}

/**
 * Sync `dir` with `opts.namespace` once and report exactly what moved.
 *
 * Ordering: downloads, then uploads, then prunes, then local removals. A prune
 * is after uploads so its "nothing local has this key anymore" decision is made
 * against the local set this sync started with, not one an in-flight download
 * was about to change.
 */
export async function runSync(
  dir: string,
  client: OpenRecallClient,
  opts: SyncOptions,
): Promise<SyncReport> {
  const root = resolve(dir)
  const ns = opts.namespace

  // Read local files once: content for hashing and uploading, mtime for
  // conflict ordering. A failed listing still yields the files it found, but
  // `complete` tells pruning not to treat the absence as local deletions.
  const listing = await listMemoryFiles(root)
  const local: Record<string, LocalEntry> = {}
  const contents: Record<string, string> = {}
  for (const f of listing.files) {
    const content = await readFile(f.path, 'utf8')
    contents[f.key] = content
    local[f.key] = {
      hash: client.ciphertextHashOf(ns, f.key, content),
      mtimeMs: (await stat(f.path)).mtimeMs,
    }
  }

  // The one metadata read that arms everything: checksums for the plan,
  // timestamps for conflicts, and the recorded observation that base-arms the
  // client's writes, so a concurrent remote change between this read and the
  // push below is refused (409) rather than silently clobbered.
  const meta = await client.metadata(ns)
  const remote: Record<string, RemoteEntry> = {}
  for (const [key, hash] of Object.entries(meta.entryChecksums)) {
    remote[key] = { hash, updatedAt: meta.entryUpdatedAt[key] }
  }

  const state = opts.statePath ? await readSyncState(opts.statePath) : undefined
  const stateKey = syncStateKey(root, ns)
  const baselines = state?.pairs[stateKey]
  const plan = planSync({
    local,
    remote,
    ...(opts.prefer ? { prefer: opts.prefer } : {}),
    ...(baselines ? { baselines } : {}),
    prune: opts.prune === true && listing.complete,
  })

  const report: SyncReport = {
    namespace: ns,
    dryRun: opts.dryRun === true,
    uploaded: [],
    downloaded: [],
    unchanged: [],
    unresolved: [],
    pruned: [],
    remoteDeleted: [],
    removedLocal: [],
    skipped: [],
    downloadSkipped: [],
  }
  for (const a of plan.actions) {
    if (a.kind === 'unchanged') report.unchanged.push(a.key)
    if (a.kind === 'unresolved') report.unresolved.push(a.key)
  }
  if (opts.dryRun) {
    for (const a of plan.actions) {
      if (a.kind === 'upload') report.uploaded.push({ key: a.key, reason: a.reason })
      if (a.kind === 'download') report.downloaded.push({ key: a.key, reason: a.reason })
      if (a.kind === 'prune') report.pruned.push(a.key)
      if (a.kind === 'remove-local') report.removedLocal.push(a.key)
      if (a.kind === 'remote-deleted') report.remoteDeleted.push(a.key)
    }
    return report
  }

  // ── Downloads ──
  const downloads = plan.actions.filter(
    (a): a is Extract<SyncAction, { kind: 'download' }> => a.kind === 'download',
  )
  const wanted = new Set(downloads.map(a => a.key))
  let bodies: Record<string, string> | undefined
  if (wanted.size >= PULL_WHEN_DOWNLOADS_AT_LEAST) {
    // observe: false keeps the base armed by metadata; a pull in the middle of
    // the sync must not replace it with a later remote observation.
    bodies = (await client.pull(ns, { observe: false })).entries
  }
  for (const a of downloads) {
    let plaintext: string | undefined
    if (bodies) {
      plaintext = Object.hasOwn(bodies, a.key) ? bodies[a.key] : undefined
    } else {
      plaintext = await client.entry(ns, a.key).then(
        v => v,
        // The entry vanished between the metadata read and this fetch — a
        // concurrent delete, which the next sync will see. Not an error.
        (err: unknown) => {
          const code = (err as { code?: string })?.code
          if (code === 'entry_not_found' || code === 'empty') return undefined
          throw err
        },
      )
    }
    if (plaintext === undefined) {
      report.downloadSkipped.push({ key: a.key, reason: 'vanished' })
      continue
    }

    const dest = await canonicalTarget(root, a.key, false)
    if (dest === null) {
      report.downloadSkipped.push({ key: a.key, reason: 'unsafe_key' })
      continue
    }

    // The plan used the local mtime from the start of this sync. If the file
    // changed while the remote fetch was in flight, writing would silently
    // discard the edit, so skip it and surface the key instead.
    const planned = Object.hasOwn(local, a.key) ? local[a.key] : undefined
    const current = await stat(dest).catch(() => null)
    const unchanged = planned
      ? current !== null && current.mtimeMs === planned.mtimeMs
      : current === null
    if (!unchanged) {
      report.downloadSkipped.push({ key: a.key, reason: 'local-changed' })
      continue
    }

    try {
      await writeDownloadedFile(dest, plaintext)
    } catch (err) {
      // A symlink created between canonicalTarget and the open. Refuse rather
      // than follow it; anything else is a real I/O failure.
      if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
        report.downloadSkipped.push({ key: a.key, reason: 'unsafe_key' })
        continue
      }
      throw err
    }

    // Adopt the server's write time so the NEXT conflict comparison has real
    // evidence rather than "whenever this sync downloaded it", which would
    // make every downloaded file look locally-newer forever.
    if (a.remoteAt !== null && Number.isFinite(a.remoteAt)) {
      const when = new Date(a.remoteAt)
      await utimes(dest, when, when).catch(() => {})
    }
    report.downloaded.push({ key: a.key, reason: a.reason })
  }

  // ── Uploads ──
  const uploads = plan.actions.filter(
    (a): a is Extract<SyncAction, { kind: 'upload' }> => a.kind === 'upload',
  )
  if (uploads.length > 0) {
    const toWrite: Record<string, string> = {}
    for (const a of uploads) toWrite[a.key] = contents[a.key] as string
    const pushed = await client.push(ns, toWrite)
    for (const a of uploads) {
      // A key the store refused is listed in `skipped` by its own response,
      // and `uploaded`/`unchanged` cannot be trusted to name it: only the
      // refusal list says a key was NOT stored.
      if ((pushed.skipped ?? []).some(s => s.key === a.key)) continue
      report.uploaded.push({ key: a.key, reason: a.reason })
    }
    report.skipped.push(...(pushed.skipped ?? []))
  }

  // ── Prunes ──
  for (const a of plan.actions) {
    if (a.kind !== 'prune') continue
    await client.delete(ns, a.key)
    report.pruned.push(a.key)
  }

  // ── Local removals (--prefer remote on a remote deletion) ──
  for (const a of plan.actions) {
    if (a.kind !== 'remove-local') continue
    const dest = await canonicalTarget(root, a.key, true)
    if (dest === null) {
      // The key is unsafe to touch; leave the file and keep reporting the
      // deletion instead of claiming it was applied.
      report.remoteDeleted.push(a.key)
      continue
    }
    await rm(dest, { force: true })
    report.removedLocal.push(a.key)
  }

  // ── Remote deletions surfaced, not applied ──
  for (const a of plan.actions) {
    if (a.kind === 'remote-deleted') report.remoteDeleted.push(a.key)
  }

  // ── State ──
  // Record each key's last-synced hash, not just its name. The hash is what
  // lets the NEXT sync tell a one-sided change from clock skew, and what makes
  // it safe to prune only a remote entry that has not changed since.
  if (opts.statePath) {
    const after = await readSyncState(opts.statePath)
    const oldPair = after.pairs[stateKey] ?? baselines ?? {}
    const nextPair: SyncBaselines = {}

    const uploaded = new Set(report.uploaded.map(u => u.key))
    const downloaded = new Set(report.downloaded.map(d => d.key))
    const unchanged = new Set(report.unchanged)
    const removedLocal = new Set(report.removedLocal)
    const pruned = new Set(report.pruned)

    for (const key of Object.keys(local)) {
      if (downloaded.has(key)) nextPair[key] = remote[key]?.hash ?? null
      else if (uploaded.has(key) || unchanged.has(key)) nextPair[key] = local[key]?.hash ?? null
      else if (removedLocal.has(key)) continue
      else if (Object.hasOwn(oldPair, key)) nextPair[key] = oldPair[key] ?? null
    }
    for (const key of Object.keys(remote)) {
      if (Object.hasOwn(local, key) || pruned.has(key)) continue
      if (downloaded.has(key)) nextPair[key] = remote[key]?.hash ?? null
      else if (Object.hasOwn(oldPair, key)) nextPair[key] = oldPair[key] ?? null
    }

    after.pairs[stateKey] = nextPair
    await writeSyncState(opts.statePath, after)
  }

  return report
}

// ─── Reporting ───────────────────────────────────────────────────────────

const UPLOAD_REASONS: Record<string, string> = {
  'remote-missing': 'new',
  'local-newer': 'local newer',
  'prefer-local': 'preferred local',
}
const DOWNLOAD_REASONS: Record<string, string> = {
  'local-missing': 'new',
  'remote-newer': 'remote newer',
  'prefer-remote': 'preferred remote',
}

/** Lines a sync prints, split so stdout stays pipeable and warnings go to stderr. */
export type SyncReportLines = { out: string[]; err: string[] }

/**
 * Format a sync report without writing to the console.
 *
 * Kept separate from the CLI so the labels are testable: download skips say
 * "not downloaded", while store refusals say "not stored". An operator reading
 * "not stored (vanished)" would look for an upload problem that never happened.
 */
export function formatSyncReport(r: SyncReport, dir: string): SyncReportLines {
  const out: string[] = []
  const err: string[] = []
  const summary = [
    `${r.uploaded.length} uploaded`,
    `${r.downloaded.length} downloaded`,
    `${r.unchanged.length} unchanged`,
  ]
  if (r.pruned.length) summary.push(`${r.pruned.length} pruned`)
  if (r.removedLocal.length) summary.push(`${r.removedLocal.length} removed locally`)
  out.push(`${r.dryRun ? 'dry run — ' : ''}sync ${r.namespace} ↔ ${dir}: ${summary.join(', ')}`)
  for (const u of r.uploaded) out.push(`  ↑ ${u.key} (${UPLOAD_REASONS[u.reason] ?? u.reason})`)
  for (const d of r.downloaded) out.push(`  ↓ ${d.key} (${DOWNLOAD_REASONS[d.reason] ?? d.reason})`)
  for (const p of r.pruned) out.push(`  ✗ ${p} pruned (deleted from the namespace)`)
  for (const p of r.removedLocal) out.push(`  ✗ ${p} removed locally (deleted remotely)`)

  for (const key of r.unresolved)
    err.push(
      `  ! ${flattenServerText(key, 300)} changed on both sides and the server reported no ` +
        'write times — nothing was written for it. Re-run with --prefer local or --prefer remote.',
    )
  for (const key of r.remoteDeleted)
    err.push(
      `  ! ${flattenServerText(key, 300)} was deleted remotely since the last sync; the local ` +
        'file was kept. Re-run with --prefer remote to remove it, or --prefer local to restore it.',
    )
  for (const x of r.downloadSkipped)
    err.push(
      `  ✗ ${flattenServerText(x.key, 300)} not downloaded ` +
        `(${flattenServerText(x.reason, 80)})`,
    )
  for (const x of r.skipped)
    err.push(`  ✗ ${flattenServerText(x.key, 300)} not stored (${flattenServerText(x.reason, 80)})`)
  return { out, err }
}

// ─── Watching for changes ────────────────────────────────────────────────

/**
 * Coalesce bursts of events into one run.
 *
 * A save in an editor is not one event — it is create, several writes, maybe
 * a rename — and a sync per event would plan from half-written files. Every
 * event pushes the run back by `ms`; only a gap that long actually fires.
 */
export function makeDebouncer(ms: number, fn: () => void): { schedule(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    schedule() {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        fn()
      }, ms)
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}

/** A running watch; `close` stops events and cancels any pending run. */
export type WatchHandle = { close(): void }

/**
 * Call `onChange` (debounced) when a `.md` file under `dir` changes.
 *
 * `intervalSec` polls instead of watching, for platforms where recursive
 * watching is unavailable or a caller prefers a fixed cadence. When watching
 * is requested but the platform refuses it, polling at
 * {@link POLL_FALLBACK_SEC} takes over rather than the watch silently dying —
 * a sync that looks alive and never runs is worse than one that polls.
 *
 * An `FSWatcher` can also emit `error` AFTER setup, which would otherwise throw
 * out of the event loop. That path closes the watcher and falls back to the
 * same poll cadence.
 */
export function watchDirectory(
  dir: string,
  onChange: () => void,
  opts: { debounceMs?: number; intervalSec?: number } = {},
): WatchHandle {
  const debouncer = makeDebouncer(opts.debounceMs ?? WATCH_DEBOUNCE_MS, onChange)
  const stoppers: (() => void)[] = [() => debouncer.cancel()]
  let polling = false

  /** Fall back to a fixed poll only once, however many failures ask for it. */
  const pollEvery = (sec: number) => {
    if (polling) return
    polling = true
    const id = setInterval(() => debouncer.schedule(), sec * 1000)
    stoppers.push(() => clearInterval(id))
  }

  if (opts.intervalSec !== undefined) {
    pollEvery(opts.intervalSec)
  } else {
    try {
      const watcher = fsWatch(dir, { recursive: true }, (_event, filename) => {
        // Filter to memory files when the platform names one; a null filename
        // is "something changed", which schedules a cheap no-op check.
        const name = typeof filename === 'string' ? filename : null
        if (name !== null && !name.endsWith(MEMORY_EXTENSION)) return
        debouncer.schedule()
      })
      watcher.on('error', () => {
        watcher.close()
        pollEvery(POLL_FALLBACK_SEC)
      })
      stoppers.push(() => watcher.close())
    } catch {
      pollEvery(POLL_FALLBACK_SEC)
    }
  }

  return {
    close() {
      for (const stop of stoppers) stop()
    },
  }
}
