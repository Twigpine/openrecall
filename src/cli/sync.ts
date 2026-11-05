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
 * Only entries whose hashes differ are moved, and for those the server's
 * per-entry timestamps (new in the hashes view) decide which side is newer.
 *
 * Conflict policy, deliberately conservative:
 *   - one side changed        → that side wins
 *   - both changed, timestamps say which is newer → the newer side wins
 *   - both changed, no timestamps (old server)    → NOTHING is written for
 *     that key; the report names it and the operator re-runs with
 *     `--prefer local` or `--prefer remote`. Guessing here is how a month of
 *     memory edits gets silently discarded, and the guesser never finds out.
 *
 * Deletions are opt-in (`--prune`) and state-guarded: a remote entry is only
 * pruned when a PREVIOUS sync of this same (directory, namespace) pair saw a
 * local file for it. Without that guard, pruning would delete every entry a
 * colleague or another agent saved remotely — a mirror that destroys the very
 * concurrency it exists to serve.
 */

import { watch as fsWatch } from 'node:fs'
import { mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { OpenRecallClient } from '../../client/index.ts'
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

/**
 * Every `.md` file under `dir`, at any depth, with `/`-separated entry keys.
 *
 * No depth cap. `push`'s walker used to stop at three path segments while
 * `pull` happily wrote files at any depth an entry key named, so a directory
 * synced down and pushed back silently DROPPED its deeper files — the
 * asymmetry a mirror cannot have. Entry keys the server accepts are what
 * decides depth, not a walker's constant.
 */
export async function walkMemoryFiles(dir: string): Promise<MemoryFile[]> {
  const out: MemoryFile[] = []
  const entries = await readdir(dir, { recursive: true }).catch(() => [] as string[])
  for (const rel of entries) {
    if (!rel.endsWith(MEMORY_EXTENSION)) continue
    out.push({ key: rel.split(sep).join('/'), path: join(dir, rel) })
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
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
  const dest = resolve(root, ...key.split('/'))
  if (dest !== root && !dest.startsWith(`${root}${sep}`)) return null
  return dest
}

// ─── Planning (pure) ─────────────────────────────────────────────────────

export type LocalEntry = { hash: string; mtimeMs: number }
export type RemoteEntry = { hash: string; updatedAt?: string }

export type UploadReason = 'remote-missing' | 'local-newer' | 'prefer-local'
export type DownloadReason = 'local-missing' | 'remote-newer' | 'prefer-remote'

export type SyncAction =
  | { kind: 'upload'; key: string; reason: UploadReason }
  | { kind: 'download'; key: string; reason: DownloadReason; remoteAt: number | null }
  | { kind: 'unchanged'; key: string }
  | { kind: 'unresolved'; key: string }
  | { kind: 'prune'; key: string }

export type SyncPlan = { actions: SyncAction[] }

/**
 * Decide, per key, what a sync owes to do. Pure: no clock, no filesystem, no
 * network — every time value is supplied by the caller, which is what makes
 * conflict ordering testable rather than a race with `Date.now()`.
 *
 * `prunableKeys` are the keys a previous sync of this pair saw locally; a
 * remote-only key on that list is a local deletion catching up, while a
 * remote-only key NOT on it is a new remote write this sync must download.
 */
export function planSync(input: {
  local: Record<string, LocalEntry>
  remote: Record<string, RemoteEntry>
  prefer?: 'local' | 'remote'
  prunableKeys?: string[]
}): SyncPlan {
  const prunable = new Set(input.prunableKeys ?? [])
  const keys = new Set([...Object.keys(input.local), ...Object.keys(input.remote)])
  const actions: SyncAction[] = []

  for (const key of keys) {
    // Own properties only: a key like `constructor` must miss, never resolve
    // to something off the prototype.
    const l = Object.hasOwn(input.local, key) ? input.local[key] : undefined
    const r = Object.hasOwn(input.remote, key) ? input.remote[key] : undefined

    if (l && r) {
      if (l.hash === r.hash) {
        actions.push({ kind: 'unchanged', key })
        continue
      }
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

    if (l) {
      actions.push({ kind: 'upload', key, reason: 'remote-missing' })
      continue
    }
    if (r) {
      actions.push(
        prunable.has(key)
          ? { kind: 'prune', key }
          : { kind: 'download', key, reason: 'local-missing', remoteAt: remoteTime(r) },
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

type SyncStateFile = { version: 1; pairs: Record<string, string[]> }

/** The state key for one (directory, namespace) pair. */
export function syncStateKey(dir: string, namespace: string): string {
  return sha256Hex(`${namespace}\n${resolve(dir)}`)
}

async function readSyncState(path: string): Promise<SyncStateFile> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<SyncStateFile>
    // A corrupt or foreign-shaped state file prunes nothing rather than
    // guessing which keys it meant. Pruning on garbage is how a safe mirror
    // stops being one.
    if (parsed?.version !== 1 || typeof parsed.pairs !== 'object' || parsed.pairs === null) {
      return { version: 1, pairs: {} }
    }
    return { version: 1, pairs: parsed.pairs }
  } catch {
    return { version: 1, pairs: {} }
  }
}

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

export type SyncReport = {
  namespace: string
  dryRun: boolean
  uploaded: { key: string; reason: UploadReason }[]
  downloaded: { key: string; reason: DownloadReason }[]
  unchanged: string[]
  unresolved: string[]
  pruned: string[]
  /** Keys the store refused, verbatim from its response. */
  skipped: { key: string; reason: string }[]
}

/**
 * Sync `dir` with `opts.namespace` once and report exactly what moved.
 *
 * Ordering: downloads, then uploads, then prunes. A prune is last so its
 * "nothing local has this key anymore" decision is made against the local set
 * this sync started with, not one an in-flight download was about to change.
 */
export async function runSync(
  dir: string,
  client: OpenRecallClient,
  opts: SyncOptions,
): Promise<SyncReport> {
  const root = resolve(dir)
  const ns = opts.namespace

  // Read local files once: content for hashing and uploading, mtime for
  // conflict ordering.
  const files = await walkMemoryFiles(root)
  const local: Record<string, LocalEntry> = {}
  const contents: Record<string, string> = {}
  for (const f of files) {
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

  const state = opts.prune && opts.statePath ? await readSyncState(opts.statePath) : undefined
  const stateKey = syncStateKey(root, ns)
  const prunableKeys = state?.pairs[stateKey]?.filter(
    k => !Object.hasOwn(local, k) && Object.hasOwn(remote, k),
  )

  const plan = planSync({ local, remote, prefer: opts.prefer, prunableKeys })
  const report: SyncReport = {
    namespace: ns,
    dryRun: opts.dryRun === true,
    uploaded: [],
    downloaded: [],
    unchanged: [],
    unresolved: [],
    pruned: [],
    skipped: [],
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
    bodies = (await client.pull(ns)).entries
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
      report.skipped.push({ key: a.key, reason: 'vanished' })
      continue
    }
    const dest = safeJoin(root, a.key)
    if (dest === null) {
      report.skipped.push({ key: a.key, reason: 'unsafe_key' })
      continue
    }
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, plaintext)
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

  // ── State ──
  // Record the keys this pair now holds locally, so the NEXT --prune can tell
  // "this local file was deleted" from "this remote entry is new". Written on
  // every sync, not only pruning ones, because the guard is only as good as
  // the last time it was updated.
  if (opts.statePath) {
    const after = await readSyncState(opts.statePath)
    after.pairs[stateKey] = [
      ...new Set([...Object.keys(local), ...report.downloaded.map(d => d.key)]),
    ].sort()
    await writeSyncState(opts.statePath, after)
  }

  return report
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

export type WatchHandle = { close(): void }

/**
 * Call `onChange` (debounced) when a `.md` file under `dir` changes.
 *
 * `intervalSec` polls instead of watching, for platforms where recursive
 * watching is unavailable or a caller prefers a fixed cadence. When watching
 * is requested but the platform refuses it, polling at
 * {@link POLL_FALLBACK_SEC} takes over rather than the watch silently dying —
 * a sync that looks alive and never runs is worse than one that polls.
 */
export function watchDirectory(
  dir: string,
  onChange: () => void,
  opts: { debounceMs?: number; intervalSec?: number } = {},
): WatchHandle {
  const debouncer = makeDebouncer(opts.debounceMs ?? WATCH_DEBOUNCE_MS, onChange)
  const stoppers: (() => void)[] = [() => debouncer.cancel()]

  const pollEvery = (sec: number) => {
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
