/**
 * `openrecall sync` — the directory ↔ namespace mirror.
 *
 * The pure half (planning, walking, path guarding, debouncing) is tested
 * directly. The running half is tested against the REAL stack: an
 * OpenRecallClient over local mode, which serves the production handler from
 * the production store with the production crypto. Nothing here stubs the
 * client or the server, because the properties that matter — deterministic
 * hashes matching across processes, timestamps ordering conflicts, prune
 * state surviving between runs — are exactly the properties a stub would
 * quietly re-implement wrongly.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const PASSPHRASE = 'sync test passphrase'

const dirs: string[] = []

/** A throwaway directory that is removed when the suite ends. */
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'openrecall-sync-'))
  dirs.push(d)
  return d
}

/** Write a memory file, optionally pinning its mtime for conflict tests. */
function put(dir: string, key: string, content: string, mtimeMs?: number): string {
  const path = join(dir, ...key.split('/'))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  if (mtimeMs !== undefined) utimesSync(path, new Date(mtimeMs), new Date(mtimeMs))
  return path
}

let runSync: typeof import('../src/cli/sync.ts').runSync
let planSync: typeof import('../src/cli/sync.ts').planSync
let walkMemoryFiles: typeof import('../src/cli/sync.ts').walkMemoryFiles
let safeJoin: typeof import('../src/cli/sync.ts').safeJoin
let makeDebouncer: typeof import('../src/cli/sync.ts').makeDebouncer
let OpenRecallClient: typeof import('../client/index.ts').OpenRecallClient
let LOCAL_ORIGIN: string
let localFetch: typeof import('../src/cli/local.ts').localFetch

beforeAll(async () => {
  ;({ runSync, planSync, walkMemoryFiles, safeJoin, makeDebouncer } = await import(
    '../src/cli/sync.ts'
  ))
  ;({ OpenRecallClient } = await import('../client/index.ts'))
  ;({ LOCAL_ORIGIN, localFetch } = await import('../src/cli/local.ts'))
})

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** A real client over the real in-process server, on the suite's store. */
async function realClient(): Promise<InstanceType<typeof OpenRecallClient>> {
  const transport = await localFetch(resolve(process.env.DATA_DIR as string))
  return new OpenRecallClient({ url: LOCAL_ORIGIN, passphrase: PASSPHRASE, fetch: transport })
}

// ─── Pure: walking and path guarding ─────────────────────────────────────

describe('walkMemoryFiles', () => {
  test('walks every depth — pull writes deep keys, so the walker may not cap depth', async () => {
    const dir = tempDir()
    put(dir, 'MEMORY.md', 'index')
    put(dir, 'projects/openrecall/decisions/2026/deep.md', 'deep')
    put(dir, 'notes.txt', 'not memory')

    const files = await walkMemoryFiles(dir)
    expect(files.map(f => f.key)).toEqual([
      'MEMORY.md',
      'projects/openrecall/decisions/2026/deep.md',
    ])
  })

  test('an unreadable or missing directory is empty, not an error', async () => {
    expect(await walkMemoryFiles(join(tempDir(), 'nope'))).toEqual([])
  })
})

describe('safeJoin', () => {
  const root = resolve('/tmp/memory-dir')

  test('keeps ordinary keys inside the root', () => {
    expect(safeJoin(root, 'a.md')).toBe(resolve(root, 'a.md'))
    expect(safeJoin(root, 'feedback/tone.md')).toBe(resolve(root, 'feedback/tone.md'))
  })

  test('refuses a key that would leave the root', () => {
    expect(safeJoin(root, '../escape.md')).toBeNull()
    expect(safeJoin(root, 'a/../../escape.md')).toBeNull()
  })
})

// ─── Pure: planning ──────────────────────────────────────────────────────

describe('planSync', () => {
  const T0 = Date.parse('2026-01-01T00:00:00.000Z')

  test('equal hashes are unchanged, whatever the timestamps', () => {
    const plan = planSync({
      local: { 'a.md': { hash: 'h1', mtimeMs: T0 } },
      remote: { 'a.md': { hash: 'h1', updatedAt: new Date(T0 + 5000).toISOString() } },
    })
    expect(plan.actions).toEqual([{ kind: 'unchanged', key: 'a.md' }])
  })

  test('a local-only key uploads; a remote-only key downloads', () => {
    const plan = planSync({
      local: { 'local.md': { hash: 'h1', mtimeMs: T0 } },
      remote: { 'remote.md': { hash: 'h2', updatedAt: new Date(T0).toISOString() } },
    })
    expect(plan.actions).toContainEqual({
      kind: 'upload',
      key: 'local.md',
      reason: 'remote-missing',
    })
    expect(plan.actions).toContainEqual({
      kind: 'download',
      key: 'remote.md',
      reason: 'local-missing',
      remoteAt: T0,
    })
  })

  test('a two-sided difference goes to whichever side is newer', () => {
    const newerRemote = planSync({
      local: { 'a.md': { hash: 'h1', mtimeMs: T0 } },
      remote: { 'a.md': { hash: 'h2', updatedAt: new Date(T0 + 1000).toISOString() } },
    })
    expect(newerRemote.actions).toEqual([
      { kind: 'download', key: 'a.md', reason: 'remote-newer', remoteAt: T0 + 1000 },
    ])

    const newerLocal = planSync({
      local: { 'a.md': { hash: 'h1', mtimeMs: T0 + 1000 } },
      remote: { 'a.md': { hash: 'h2', updatedAt: new Date(T0).toISOString() } },
    })
    expect(newerLocal.actions).toEqual([{ kind: 'upload', key: 'a.md', reason: 'local-newer' }])
  })

  test('an exact tie goes to the local working copy', () => {
    const plan = planSync({
      local: { 'a.md': { hash: 'h1', mtimeMs: T0 } },
      remote: { 'a.md': { hash: 'h2', updatedAt: new Date(T0).toISOString() } },
    })
    expect(plan.actions).toEqual([{ kind: 'upload', key: 'a.md', reason: 'local-newer' }])
  })

  test('a two-sided difference with no timestamp evidence is left alone, not guessed', () => {
    const plan = planSync({
      local: { 'a.md': { hash: 'h1', mtimeMs: T0 } },
      remote: { 'a.md': { hash: 'h2' } },
    })
    expect(plan.actions).toEqual([{ kind: 'unresolved', key: 'a.md' }])
  })

  test('--prefer resolves a conflict without consulting timestamps', () => {
    const local = planSync({
      local: { 'a.md': { hash: 'h1', mtimeMs: T0 } },
      remote: { 'a.md': { hash: 'h2', updatedAt: new Date(T0 + 1000).toISOString() } },
      prefer: 'local',
    })
    expect(local.actions).toEqual([{ kind: 'upload', key: 'a.md', reason: 'prefer-local' }])

    const remote = planSync({
      local: { 'a.md': { hash: 'h1', mtimeMs: T0 + 1000 } },
      remote: { 'a.md': { hash: 'h2' } },
      prefer: 'remote',
    })
    expect(remote.actions).toEqual([
      { kind: 'download', key: 'a.md', reason: 'prefer-remote', remoteAt: null },
    ])
  })

  test('a remote-only key prunes only when this pair previously held it locally', () => {
    const base = {
      local: {} as Record<string, { hash: string; mtimeMs: number }>,
      remote: {
        'known.md': { hash: 'h1', updatedAt: new Date(T0).toISOString() },
        'new-remote.md': { hash: 'h2', updatedAt: new Date(T0).toISOString() },
      },
    }
    const guarded = planSync({ ...base, prunableKeys: ['known.md'] })
    expect(guarded.actions).toContainEqual({ kind: 'prune', key: 'known.md' })
    expect(guarded.actions).toContainEqual({
      kind: 'download',
      key: 'new-remote.md',
      reason: 'local-missing',
      remoteAt: T0,
    })

    // Without the state list, the previously-known key is a download too: the
    // guard, not the flag, is what makes pruning safe.
    const unguarded = planSync(base)
    expect(unguarded.actions).toContainEqual({
      kind: 'download',
      key: 'known.md',
      reason: 'local-missing',
      remoteAt: T0,
    })
  })
})

describe('makeDebouncer', () => {
  test('a burst of events coalesces into one run', async () => {
    let fired = 0
    const d = makeDebouncer(20, () => {
      fired++
    })
    d.schedule()
    d.schedule()
    d.schedule()
    await new Promise(r => setTimeout(r, 60))
    expect(fired).toBe(1)
    // And it keeps working after firing once.
    d.schedule()
    await new Promise(r => setTimeout(r, 60))
    expect(fired).toBe(2)
    d.cancel()
  })

  test('cancel drops a pending run', async () => {
    let fired = 0
    const d = makeDebouncer(20, () => {
      fired++
    })
    d.schedule()
    d.cancel()
    await new Promise(r => setTimeout(r, 60))
    expect(fired).toBe(0)
  })
})

// ─── Real stack: runSync over local mode ─────────────────────────────────

describe('runSync against the real server, store and crypto', () => {
  test('a fresh directory uploads, and the metadata read carries timestamps', async () => {
    const ns = 'user:sync-upload'
    const dir = tempDir()
    const state = join(tempDir(), 'state.json')
    put(dir, 'MEMORY.md', '# index')
    put(dir, 'feedback/tone.md', 'be terse')
    const client = await realClient()

    const r = await runSync(dir, client, { namespace: ns, statePath: state })
    expect(r.dryRun).toBe(false)
    expect(r.uploaded).toEqual([
      { key: 'MEMORY.md', reason: 'remote-missing' },
      { key: 'feedback/tone.md', reason: 'remote-missing' },
    ])
    expect(r.downloaded).toEqual([])
    expect(r.skipped).toEqual([])

    // The server now holds exactly this content, decryptable by an independent
    // client, and the hashes view reported write times for both keys.
    const other = await realClient()
    const pulled = await other.pull(ns)
    expect(pulled.entries).toEqual({ 'MEMORY.md': '# index', 'feedback/tone.md': 'be terse' })
    const meta = await other.metadata(ns)
    expect(Object.keys(meta.entryUpdatedAt).sort()).toEqual(['MEMORY.md', 'feedback/tone.md'])
    expect(meta.supports).toContain('hashes-updated-at')
    for (const t of Object.values(meta.entryUpdatedAt))
      expect(Number.isFinite(Date.parse(t as string))).toBe(true)
  })

  test('a second sync with nothing changed moves nothing', async () => {
    const ns = 'user:sync-stable'
    const dir = tempDir()
    const state = join(tempDir(), 'state.json')
    put(dir, 'a.md', 'stable')
    const client = await realClient()
    await runSync(dir, client, { namespace: ns, statePath: state })

    const r = await runSync(dir, client, { namespace: ns, statePath: state })
    expect(r.uploaded).toEqual([])
    expect(r.downloaded).toEqual([])
    expect(r.unchanged).toEqual(['a.md'])
    expect(r.pruned).toEqual([])
  })

  test('a remote-only entry is downloaded, with the server write time adopted', async () => {
    const ns = 'user:sync-download'
    const dir = tempDir()
    const state = join(tempDir(), 'state.json')
    put(dir, 'local.md', 'kept')
    const client = await realClient()
    await runSync(dir, client, { namespace: ns, statePath: state })

    const other = await realClient()
    await other.push(ns, { 'agent-note.md': 'written by an agent' })

    const r = await runSync(dir, client, { namespace: ns, statePath: state })
    expect(r.downloaded).toEqual([{ key: 'agent-note.md', reason: 'local-missing' }])
    expect(await readFileUtf8(dir, 'agent-note.md')).toBe('written by an agent')

    // The file carries the entry's remote write time, so a later conflict is
    // ordered by real evidence rather than by when this download happened.
    const meta = await other.metadata(ns)
    const remoteAt = Date.parse(meta.entryUpdatedAt['agent-note.md'] as string)
    expect(Math.abs(statSync(join(dir, 'agent-note.md')).mtimeMs - remoteAt)).toBeLessThan(5)
  })

  test('files deeper than the old push walker ever uploaded still sync', async () => {
    // Regression: pull wrote any depth an entry key named, while push's walker
    // stopped at three path segments, so deep files silently vanished from
    // every later push. A mirror may not have that asymmetry.
    const ns = 'user:sync-deep'
    const dir = tempDir()
    const state = join(tempDir(), 'state.json')
    put(dir, 'projects/openrecall/decisions/2026/deep.md', 'deep note')
    const client = await realClient()

    const r = await runSync(dir, client, { namespace: ns, statePath: state })
    expect(r.uploaded.map(u => u.key)).toEqual(['projects/openrecall/decisions/2026/deep.md'])
    expect((await (await realClient()).pull(ns)).entries).toEqual({
      'projects/openrecall/decisions/2026/deep.md': 'deep note',
    })
  })
})

/** Read a file under a synced directory as UTF-8. */
async function readFileUtf8(dir: string, key: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(join(dir, ...key.split('/')), 'utf8')
}

describe('runSync conflict resolution, by real timestamps', () => {
  test('a locally-newer file wins and reaches the server', async () => {
    const ns = 'user:sync-conflict-local'
    const dir = tempDir()
    const state = join(tempDir(), 'state.json')
    put(dir, 'note.md', 'v1')
    const client = await realClient()
    await runSync(dir, client, { namespace: ns, statePath: state })

    // Both sides change: an agent rewrites the entry remotely...
    const other = await realClient()
    await other.push(ns, { 'note.md': 'agent rewrote it' })
    // ...and the local file is edited afterwards (a strictly newer mtime).
    put(dir, 'note.md', 'human rewrote it', Date.now() + 86_400_000)

    const r = await runSync(dir, client, { namespace: ns, statePath: state })
    expect(r.uploaded).toEqual([{ key: 'note.md', reason: 'local-newer' }])
    expect(await readFileUtf8(dir, 'note.md')).toBe('human rewrote it')
    expect((await (await realClient()).pull(ns)).entries['note.md']).toBe('human rewrote it')
  })

  test('a remotely-newer entry wins and reaches the directory', async () => {
    const ns = 'user:sync-conflict-remote'
    const dir = tempDir()
    const state = join(tempDir(), 'state.json')
    put(dir, 'note.md', 'v1')
    const client = await realClient()
    await runSync(dir, client, { namespace: ns, statePath: state })

    const other = await realClient()
    await other.push(ns, { 'note.md': 'agent rewrote it' })
    // The local edit is real but happened in 2001: the server's write time is
    // the newer evidence, so the remote content must win here.
    put(dir, 'note.md', 'stale local edit', Date.parse('2001-01-01T00:00:00.000Z'))

    const r = await runSync(dir, client, { namespace: ns, statePath: state })
    expect(r.downloaded).toEqual([{ key: 'note.md', reason: 'remote-newer' }])
    expect(await readFileUtf8(dir, 'note.md')).toBe('agent rewrote it')
  })

  test('dry run plans the work and writes nothing', async () => {
    const ns = 'user:sync-dryrun'
    const dir = tempDir()
    const state = join(tempDir(), 'state.json')
    put(dir, 'a.md', 'v1')
    const client = await realClient()
    await runSync(dir, client, { namespace: ns, statePath: state })

    put(dir, 'a.md', 'v2')
    const other = await realClient()
    await other.push(ns, { 'remote-new.md': 'never seen locally' })

    const r = await runSync(dir, client, { namespace: ns, statePath: state, dryRun: true })
    expect(r.dryRun).toBe(true)
    expect(r.uploaded.map(u => u.key)).toEqual(['a.md'])
    expect(r.downloaded.map(d => d.key)).toEqual(['remote-new.md'])

    // Nothing was written on either side: the directory kept its local edit,
    // the namespace kept its remote one, and no state recorded the phantom.
    expect(await readFileUtf8(dir, 'a.md')).toBe('v2')
    const entries = (await (await realClient()).pull(ns)).entries
    expect(entries['a.md']).toBe('v1')
    expect(Object.hasOwn(entries, 'remote-new.md')).toBe(true)
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(dir, 'remote-new.md'))).toBe(false)
  })
})

describe('runSync --prune, guarded by pair state', () => {
  test('a deleted local file prunes its entry; a new remote entry is downloaded, not pruned', async () => {
    const ns = 'user:sync-prune'
    const dir = tempDir()
    const state = join(tempDir(), 'state.json')
    put(dir, 'keep.md', 'kept')
    put(dir, 'gone.md', 'deleted locally later')
    const client = await realClient()
    await runSync(dir, client, { namespace: ns, statePath: state })

    // The state file now names both keys for THIS (dir, namespace) pair.
    const { readFileSync, existsSync } = await import('node:fs')
    const stateKey = await syncStateKeyOf(dir, ns)
    const recorded = JSON.parse(readFileSync(state, 'utf8')) as {
      pairs: Record<string, string[]>
    }
    expect(recorded.pairs[stateKey]).toEqual(['gone.md', 'keep.md'])

    // The local file disappears, and a colleague's agent saves something new
    // remotely that this directory has never seen.
    rmSync(join(dir, 'gone.md'))
    const other = await realClient()
    await other.push(ns, { 'colleague.md': 'saved elsewhere' })

    const r = await runSync(dir, client, { namespace: ns, statePath: state, prune: true })
    expect(r.pruned).toEqual(['gone.md'])
    expect(r.downloaded.map(d => d.key)).toEqual(['colleague.md'])
    expect(r.uploaded).toEqual([])
    expect(r.unchanged).toEqual(['keep.md'])

    // The namespace now holds keep.md and colleague.md, and gone.md is gone.
    const entries = (await other.pull(ns)).entries
    expect(Object.keys(entries).sort()).toEqual(['colleague.md', 'keep.md'])
    expect(existsSync(join(dir, 'colleague.md'))).toBe(true)
    expect(existsSync(join(dir, 'gone.md'))).toBe(false)
  })

  test('without --prune a deleted local file leaves the remote entry alone', async () => {
    const ns = 'user:sync-noprune'
    const dir = tempDir()
    const state = join(tempDir(), 'state.json')
    put(dir, 'a.md', 'v1')
    const client = await realClient()
    await runSync(dir, client, { namespace: ns, statePath: state })

    rmSync(join(dir, 'a.md'))
    const r = await runSync(dir, client, { namespace: ns, statePath: state })
    expect(r.pruned).toEqual([])
    expect((await (await realClient()).pull(ns)).entries['a.md']).toBe('v1')
  })

  test('a first sync with --prune deletes nothing — it only establishes the guard', async () => {
    const ns = 'user:sync-prune-first'
    const dir = tempDir()
    const state = join(tempDir(), 'state.json')
    const other = await realClient()
    await other.push(ns, { 'saved-remotely.md': 'never local' })

    const client = await realClient()
    const r = await runSync(dir, client, { namespace: ns, statePath: state, prune: true })
    // Nothing was ever local here, so nothing is eligible: the entry downloads.
    expect(r.pruned).toEqual([])
    expect(r.downloaded.map(d => d.key)).toEqual(['saved-remotely.md'])
    expect(await readFileUtf8(dir, 'saved-remotely.md')).toBe('never local')
  })
})

/** The state key for a pair, computed the way runSync computes it. */
async function syncStateKeyOf(dir: string, ns: string): Promise<string> {
  const { syncStateKey } = await import('../src/cli/sync.ts')
  return syncStateKey(dir, ns)
}
