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

import { randomUUID } from 'node:crypto'
import { constants, type Dirent, watch as fsWatch } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { OpenRecallClient } from '../../client/index.ts'
import { flattenServerText } from '../../client/index.ts'
import { sha256Hex } from '../hash.ts'
import { withDirLock } from './local.ts'

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
 *
 * Symlinks are deliberately not memory files. A link inside the mirror can
 * point anywhere on disk, so following one would upload or re-encrypt content
 * the caller never named as part of this directory. The walk therefore checks
 * each entry with `readdir`'s own type information (which does not follow
 * links) and never descends into a symlinked directory.
 */
export async function listMemoryFiles(dir: string): Promise<MemoryListing> {
  const files: MemoryFile[] = []
  let complete = true
  const pending: { path: string; prefix: string }[] = [{ path: dir, prefix: '' }]

  while (pending.length > 0) {
    const current = pending.pop() as { path: string; prefix: string }
    let entries: Dirent[]
    try {
      entries = await readdir(current.path, { withFileTypes: true })
    } catch {
      // A missing root and an unreadable subdirectory both mean the walk did
      // not see the whole tree.
      complete = false
      continue
    }
    for (const entry of entries) {
      const key = current.prefix === '' ? entry.name : `${current.prefix}/${entry.name}`
      const path = join(current.path, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        pending.push({ path, prefix: key })
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(MEMORY_EXTENSION)) continue
      files.push({ key, path })
    }
  }

  return {
    files: files.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    complete,
  }
}

/** A memory file's text and the mtime observed before it was read. */
export type MemoryFileContents = { content: string; mtimeMs: number }

/** An Error carrying a filesystem-style code callers can branch on. */
function readError(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

/**
 * The device/inode identity of an opened file, compared with `bigint` stats.
 *
 * Numeric `dev`/`ino` values can exceed JavaScript's safe integer range on
 * some filesystems, where two different files could compare equal. Both sides
 * of every identity check therefore come from `{ bigint: true }` stats. The
 * mtime used for conflict ordering stays the plain stat's `mtimeMs`: dividing
 * `mtimeNs` back down loses the last bit of double precision (e.g.
 * `1794939965106` becomes `1794939965105.9998`), which would make the same
 * file's timestamp compare unequal to the one `stat()` reports elsewhere.
 */
type FileIdentity = { dev: bigint; ino: bigint }

/**
 * Require `path` to still name the descriptor opened as `opened`, inside
 * `rootReal`.
 *
 * `O_NOFOLLOW` protects only the final component, so a parent directory can be
 * swapped for a symlink after the open. Re-resolving the whole path closes that
 * gap: `EOUTSIDE` when it left the mirror, `ECHANGED` when it stayed inside but
 * now names a different file, `ENOENT` when it vanished. Callers must run this
 * before reading from or writing to the descriptor.
 */
async function verifyOpenedPath(
  rootReal: string,
  path: string,
  opened: FileIdentity,
): Promise<void> {
  const resolved = await realpath(path).catch(() => null)
  if (resolved === null) throw readError(`${path} vanished while opening`, 'ENOENT')
  if (!isInside(rootReal, resolved))
    throw readError(`${path} resolves outside ${rootReal}`, 'EOUTSIDE')

  const resolvedInfo = await stat(resolved, { bigint: true }).catch(() => null)
  if (resolvedInfo === null || resolvedInfo.dev !== opened.dev || resolvedInfo.ino !== opened.ino) {
    throw readError(`${path} changed while opening`, 'ECHANGED')
  }
}

/**
 * Read one memory file without leaving the mirror.
 *
 * The listing rejects symlinks, but a path can be replaced between that
 * `lstat` and this read. Two checks cover the two ways a replacement can
 * escape: `O_NOFOLLOW` refuses a link in the final component, and after the
 * open the path is resolved again and required to stay inside `root` with the
 * same device/inode as the opened descriptor. That second check catches a
 * parent directory swapped for a symlink, which `O_NOFOLLOW` alone cannot see.
 * The descriptor is never read when either check fails.
 *
 * Failures use filesystem-style codes: `ENOENT` when the path vanished,
 * `EOUTSIDE` when it resolved outside the mirror, and `ECHANGED` when the
 * path no longer names the opened file. `ENOTREG` means it is not a regular
 * file. Callers treat each as an inconsistent snapshot rather than content to
 * mirror.
 */
export async function readMemoryFile(root: string, path: string): Promise<MemoryFileContents> {
  const rootReal = await realpath(root).catch(() => null)
  if (rootReal === null) throw readError(`cannot resolve ${root}`, 'ENOENT')

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw readError(`${path} is not a regular file`, 'ENOTREG')

    // Identity uses bigint stats; mtime uses the plain stat above so it matches
    // the `mtimeMs` every other comparison in this module sees exactly.
    const identity = await handle.stat({ bigint: true })
    await verifyOpenedPath(rootReal, path, identity)

    return { content: await handle.readFile('utf8'), mtimeMs: info.mtimeMs }
  } finally {
    await handle.close()
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
 * Write a downloaded entry only after proving the open descriptor is the file
 * at `path` inside the mirror.
 *
 * `canonicalTarget` resolves every parent and rejects a final symlink, but a
 * parent can still be replaced between that check and this open. The open
 * therefore uses `O_NOFOLLOW` but NOT `O_TRUNC`: truncating before verifying
 * would destroy the destination even when the write is refused. Once the
 * descriptor is open, `verifyOpenedPath` re-resolves the whole path and
 * requires the same bigint device/inode inside `root`. Only then is the old
 * body truncated, and every write after that goes through the descriptor, so
 * a later path swap cannot redirect or truncate anything else.
 *
 * The adopted remote mtime is also applied through the descriptor, not the
 * path, so it cannot touch a file substituted after the write.
 *
 * `planned` is the local file state the download decision was made from. An
 * editor can change the file IN PLACE — same inode, new mtime — after the
 * pre-write mtime guard and before this open, which the path/inode check
 * cannot see. A fresh descriptor stat therefore compares against `planned`
 * before truncating, so that edit is refused instead of silently discarded.
 * When no local file was planned, any non-empty file now at the path was
 * created concurrently and wins the same way.
 *
 * Failures use the same codes as `readMemoryFile`: `ELOOP`/`ENOTREG`/
 * `EOUTSIDE` mean the destination is unsafe, while `ECHANGED`/`ENOENT` mean a
 * concurrent local change won the race.
 */
async function writeDownloadedFile(
  root: string,
  path: string,
  plaintext: string,
  mtimeMs: number | null,
  planned: LocalEntry | undefined,
): Promise<void> {
  const rootReal = await realpath(root).catch(() => null)
  if (rootReal === null) throw readError(`cannot resolve ${root}`, 'ENOENT')

  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat({ bigint: true })
    if (!info.isFile()) throw readError(`${path} is not a regular file`, 'ENOTREG')

    await verifyOpenedPath(rootReal, path, info)

    // Re-read the descriptor after the path check. This catches an in-place
    // edit between the runSync mtime guard and this open: the inode is
    // unchanged, so only the fresh timestamp (or a non-empty file where none
    // was planned) proves the snapshot moved underneath the decision.
    const latest = await handle.stat()
    if (planned !== undefined) {
      if (!latest.isFile() || latest.mtimeMs !== planned.mtimeMs) {
        throw readError(`${path} changed before writing`, 'ECHANGED')
      }
    } else if (latest.size !== 0) {
      throw readError(`${path} was created before writing`, 'ECHANGED')
    }

    await handle.truncate(0)
    await handle.writeFile(plaintext, 'utf8')
    if (mtimeMs !== null && Number.isFinite(mtimeMs)) {
      const when = new Date(mtimeMs)
      await handle.utimes(when, when).catch(() => {})
    }
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

  /** The key's baseline, or undefined when this pair never recorded it. */
  const baselineOf = (key: string): string | null | undefined =>
    Object.hasOwn(baselines, key) ? baselines[key] : undefined
  /** Whether the pair has ever recorded this key. */
  const known = (key: string): boolean => Object.hasOwn(baselines, key)
  /** A null or missing baseline cannot prove that a side is unchanged. */
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

/**
 * Persist the pair state with owner-only permissions.
 *
 * The complete JSON goes to a temporary file in the target's own directory
 * first, then replaces the target with `rename`. A concurrent reader therefore
 * sees either the previous complete file or the new complete file, never a
 * truncated write that `readSyncState` would mistake for an empty state.
 */
async function writeSyncState(path: string, state: SyncStateFile): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const temp = join(dir, `.${randomUUID()}.sync-state.tmp`)
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    })
    await rename(temp, path)
  } catch (err) {
    await rm(temp, { force: true })
    throw err
  }
}

/**
 * Merge one pair's baselines into the newest state file under a cross-process
 * lock.
 *
 * The state read that produces the merged file happens only after the lock is
 * held. Two concurrent syncs of different directories therefore update
 * different pairs without either one writing a stale whole-file snapshot over
 * the other's baseline. The lock is only held for this short local transaction,
 * not across the network work of a sync.
 */
async function updateSyncState(
  path: string,
  stateKey: string,
  update: (pair: SyncBaselines) => SyncBaselines,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await withDirLock(`${path}.lock`, async () => {
    const state = await readSyncState(path)
    state.pairs[stateKey] = update(state.pairs[stateKey] ?? {})
    await writeSyncState(path, state)
  })
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
  let complete = listing.complete
  const local: Record<string, LocalEntry> = {}
  const contents: Record<string, string> = {}
  for (const f of listing.files) {
    // Open without following a symlink and take the mtime from that same
    // descriptor before reading. A link substituted after the walk therefore
    // cannot turn this read into an upload from outside the mirror, and a
    // later edit still changes the mtime the download guard compares.
    let read: MemoryFileContents
    try {
      read = await readMemoryFile(root, f.path)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (
        code === 'ENOENT' ||
        code === 'ELOOP' ||
        code === 'ENOTREG' ||
        code === 'EOUTSIDE' ||
        code === 'ECHANGED'
      ) {
        // The path changed into something this mirror does not carry after the
        // walk. Do not upload it, and do not let --prune treat it as deleted.
        complete = false
        continue
      }
      throw err
    }
    contents[f.key] = read.content
    local[f.key] = {
      hash: client.ciphertextHashOf(ns, f.key, read.content),
      mtimeMs: read.mtimeMs,
    }
  }

  // The one metadata read that arms everything: checksums for the plan,
  // timestamps for conflicts, and the recorded observation that base-arms the
  // client's writes, so a concurrent remote change between this read and the
  // push below is refused (409) rather than silently clobbered.
  const meta = await client.metadata(ns)
  const remote: Record<string, RemoteEntry> = {}
  for (const [key, hash] of Object.entries(meta.entryChecksums)) {
    // The local walker only sees `.md` files, so a namespace may also hold
    // MCP-saved keys like `prefs`. Sync never plans, downloads, or prunes those:
    // treating a key it cannot see locally as a local deletion would delete a
    // remote-only entry on the next --prune run.
    if (!key.endsWith(MEMORY_EXTENSION)) continue
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
    prune: opts.prune === true && complete,
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
  /** Ciphertext hash of the body actually written, not the metadata snapshot. */
  const downloadedHashes = new Map<string, string>()
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
      // Adopting the remote write time happens inside this call, through the
      // verified descriptor, so the NEXT conflict comparison has real evidence
      // rather than "whenever this sync downloaded it" — and a path swapped
      // after the write cannot have its mtime changed by mistake.
      await writeDownloadedFile(root, dest, plaintext, a.remoteAt, planned)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // A symlink, non-regular file, or redirected parent appeared between
      // canonicalTarget and the open.
      if (code === 'ELOOP' || code === 'ENOTREG' || code === 'EOUTSIDE') {
        report.downloadSkipped.push({ key: a.key, reason: 'unsafe_key' })
        continue
      }
      // The destination changed after the mtime guard: a concurrent local edit
      // (or removal) must not be overwritten.
      if (code === 'ECHANGED' || code === 'ENOENT') {
        report.downloadSkipped.push({ key: a.key, reason: 'local-changed' })
        continue
      }
      throw err
    }

    // Record the hash of what was actually written. A remote writer can replace
    // the entry between the metadata read and this fetch, so the plan's remote
    // hash may already be stale; using the write's own hash keeps the NEXT
    // local edit a one-sided change instead of a guessed conflict.
    downloadedHashes.set(a.key, client.ciphertextHashOf(ns, a.key, plaintext))
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
    // The removal decision used the snapshot from the start of the sync. Check
    // immediately before unlinking: an edit that landed while the sync was
    // fetching must not be deleted. `lstat` also treats a substituted symlink
    // as a local change instead of following it.
    const planned = Object.hasOwn(local, a.key) ? local[a.key] : undefined
    const current = await lstat(dest).catch(() => null)
    if (
      planned !== undefined &&
      current !== null &&
      (!current.isFile() || current.mtimeMs !== planned.mtimeMs)
    ) {
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
    const uploaded = new Set(report.uploaded.map(u => u.key))
    const unchanged = new Set(report.unchanged)
    const removedLocal = new Set(report.removedLocal)
    const pruned = new Set(report.pruned)

    // The update is applied to the latest state under a lock, so a concurrent
    // sync of another pair keeps the baseline it recorded while this one ran.
    await updateSyncState(opts.statePath, stateKey, oldPair => {
      const nextPair: SyncBaselines = {}
      for (const key of Object.keys(local)) {
        if (downloadedHashes.has(key)) nextPair[key] = downloadedHashes.get(key) ?? null
        else if (uploaded.has(key) || unchanged.has(key)) nextPair[key] = local[key]?.hash ?? null
        else if (removedLocal.has(key)) continue
        else if (Object.hasOwn(oldPair, key)) nextPair[key] = oldPair[key] ?? null
      }
      for (const key of Object.keys(remote)) {
        if (Object.hasOwn(local, key) || pruned.has(key)) continue
        if (downloadedHashes.has(key)) nextPair[key] = downloadedHashes.get(key) ?? null
        else if (Object.hasOwn(oldPair, key)) nextPair[key] = oldPair[key] ?? null
      }
      return nextPair
    })
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
  for (const u of r.uploaded)
    out.push(`  ↑ ${flattenServerText(u.key, 300)} (${UPLOAD_REASONS[u.reason] ?? u.reason})`)
  for (const d of r.downloaded)
    out.push(`  ↓ ${flattenServerText(d.key, 300)} (${DOWNLOAD_REASONS[d.reason] ?? d.reason})`)
  for (const p of r.pruned)
    out.push(`  ✗ ${flattenServerText(p, 300)} pruned (deleted from the namespace)`)
  for (const p of r.removedLocal)
    out.push(`  ✗ ${flattenServerText(p, 300)} removed locally (deleted remotely)`)

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
    /** Push the pending run back by another quiet period. */
    schedule() {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        fn()
      }, ms)
    },
    /** Drop a pending run without calling `fn`. */
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
 * Watching reports LOCAL filesystem events only; a remote-only change is not
 * seen until something local happens or a poll runs. An `FSWatcher` can also
 * emit `error` AFTER setup, which would otherwise throw out of the event loop.
 * That path closes the watcher and falls back to the same poll cadence.
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
    /** Stop watching and cancel any run the debouncer has pending. */
    close() {
      for (const stop of stoppers) stop()
    },
  }
}
