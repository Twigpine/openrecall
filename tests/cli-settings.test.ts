/**
 * Client settings (env > ~/.openrecall/config.json > defaults) and the
 * cross-process lock that keeps local mode safe when several agents share one
 * store.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withLockFile } from '../src/cli/local.ts'
import {
  configTooOpen,
  envOverrides,
  generatePassphrase,
  resolveSettings,
  writeConfigFile,
} from '../src/cli/settings.ts'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'openrecall-cli-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

describe('resolveSettings', () => {
  test('defaults: local store under OPENRECALL_HOME, no passphrase', () => {
    const home = tmp()
    const s = resolveSettings({ OPENRECALL_HOME: home })
    expect(s.url).toBe('local')
    expect(s.namespace).toBe('user:me')
    expect(s.scan).toBe('block')
    expect(s.passphrase).toBeUndefined()
    expect(s.dataDir).toBe(join(home, 'data'))
  })

  test('config file is read; env overrides it', () => {
    const home = tmp()
    writeConfigFile(home, {
      url: 'https://memory.example.com/',
      passphrase: 'from-file',
      namespace: 'user:alice',
    })
    const fromFile = resolveSettings({ OPENRECALL_HOME: home })
    expect(fromFile.url).toBe('https://memory.example.com')
    expect(fromFile.passphrase).toBe('from-file')

    const overridden = resolveSettings({
      OPENRECALL_HOME: home,
      OPENRECALL_PASSPHRASE: 'from-env',
      OPENRECALL_NAMESPACE: 'user:bob',
    })
    expect(overridden.passphrase).toBe('from-env')
    expect(overridden.namespace).toBe('user:bob')
    expect(overridden.url).toBe('https://memory.example.com') // file value still used
  })

  test('envOverrides reports which variables are set — names only, never values', () => {
    const names = envOverrides({
      OPENRECALL_PASSPHRASE: 'hunter2',
      OPENRECALL_URL: '  ',
      OPENRECALL_NAMESPACE: 'user:bob',
      UNRELATED: 'x',
    })
    expect(names).toEqual(['OPENRECALL_PASSPHRASE', 'OPENRECALL_NAMESPACE'])
    expect(names.join()).not.toContain('hunter2')
  })

  test('rejects bad urls and scan modes with actionable errors', () => {
    const home = tmp()
    expect(() => resolveSettings({ OPENRECALL_HOME: home, OPENRECALL_URL: 'ftp://x' })).toThrow(
      /local.*http/,
    )
    expect(() => resolveSettings({ OPENRECALL_HOME: home, OPENRECALL_SCAN: 'loud' })).toThrow(
      /block, warn, or off/,
    )
  })

  test('config file is written owner-only', () => {
    if (process.platform === 'win32') return
    const home = tmp()
    const path = writeConfigFile(home, { passphrase: generatePassphrase() })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(configTooOpen(path)).toBe(false)
  })

  test('generated passphrases are 256-bit and unique', () => {
    const a = generatePassphrase()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(generatePassphrase()).not.toBe(a)
  })
})

describe('withLockFile', () => {
  test('serializes critical sections', async () => {
    const lock = join(tmp(), '.lock')
    let inside = 0
    let maxInside = 0
    await Promise.all(
      Array.from({ length: 20 }, () =>
        withLockFile(lock, async () => {
          inside++
          maxInside = Math.max(maxInside, inside)
          await new Promise(r => setTimeout(r, 2))
          inside--
        }),
      ),
    )
    expect(maxInside).toBe(1)
    expect(existsSync(lock)).toBe(false)
  })

  test('breaks a stale lock directory left by an older version that crashed', async () => {
    // Before the lock was a file it was a directory made with mkdir; a mixed
    // pair during an upgrade must still contend, and a stale one still break.
    const lock = join(tmp(), '.lock')
    mkdirSync(lock)
    writeFileSync(join(lock, 'pid'), '99999')
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    expect(await withLockFile(lock, async () => 'ran')).toBe('ran')
    expect(existsSync(lock)).toBe(false)
  })

  test('breaks a stale lock file left by a crashed process', async () => {
    const lock = join(tmp(), '.lock')
    writeFileSync(lock, '99999 0123456789abcdef\n')
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    expect(await withLockFile(lock, async () => 'ran')).toBe('ran')
    expect(existsSync(lock)).toBe(false)
  })

  test('waits for a fresh lock and runs only after it is released', async () => {
    const lock = join(tmp(), '.lock')
    let release!: () => void
    const held = withLockFile(lock, () => new Promise<void>(r => (release = r)))
    while (!existsSync(lock)) await new Promise(r => setTimeout(r, 1))
    expect(readFileSync(lock, 'utf8')).toMatch(new RegExp(`^${process.pid} [0-9a-f]{16}\\n$`))

    let ranAt = 0
    const second = withLockFile(lock, async () => {
      ranAt = Date.now()
    })
    await new Promise(r => setTimeout(r, 150))
    expect(ranAt).toBe(0) // fresh, so waited on rather than broken
    const releasedAt = Date.now()
    release()
    await Promise.all([held, second])
    expect(ranAt).toBeGreaterThanOrEqual(releasedAt)
    expect(existsSync(lock)).toBe(false)
  })

  test('a fresh lock file from another process blocks until that process removes it', async () => {
    const lock = join(tmp(), '.lock')
    writeFileSync(lock, '99999 fedcba9876543210\n') // mtime is now: a live holder
    let ran = false
    const pending = withLockFile(lock, async () => {
      ran = true
    })
    await new Promise(r => setTimeout(r, 150))
    expect(ran).toBe(false)
    rmSync(lock)
    await pending
    expect(ran).toBe(true)
  })

  test('release leaves a lock another process took after breaking ours as stale', async () => {
    const lock = join(tmp(), '.lock')
    const theirs = '424242 ffffffffffffffff\n'
    await withLockFile(lock, async () => {
      // What a waiter that judged our lock stale leaves behind: its own stamp.
      writeFileSync(lock, theirs)
    })
    expect(readFileSync(lock, 'utf8')).toBe(theirs)
  })
})
