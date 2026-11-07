/**
 * `openrecall sync` — the directory ↔ namespace mirror.
 *
 * The pure half (planning, walking, path guarding, debouncing, report labels)
 * is tested directly. The running half is tested against the REAL stack: an
 * OpenRecallClient over local mode, which serves the production handler from
 * the production store with the production crypto. Nothing here stubs the
 * client or the server, because the properties that matter — deterministic
 * hashes matching across processes, timestamps ordering conflicts, prune
 * state surviving between runs — are exactly the properties a stub would
 * quietly re-implement wrongly.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { SecretFoundError } from '../client/secretscan.ts'
import { _reset } from '../src/ratelimit.ts'
import { FAKE } from './secret-fixtures.ts'

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
  touch(path, mtimeMs)
  return path
}

/** Pin an existing file's mtime without changing its bytes. */
function touch(path: string, mtimeMs?: number): void {
  if (mtimeMs !== undefined) utimesSync(path, new Date(mtimeMs), new Date(mtimeMs))
}

/**
 * Whether this environment can create symlinks at all.
 *
 * Windows without Developer Mode, and some restricted sandboxes, refuse with
 * EPERM/EACCES. Symlink-dependent tests skip there instead of failing setup;
 * any other probe error is a real problem and is rethrown.
 */
const canCreateSymlinks = (() => {
  const probe = tempDir()
  try {
    symlinkSync(join(probe, 'target'), join(probe, 'link'))
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (
      code === 'EPERM' ||
      code === 'EACCES' ||
      code === 'ENOSYS' ||
      code === 'ENOTSUP' ||
      code === 'EINVAL'
    ) {
      return false
    }
    throw err
  }
})()

/**
 * Run `run` with a one-shot hook on the first `FileHandle.stat` after `arm()`.
 *
 * The production code opens a descriptor, stats it, and only then re-resolves
 * the path. This lets a test replace the path exactly inside that window
 * without a test-only parameter in the production API. The hook is installed on
 * the handle prototype (Bun does not export the `FileHandle` class) and is
 * always restored afterwards, even when the test throws.
 */
async function withFileStatHook<T>(
  afterStat: () => void,
  run: (arm: () => void) => Promise<T>,
): Promise<T> {
  const probe = await open(join(tempDir(), 'probe'), 'w')
  const proto = Object.getPrototypeOf(probe) as {
    stat: (...args: unknown[]) => Promise<unknown>
  }
  await probe.close()
  const original = proto.stat
  let armed = false
  let fired = false
  proto.stat = async function (this: unknown, ...args: unknown[]) {
    const result = await original.apply(this, args)
    if (armed && !fired) {
      fired = true
      afterStat()
    }
    return result
  }
  try {
    return await run(() => {
      armed = true
    })
  } finally {
    proto.stat = original
  }
}

let runSync: typeof import('../src/cli/sync.ts').runSync
let planSync: typeof import('../src/cli/sync.ts').planSync
let listMemoryFiles: typeof import('../src/cli/sync.ts').listMemoryFiles
let readMemoryFile: typeof import('../src/cli/sync.ts').readMemoryFile
let walkMemoryFiles: typeof import('../src/cli/sync.ts').walkMemoryFiles
let safeJoin: typeof import('../src/cli/sync.ts').safeJoin
let makeDebouncer: typeof import('../src/cli/sync.ts').makeDebouncer
let formatSyncReport: typeof import('../src/cli/sync.ts').formatSyncReport
let OpenRecallClient: typeof import('../client/index.ts').OpenRecallClient
let LOCAL_ORIGIN: string
let localFetch: typeof import('../src/cli/local.ts').localFetch

beforeAll(async () => {
  ;({
    runSync,
    planSync,
    listMemoryFiles,
    readMemoryFile,
    walkMemoryFiles,
    safeJoin,
    makeDebouncer,
    formatSyncReport,
  } = await import('../src/cli/sync.ts'))
  ;({ OpenRecallClient } = await import('../client/index.ts'))
  ;({ LOCAL_ORIGIN, localFetch } = await import('../src/cli/local.ts'))
})

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

// Local mode authenticates as the shared anonymous owner, and bun runs every
// test file in one process. Leaving this suite's hundreds of requests in that
// bucket would 429 the next HTTP suite, so clear it between tests.
afterEach(() => _reset())

/** A real client over the real in-process server, on the suite's store. */
async function realClient(): Promise<InstanceType<typeof OpenRecallClient>> {
  const transport = await localFetch(resolve(process.env.DATA_DIR as string))
  return new OpenRecallClient({ url: LOCAL_ORIGIN, passphrase: PASSPHRASE, fetch: transport })
}

// ─── Pure: walking and path guarding ─────────────────────────────────────

describe('memory file listing', () => {
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

  test('distinguishes a failed listing from a successfully empty directory', async () => {
    expect(await listMemoryFiles(join(tempDir(), 'nope'))).toEqual({
      files: [],
      complete: false,
    })
    expect(await listMemoryFiles(tempDir())).toEqual({ files: [], complete: true })
  })

  test('a directory named *.md is not a memory file', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'notes.md'))
    put(dir, 'real.md', 'real')
    expect((await walkMemoryFiles(dir)).map(f => f.key)).toEqual(['real.md'])
  })

  test.skipIf(!canCreateSymlinks)(
    'a symlink is not a memory file, even when it points at readable text',
    async () => {
      const dir = tempDir()
      const outside = join(tempDir(), 'outside.md')
      writeFileSync(outside, 'not part of this mirror')
      symlinkSync(outside, join(dir, 'leak.md'))
      put(dir, 'real.md', 'real')

      expect((await walkMemoryFiles(dir)).map(f => f.key)).toEqual(['real.md'])
      // A second line of defence: even a direct read refuses the link instead of
      // following it to the outside file.
      await expect(readMemoryFile(dir, join(dir, 'leak.md'))).rejects.toThrow()
      expect(readFileSync(outside, 'utf8')).toBe('not part of this mirror')
    },
  )

  test.skipIf(!canCreateSymlinks)(
    'a symlinked parent directory cannot redirect a read outside the mirror',
    async () => {
      const root = tempDir()
      const outside = tempDir()
      put(root, 'sub/note.md', 'inside the mirror')
      put(outside, 'note.md', 'outside secret')

      // Simulate the parent being swapped after the walk: the leaf name is still
      // ordinary and passed `lstat`, but its directory now points elsewhere.
      rmSync(join(root, 'sub'), { recursive: true })
      symlinkSync(outside, join(root, 'sub'))

      const err = (await readMemoryFile(root, join(root, 'sub', 'note.md')).catch(
        e => e,
      )) as NodeJS.ErrnoException
      expect(err.code).toBe('EOUTSIDE')
      expect(readFileSync(join(outside, 'note.md'), 'utf8')).toBe('outside secret')
    },
  )

  test('a file replaced after open is refused as ECHANGED, not read', async () => {
    const root = tempDir()
    const path = put(root, 'note.md', 'original bytes')
    const replacement = put(root, 'replacement.md', 'replacement bytes')

    // Rename lands after the descriptor is opened but before `realpath`
    // validation. The replacement stays inside the mirror, so only the
    // device/inode comparison can tell the opened file from the one now named
    // by the path.
    const err = (await withFileStatHook(
      () => renameSync(replacement, path),
      async arm => {
        arm()
        return readMemoryFile(root, path).catch(e => e)
      },
    )) as NodeJS.ErrnoException

    expect(err.code).toBe('ECHANGED')
    // The swap really happened: the path now names the replacement, and the
    // call still rejected instead of returning either body.
    expect(readFileSync(path, 'utf8')).toBe('replacement bytes')
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
    expect(safeJoin(root, '')).toBeNull()
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

  test('a baseline makes a one-sided change win even against a later clock', () => {
    // Local bytes are still the baseline; only its mtime moved. The remote
    // write is the real change, so it wins.
    const remoteChanged = planSync({
      local: { 'a.md': { hash: 'h1', mtimeMs: T0 + 86_400_000 } },
      remote: { 'a.md': { hash: 'h2', updatedAt: new Date(T0).toISOString() } },
      baselines: { 'a.md': 'h1' },
    })
    expect(remoteChanged.actions).toEqual([
      { kind: 'download', key: 'a.md', reason: 'remote-newer', remoteAt: T0 },
    ])

    // Remote bytes are still the baseline; only the local file changed. A
    // remote timestamp later than the local edit is not evidence about content.
    const localChanged = planSync({
      local: { 'a.md': { hash: 'h2', mtimeMs: T0 } },
      remote: { 'a.md': { hash: 'h1', updatedAt: new Date(T0 + 86_400_000).toISOString() } },
      baselines: { 'a.md': 'h1' },
    })
    expect(localChanged.actions).toEqual([{ kind: 'upload', key: 'a.md', reason: 'local-newer' }])
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

  test('a remote deletion is surfaced, restored, or applied only on request', () => {
    const base = {
      local: { 'a.md': { hash: 'h1', mtimeMs: T0 } },
      remote: {} as Record<string, { hash: string; updatedAt?: string }>,
      baselines: { 'a.md': 'h1' },
    }
    expect(planSync(base).actions).toEqual([{ kind: 'remote-deleted', key: 'a.md' }])
    expect(planSync({ ...base, prefer: 'local' }).actions).toEqual([
      { kind: 'upload', key: 'a.md', reason: 'prefer-local' },
    ])
    expect(planSync({ ...base, prefer: 'remote' }).actions).toEqual([
      { kind: 'remove-local', key: 'a.md' },
    ])
  })

  test('a remote-only key prunes only when the baseline hash still matches', () => {
    const base = {
      local: {} as Record<string, { hash: string; mtimeMs: number }>,
      remote: {
        'known.md': { hash: 'h1', updatedAt: new Date(T0).toISOString() },
        'new-remote.md': { hash: 'h2', updatedAt: new Date(T0).toISOString() },
      },
      baselines: { 'known.md': 'h1' },
      prune: true,
    }
    const guarded = planSync(base)
    expect(guarded.actions).toContainEqual({ kind: 'prune', key: 'known.md' })
    expect(guarded.actions).toContainEqual({
      kind: 'download',
      key: 'new-remote.md',
      reason: 'local-missing',
      remoteAt: T0,
    })

    // A newer remote write under a previously-synced key is downloaded, not
    // deleted. The hash check is what protects the concurrent write.
    const changed = planSync({
      ...base,
      remote: { 'known.md': { hash: 'h2', updatedAt: new Date(T0).toISOString() } },
    })
    expect(changed.actions).toEqual([
      { kind: 'download', key: 'known.md', reason: 'remote-newer', remoteAt: T0 },
    ])

    // Without the state list, the previously-known key is a download too: the
    // guard, not the flag, is what makes pruning safe.
    const unguarded = planSync({ ...base, baselines: {} })
    expect(unguarded.actions).toContainEqual({
      kind: 'download',
      key: 'known.md',
      reason: 'local-missing',
      remoteAt: T0,
    })

    // Legacy state can prove the key was local but not its hash, so it cannot
    // approve a delete either.
    const legacy = planSync({ ...base, baselines: { 'known.md': null } })
    expect(legacy.actions).toContainEqual({
      kind: 'download',
      key: 'known.md',
      reason: 'local-missing',
      remoteAt: T0,
    })
  })
})

describe('formatSyncReport', () => {
  const report = {
    namespace: 'user:report',
    dryRun: false,
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

  test('a vanished download says "not downloaded", not "not stored"', () => {
    const { out, err } = formatSyncReport(
      { ...report, downloadSkipped: [{ key: 'gone.md', reason: 'vanished' }] },
      '/tmp/memories',
    )
    expect(out.join('\n')).toContain('sync user:report')
    expect(err.join('\n')).toContain('gone.md not downloaded (vanished)')
    expect(err.join('\n')).not.toContain('not stored')
  })

  test('a store refusal keeps the "not stored" label', () => {
    const { err } = formatSyncReport(
      { ...report, skipped: [{ key: 'bad.md', reason: 'invalid_key' }] },
      '/tmp/memories',
    )
    expect(err.join('\n')).toContain('bad.md not stored (invalid_key)')
    expect(err.join('\n')).not.toContain('not downloaded')
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

  test('a secret-scanner refusal logs no plaintext fragment', async () => {
    const ns = 'user:sync-secret-refusal'
    const dir = tempDir()
    const secret = `token ${FAKE.github}`
    put(dir, 'leak.md', secret)
    const client = await realClient()

    const err = (await runSync(dir, client, {
      namespace: ns,
      statePath: join(tempDir(), 'state.json'),
    }).catch(e => e)) as Error

    expect(err).toBeInstanceOf(SecretFoundError)
    expect(err.message).toContain('leak.md:1')
    // The CLI prints this message to stderr, so neither the full secret nor
    // the scanner's redacted match fragment may appear in it.
    expect(err.message).not.toContain(FAKE.github)
    expect(err.message).not.toContain('…')
  })
})

/** Read a file under a synced directory as UTF-8. */
async function readFileUtf8(dir: string, key: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(join(dir, ...key.split('/')), 'utf8')
}

describe('runSync conflict resolution, by baseline and real timestamps', () => {
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

  test('an unchanged local file cannot overwrite a newer remote entry by mtime alone', async () => {
    const ns = 'user:sync-baseline-clock'
    const dir = tempDir()
    const state = join(tempDir(), 'state.json')
    const path = put(dir, 'note.md', 'v1')
    const client = await realClient()
    await runSync(dir, client, { namespace: ns, statePath: state })

    const other = await realClient()
    await other.push(ns, { 'note.md': 'agent wrote this' })
    // The bytes are still the baseline; only the local mtime is ahead. Without
    // a per-key hash baseline, this clock skew would upload v1 over the agent.
    touch(path, Date.now() + 86_400_000)

    const r = await runSync(dir, client, { namespace: ns, statePath: state })
    expect(r.uploaded).toEqual([])
    expect(r.downloaded).toEqual([{ key: 'note.md', reason: 'remote-newer' }])
    expect(await readFileUtf8(dir, 'note.md')).toBe('agent wrote this')
  })

  test('a stale remote timestamp cannot overwrite a real local edit', async () => {
    const ns = 'user:sync-baseline-remote-time'
    const dir = tempDir()
    const state = join(tempDir(), 'state.json')
    put(dir, 'note.md', 'v1')
    const client = await realClient()
    await runSync(dir, client, { namespace: ns, statePath: state })

    // The remote bytes are unchanged (still the baseline); only the local file
    // changed. Its old mtime must not hand the win to the unchanged remote.
    put(dir, 'note.md', 'human edit', Date.parse('2001-01-01T00:00:00.000Z'))
    const r = await runSync(dir, client, { namespace: ns, statePath: state })
    expect(r.uploaded).toEqual([{ key: 'note.md', reason: 'local-newer' }])
    expect((await (await realClient()).pull(ns)).entries['note.md']).toBe('human edit')
  })

  test('two conflicting keys each resolve against their own timestamps', async () => {
    const ns = 'user:sync-two-conflicts'
    const dir = tempDir()
    const state = join(tempDir(), 'state.json')
    put(dir, 'a.md', 'a1')
    put(dir, 'b.md', 'b1')
    const client = await realClient()
    await runSync(dir, client, { namespace: ns, statePath: state })

    // Two separate remote writes give the two keys distinct server times.
    const other = await realClient()
    await other.push(ns, { 'a.md': 'remote a' })
    await new Promise(r => setTimeout(r, 30))
    await other.push(ns, { 'b.md': 'remote b' })

    const meta = await other.metadata(ns)
    const aAt = Date.parse(meta.entryUpdatedAt['a.md'] as string)
    const bAt = Date.parse(meta.entryUpdatedAt['b.md'] as string)
    // With one shared clock reading for both keys a swap could hide; the test
    // depends on the two remote times being genuinely ordered.
    expect(bAt).toBeGreaterThan(aAt)
    const between = Math.floor((aAt + bAt) / 2)
    put(dir, 'a.md', 'local a', between)
    put(dir, 'b.md', 'local b', between)

    const r = await runSync(dir, client, { namespace: ns, statePath: state })
    expect(r.uploaded).toEqual([{ key: 'a.md', reason: 'local-newer' }])
    expect(r.downloaded).toEqual([{ key: 'b.md', reason: 'remote-newer' }])
    expect(await readFileUtf8(dir, 'a.md')).toBe('local a')
    expect(await readFileUtf8(dir, 'b.md')).toBe('remote b')
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
    expect(existsSync(join(dir, 'remote-new.md'))).toBe(false)
  })

  test('a file changed while its download is in flight is not overwritten', async () => {
    const ns = 'user:sync-race'
    const dir = tempDir()
    const state = join(tempDir(), 'state.json')
    const path = put(dir, 'note.md', 'v1')
    const client = await realClient()
    await runSync(dir, client, { namespace: ns, statePath: state })

    const other = await realClient()
    await other.push(ns, { 'note.md': 'remote v2' })
    touch(path, Date.parse('2001-01-01T00:00:00.000Z'))

    let releaseEntry: (() => void) | undefined
    const entryGate = new Promise<void>(resolve => {
      releaseEntry = resolve
    })
    let entryStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => {
      entryStarted = resolve
    })
    const delayed = new Proxy(client, {
      /** Hold the entry read open until the test edits the local file. */
      get(target, prop) {
        const value = Reflect.get(target, prop, target)
        if (prop === 'entry') {
          return async (...args: unknown[]) => {
            entryStarted?.()
            await entryGate
            return (value as (...a: unknown[]) => Promise<string>).call(target, ...args)
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as InstanceType<typeof OpenRecallClient>

    const run = runSync(dir, delayed, { namespace: ns, statePath: state })
    await started
    put(dir, 'note.md', 'edited during the fetch')
    releaseEntry?.()
    const r = await run

    expect(r.downloadSkipped).toEqual([{ key: 'note.md', reason: 'local-changed' }])
    expect(await readFileUtf8(dir, 'note.md')).toBe('edited during the fetch')
    expect((await (await realClient()).pull(ns)).entries['note.md']).toBe('remote v2')
  })

  test('an in-place edit between the guard and the write is not truncated', async () => {
    const ns = 'user:sync-inplace-race'
    const dir = tempDir()
    const state = join(tempDir(), 'state.json')
    const path = put(dir, 'note.md', 'v1')
    const client = await realClient()
    await runSync(dir, client, { namespace: ns, statePath: state })

    const other = await realClient()
    await other.push(ns, { 'note.md': 'remote v2' })
    // Make the remote side newer so the sync plans a download over this file.
    touch(path, Date.parse('2001-01-01T00:00:00.000Z'))

    let armHook: () => void = () => {}
    const delayed = new Proxy(client, {
      /** Arm the stat hook once the download body has been requested. */
      get(target, prop) {
        const value = Reflect.get(target, prop, target)
        if (prop === 'entry') {
          return async (...args: unknown[]) => {
            armHook()
            return (value as (...a: unknown[]) => Promise<string>).call(target, ...args)
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as InstanceType<typeof OpenRecallClient>

    const r = await withFileStatHook(
      // Same inode, new mtime: only the fresh descriptor stat can see it.
      () => writeFileSync(path, 'edited after the identity check'),
      async arm => {
        armHook = arm
        return runSync(dir, delayed, { namespace: ns, statePath: state })
      },
    )

    expect(r.downloaded).toEqual([])
    expect(r.downloadSkipped).toEqual([{ key: 'note.md', reason: 'local-changed' }])
    expect(await readFileUtf8(dir, 'note.md')).toBe('edited after the identity check')
  })

  test('a download records the hash of the body it wrote, not the metadata snapshot', async () => {
    const ns = 'user:sync-download-hash-race'
    const dir = tempDir()
    const state = join(tempDir(), 'state.json')
    put(dir, 'note.md', 'v1')
    const client = await realClient()
    await runSync(dir, client, { namespace: ns, statePath: state })

    const other = await realClient()
    await other.push(ns, { 'note.md': 'v2' })

    let releaseEntry: (() => void) | undefined
    const entryGate = new Promise<void>(resolve => {
      releaseEntry = resolve
    })
    let entryStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => {
      entryStarted = resolve
    })
    const delayed = new Proxy(client, {
      /** Hold the entry read open until a newer remote body has landed. */
      get(target, prop) {
        const value = Reflect.get(target, prop, target)
        if (prop === 'entry') {
          return async (...args: unknown[]) => {
            entryStarted?.()
            await entryGate
            return (value as (...a: unknown[]) => Promise<string>).call(target, ...args)
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as InstanceType<typeof OpenRecallClient>

    const run = runSync(dir, delayed, { namespace: ns, statePath: state })
    await started
    await other.push(ns, { 'note.md': 'v3 written mid-fetch' })
    releaseEntry?.()
    await run

    // The file got v3 even though metadata only knew v2. The baseline must
    // therefore be v3's hash; otherwise the next local edit looks like a
    // two-sided conflict and can lose to the server's newer timestamp.
    const stateKey = await syncStateKeyOf(dir, ns)
    const recorded = JSON.parse(readFileSync(state, 'utf8')) as {
      pairs: Record<string, Record<string, string | null>>
    }
    expect(recorded.pairs[stateKey]?.['note.md']).toBe(
      client.ciphertextHashOf(ns, 'note.md', 'v3 written mid-fetch'),
    )
    expect(await readFileUtf8(dir, 'note.md')).toBe('v3 written mid-fetch')

    // A later local edit is one-sided against that baseline, so it uploads
    // even with an older mtime that a timestamp tie-break would have lost.
    put(dir, 'note.md', 'v4 local edit', Date.parse('2001-01-01T00:00:00.000Z'))
    const next = await runSync(dir, client, { namespace: ns, statePath: state })
    expect(next.uploaded).toEqual([{ key: 'note.md', reason: 'local-newer' }])
    expect((await other.pull(ns)).entries['note.md']).toBe('v4 local edit')
  })

  test.skipIf(!canCreateSymlinks)(
    'a symlink in the mirror is skipped, never uploaded from outside',
    async () => {
      const ns = 'user:sync-symlink-upload'
      const dir = tempDir()
      const state = join(tempDir(), 'state.json')
      const outside = join(tempDir(), 'outside.md')
      writeFileSync(outside, 'outside secret')
      symlinkSync(outside, join(dir, 'leak.md'))
      put(dir, 'real.md', 'inside')

      const client = await realClient()
      const r = await runSync(dir, client, { namespace: ns, statePath: state })
      expect(r.uploaded).toEqual([{ key: 'real.md', reason: 'remote-missing' }])

      const entries = (await (await realClient()).pull(ns)).entries
      expect(entries).toEqual({ 'real.md': 'inside' })
      expect(readFileSync(outside, 'utf8')).toBe('outside secret')
    },
  )

  test.skipIf(!canCreateSymlinks)(
    'a downloaded symlink cannot write through to a file outside the mirror',
    async () => {
      const ns = 'user:sync-symlink-download'
      const dir = tempDir()
      const state = join(tempDir(), 'state.json')
      const outside = join(tempDir(), 'outside.md')
      writeFileSync(outside, 'do not touch')
      touch(outside, Date.parse('2001-01-01T00:00:00.000Z'))
      const link = join(dir, 'evil.md')
      symlinkSync(outside, link)

      const other = await realClient()
      await other.push(ns, { 'evil.md': 'remote content' })

      const client = await realClient()
      const r = await runSync(dir, client, { namespace: ns, statePath: state })
      expect(r.downloadSkipped).toEqual([{ key: 'evil.md', reason: 'unsafe_key' }])
      expect(readFileSync(outside, 'utf8')).toBe('do not touch')
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
    },
  )

  test.skipIf(!canCreateSymlinks)(
    'a parent directory swapped after the download target is opened cannot redirect the write',
    async () => {
      const ns = 'user:sync-download-parent-swap'
      const dir = tempDir()
      const state = join(tempDir(), 'state.json')
      const outside = tempDir()
      const outsideFile = join(outside, 'note.md')
      writeFileSync(outsideFile, 'outside sentinel')

      const other = await realClient()
      await other.push(ns, { 'sub/note.md': 'remote content' })

      const client = await realClient()
      const r = await withFileStatHook(
        () => {
          // The destination is already open inside `dir/sub`. Replace that
          // parent with a symlink outside before the post-open verification
          // runs; the descriptor still points at the moved file inside the
          // mirror, but the path now resolves outside it.
          renameSync(join(dir, 'sub'), join(dir, 'sub-opened'))
          symlinkSync(outside, join(dir, 'sub'))
        },
        async arm => {
          arm()
          return runSync(dir, client, { namespace: ns, statePath: state })
        },
      )

      expect(r.downloaded).toEqual([])
      expect(r.downloadSkipped).toEqual([{ key: 'sub/note.md', reason: 'unsafe_key' }])
      // Nothing escaped: the outside file is unchanged, and the file that was
      // actually opened (now under the moved parent) was never written.
      expect(readFileSync(outsideFile, 'utf8')).toBe('outside sentinel')
      expect(readFileSync(join(dir, 'sub-opened', 'note.md'), 'utf8')).toBe('')
    },
  )
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

    // The state file now names both keys for THIS (dir, namespace) pair, with
    // the remote hash each key had when the sync succeeded.
    const stateKey = await syncStateKeyOf(dir, ns)
    const recorded = JSON.parse(readFileSync(state, 'utf8')) as {
      pairs: Record<string, Record<string, string | null>>
    }
    expect(Object.keys(recorded.pairs[stateKey] ?? {}).sort()).toEqual(['gone.md', 'keep.md'])
    for (const hash of Object.values(recorded.pairs[stateKey] ?? {}))
      expect(hash).toMatch(/^sha256:/)

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

  test('a remote write under a locally deleted key is downloaded, not pruned', async () => {
    const ns = 'user:sync-prune-changed'
    const dir = tempDir()
    const state = join(tempDir(), 'state.json')
    put(dir, 'note.md', 'v1')
    const client = await realClient()
    await runSync(dir, client, { namespace: ns, statePath: state })

    // The local file is deleted, but a remote agent writes a newer version
    // before the prune runs. Deleting it would destroy that write.
    rmSync(join(dir, 'note.md'))
    const other = await realClient()
    await other.push(ns, { 'note.md': 'v2 from another agent' })

    const r = await runSync(dir, client, { namespace: ns, statePath: state, prune: true })
    expect(r.pruned).toEqual([])
    expect(r.downloaded).toEqual([{ key: 'note.md', reason: 'remote-newer' }])
    expect(await readFileUtf8(dir, 'note.md')).toBe('v2 from another agent')
    expect((await other.pull(ns)).entries['note.md']).toBe('v2 from another agent')
  })

  test('a missing root with --prune deletes nothing', async () => {
    const ns = 'user:sync-prune-missing-root'
    const dir = tempDir()
    const state = join(tempDir(), 'state.json')
    put(dir, 'a.md', 'v1')
    const client = await realClient()
    await runSync(dir, client, { namespace: ns, statePath: state })

    rmSync(dir, { recursive: true, force: true })
    const r = await runSync(dir, client, { namespace: ns, statePath: state, prune: true })
    expect(r.pruned).toEqual([])
    expect((await (await realClient()).pull(ns)).entries['a.md']).toBe('v1')
  })

  test('an existing empty directory still prunes recorded keys', async () => {
    const ns = 'user:sync-prune-empty'
    const dir = tempDir()
    const state = join(tempDir(), 'state.json')
    put(dir, 'a.md', 'v1')
    const client = await realClient()
    await runSync(dir, client, { namespace: ns, statePath: state })

    rmSync(join(dir, 'a.md'))
    const r = await runSync(dir, client, { namespace: ns, statePath: state, prune: true })
    expect(r.pruned).toEqual(['a.md'])
    expect(Object.keys((await (await realClient()).pull(ns)).entries)).toEqual([])
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

  test('a key the store refused is not recorded as synced', async () => {
    const ns = 'user:sync-refused-state'
    const dir = tempDir()
    const state = join(tempDir(), 'state.json')
    // A space is a valid filename but not a valid entry key, so the store
    // refuses it after the walker has already found it.
    put(dir, 'bad key.md', 'refused by the store')

    const client = await realClient()
    const r = await runSync(dir, client, { namespace: ns, statePath: state })
    expect(r.skipped).toEqual([{ key: 'bad key.md', reason: 'invalid_key' }])

    const raw = JSON.parse(readFileSync(state, 'utf8')) as {
      pairs: Record<string, Record<string, string | null>>
    }
    const pair = Object.values(raw.pairs)[0] ?? {}
    expect(Object.hasOwn(pair, 'bad key.md')).toBe(false)
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

describe('runSync remote deletions', () => {
  test('a remote deletion is surfaced instead of being re-uploaded', async () => {
    const ns = 'user:sync-remote-delete'
    const dir = tempDir()
    const state = join(tempDir(), 'state.json')
    put(dir, 'keep.md', 'kept')
    put(dir, 'gone.md', 'deleted remotely later')
    const client = await realClient()
    await runSync(dir, client, { namespace: ns, statePath: state })

    const other = await realClient()
    await other.delete(ns, 'gone.md')

    const r = await runSync(dir, client, { namespace: ns, statePath: state })
    expect(r.remoteDeleted).toEqual(['gone.md'])
    expect(r.uploaded).toEqual([])
    expect(r.downloaded).toEqual([])
    expect(existsSync(join(dir, 'gone.md'))).toBe(true)
  })

  test('--prefer remote applies a remote deletion; --prefer local restores it', async () => {
    const ns = 'user:sync-remote-delete-prefer'
    const dir = tempDir()
    const state = join(tempDir(), 'state.json')
    put(dir, 'gone.md', 'local copy')
    const client = await realClient()
    await runSync(dir, client, { namespace: ns, statePath: state })

    const other = await realClient()
    await other.delete(ns, 'gone.md')

    const restore = await runSync(dir, client, {
      namespace: ns,
      statePath: state,
      prefer: 'local',
    })
    expect(restore.uploaded).toEqual([{ key: 'gone.md', reason: 'prefer-local' }])
    expect((await other.pull(ns)).entries['gone.md']).toBe('local copy')

    await other.delete(ns, 'gone.md')
    const remove = await runSync(dir, client, {
      namespace: ns,
      statePath: state,
      prefer: 'remote',
    })
    expect(remove.removedLocal).toEqual(['gone.md'])
    expect(existsSync(join(dir, 'gone.md'))).toBe(false)
    expect(Object.keys((await other.pull(ns)).entries)).toEqual([])
  })

  test('--prefer remote keeps a file edited while the sync is in flight', async () => {
    const ns = 'user:sync-remote-delete-edit'
    const dir = tempDir()
    const state = join(tempDir(), 'state.json')
    const path = put(dir, 'gone.md', 'local copy')
    const client = await realClient()
    await runSync(dir, client, { namespace: ns, statePath: state })

    const other = await realClient()
    await other.delete(ns, 'gone.md')

    let releaseMetadata: (() => void) | undefined
    const metadataGate = new Promise<void>(resolve => {
      releaseMetadata = resolve
    })
    let metadataStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => {
      metadataStarted = resolve
    })
    const delayed = new Proxy(client, {
      /** Hold the metadata read until the test edits the local file. */
      get(target, prop) {
        const value = Reflect.get(target, prop, target)
        if (prop === 'metadata') {
          return async (...args: unknown[]) => {
            metadataStarted?.()
            await metadataGate
            return (value as (...a: unknown[]) => Promise<unknown>).call(target, ...args)
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as InstanceType<typeof OpenRecallClient>

    const run = runSync(dir, delayed, {
      namespace: ns,
      statePath: state,
      prefer: 'remote',
    })
    await started
    // The local snapshot was taken before the metadata read; this edit lands
    // while that read is still in flight, so removal must recheck before rm.
    put(dir, 'gone.md', 'edited during the sync', Date.now() + 86_400_000)
    releaseMetadata?.()
    const r = await run

    expect(r.removedLocal).toEqual([])
    expect(r.remoteDeleted).toEqual(['gone.md'])
    expect(readFileSync(path, 'utf8')).toBe('edited during the sync')
  })
})

describe('sync state under concurrent syncs', () => {
  test('different pairs share one state file without losing baselines', async () => {
    const state = join(tempDir(), 'state.json')
    const cases = Array.from({ length: 8 }, (_, i) => {
      const dir = tempDir()
      const ns = `user:sync-state-race-${i}`
      put(dir, `note-${i}.md`, `content ${i}`)
      return { dir, ns, key: `note-${i}.md` }
    })

    // Read the file while the syncs replace it. A non-atomic in-place writer
    // can be caught mid-truncate here, producing invalid JSON.
    let polling = true
    const reader = (async () => {
      while (polling) {
        try {
          JSON.parse(readFileSync(state, 'utf8'))
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        }
        await new Promise(resolve => setTimeout(resolve, 1))
      }
    })()

    try {
      await Promise.all(
        cases.map(async ({ dir, ns }) => {
          const client = await realClient()
          await runSync(dir, client, { namespace: ns, statePath: state })
        }),
      )
    } finally {
      polling = false
      await reader
    }

    // Every pair's baseline survives: a final write that snapshotted the state
    // before another pair finished would erase that pair here.
    const recorded = JSON.parse(readFileSync(state, 'utf8')) as {
      pairs: Record<string, Record<string, string | null>>
    }
    for (const { dir, ns, key } of cases) {
      const stateKey = await syncStateKeyOf(dir, ns)
      expect(recorded.pairs[stateKey]?.[key]).toMatch(/^sha256:/)
    }
    expect(existsSync(`${state}.lock`)).toBe(false)
  })
})

describe('client.pull observation', () => {
  test('observe: false keeps the metadata base, so a concurrent write is refused', async () => {
    const ns = 'user:sync-pull-observe'
    const client = await realClient()
    await client.push(ns, { 'note.md': 'v1' })
    await client.metadata(ns)

    const other = await realClient()
    await other.push(ns, { 'note.md': 'v2' })

    const pulled = await client.pull(ns, { observe: false })
    expect(pulled.entries['note.md']).toBe('v2')
    // The base is still v1, so the delete must lose to the concurrent write.
    await expect(client.delete(ns, 'note.md')).rejects.toThrow()
    expect((await other.pull(ns)).entries['note.md']).toBe('v2')
  })

  test('a normal pull updates the base and the delete succeeds', async () => {
    const ns = 'user:sync-pull-observe-control'
    const client = await realClient()
    await client.push(ns, { 'note.md': 'v1' })
    await client.metadata(ns)

    const other = await realClient()
    await other.push(ns, { 'note.md': 'v2' })

    expect((await client.pull(ns)).entries['note.md']).toBe('v2')
    await client.delete(ns, 'note.md')
    expect(Object.keys((await other.pull(ns)).entries)).toEqual([])
  })
})

/** The state key for a pair, computed the way runSync computes it. */
async function syncStateKeyOf(dir: string, ns: string): Promise<string> {
  const { syncStateKey } = await import('../src/cli/sync.ts')
  return syncStateKey(dir, ns)
}
