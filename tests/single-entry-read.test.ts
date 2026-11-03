/**
 * The bounded single-entry read (`GET /api/memory/:ns?view=entry&key=...`).
 *
 * Why this view exists: proving a passphrase can decrypt what is already stored
 * used to cost the whole namespace (up to 2000 entries / 10 MB, ~13 MB of
 * base64), because the only read returning ciphertext was the full one. The
 * server stays crypto-blind either way; this just bounds what it has to ship.
 *
 * What these tests defend, in order of how badly each has bitten this repo:
 *   - a denial must never render as success, and "namespace absent" must stay
 *     distinguishable from "namespace present, key absent" (`empty` vs
 *     `entry_not_found`), because clients treat only `empty` as "nothing yet"
 *   - the key is attacker-controlled and goes through validateEntryKey before
 *     it can name a path
 *   - authorization is the pre-existing gate, and this view sits inside it,
 *     which is driven here against a request that is actually refused rather
 *     than assumed (a subprocess, since config freezes auth mode at import)
 *   - the value is the same base64 ciphertext + checksum the full read gives,
 *     proven by decrypting it with the real client crypto
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ciphertextHash, decryptEntry, deriveKey, encryptEntry } from '../client/crypto.ts'
import { handleRequest } from '../src/handler.ts'
import { sha256Hex } from '../src/hash.ts'
import { upsert } from '../src/memory.ts'
import { namespaceSlug } from '../src/namespace.ts'
import { contentPath, entryPath, getStore } from '../src/store/index.ts'

const NOW = '2026-09-04T00:00:00.000Z'

type Body = {
  namespace?: string
  version?: number
  key?: string
  entry?: string
  entryChecksum?: string
  error?: { code?: string; message?: string }
}

async function read(ns: string, query: string): Promise<{ status: number; body: Body }> {
  const res = await handleRequest(
    new Request(`http://t/api/memory/${encodeURIComponent(ns)}?${query}`),
  )
  return { status: res.status, body: (await res.json()) as Body }
}

/** Store one ciphertext under `key` and hand back what was stored. */
async function seed(ns: string, entries: Record<string, string>) {
  return upsert(ns, namespaceSlug(ns), 'local', { entries }, NOW)
}

describe('single-entry read: happy path', () => {
  test('returns one entry the real client crypto can decrypt', async () => {
    const ns = 'user:entry-happy'
    const plaintext = 'the user prefers terse answers'
    const key = deriveKey('test-pass', ns)
    const ct = encryptEntry(key, 'notes/a.md', plaintext)
    const other = encryptEntry(key, 'notes/b.md', 'a second, unrelated note')
    await seed(ns, { 'notes/a.md': ct, 'notes/b.md': other })

    const { status, body } = await read(ns, 'view=entry&key=notes/a.md')

    expect(status).toBe(200)
    expect(body.key).toBe('notes/a.md')
    expect(body.namespace).toBe(ns)
    expect(body.version).toBe(1)
    // Same encoding the full read uses, so an existing client hashes and
    // decrypts it unchanged.
    expect(body.entry).toBe(ct)
    expect(body.entryChecksum).toBe(ciphertextHash(ct))
    expect(decryptEntry(key, 'notes/a.md', body.entry as string)).toBe(plaintext)
  })

  test('the read is bounded: the sibling entry is not in the response at all', async () => {
    // The whole reason this view exists. If it answered with the full payload
    // the assertions above would still pass, so this is the one that fails when
    // the bound is lost.
    const ns = 'user:entry-bounded'
    const key = deriveKey('test-pass', ns)
    const wanted = encryptEntry(key, 'wanted.md', 'wanted')
    const unwanted = encryptEntry(key, 'unwanted.md', 'unwanted, and much longer')
    await seed(ns, { 'wanted.md': wanted, 'unwanted.md': unwanted })

    const res = await handleRequest(
      new Request(`http://t/api/memory/${ns}?view=entry&key=wanted.md`),
    )
    const raw = await res.text()

    expect(raw).toContain(wanted)
    expect(raw).not.toContain(unwanted)
    expect(raw).not.toContain('unwanted.md')
  })

  // Sanity, not a load-bearing guard, and labelled so nobody reads it as one:
  // no mutation of this view can make it fail, because the server never holds
  // plaintext to leak. It pins the contract, and the two tests above are what
  // actually go red when the view breaks.
  test('the server never sees plaintext on this path either', async () => {
    const ns = 'user:entry-blind'
    const key = deriveKey('test-pass', ns)
    await seed(ns, { 'secret.md': encryptEntry(key, 'secret.md', 'launch code 12345') })
    const res = await handleRequest(
      new Request(`http://t/api/memory/${ns}?view=entry&key=secret.md`),
    )
    expect(await res.text()).not.toContain('launch code')
  })
})

describe('single-entry read: refusals stay distinguishable', () => {
  test('a namespace that does not exist answers 404 empty', async () => {
    const { status, body } = await read('user:entry-nothing-here', 'view=entry&key=a.md')
    expect(status).toBe(404)
    expect(body.error?.code).toBe('empty')
    expect(body.entry).toBeUndefined()
  })

  test('a key that does not exist in a namespace that does answers 404 entry_not_found', async () => {
    const ns = 'user:entry-present'
    const key = deriveKey('test-pass', ns)
    await seed(ns, { 'present.md': encryptEntry(key, 'present.md', 'here') })

    const { status, body } = await read(ns, 'view=entry&key=absent.md')
    expect(status).toBe(404)
    // The distinguishability that matters: a client treats only `empty` as
    // "nothing stored yet", so a missing key must not borrow that code.
    expect(body.error?.code).toBe('entry_not_found')
    expect(body.error?.code).not.toBe('empty')
    expect(body.entry).toBeUndefined()
  })

  test('the two 404s differ for the same key, so only the namespace explains it', async () => {
    const ns = 'user:entry-pairwise'
    const key = deriveKey('test-pass', ns)
    await seed(ns, { 'other.md': encryptEntry(key, 'other.md', 'x') })
    const present = await read(ns, 'view=entry&key=same.md')
    const absent = await read('user:entry-pairwise-missing', 'view=entry&key=same.md')
    expect(present.body.error?.code).toBe('entry_not_found')
    expect(absent.body.error?.code).toBe('empty')
    expect(present.body.error?.code).not.toBe(absent.body.error?.code)
  })

  test('no key at all is a 400, not an empty success', async () => {
    const ns = 'user:entry-nokey'
    const key = deriveKey('test-pass', ns)
    await seed(ns, { 'a.md': encryptEntry(key, 'a.md', 'x') })
    const { status, body } = await read(ns, 'view=entry')
    expect(status).toBe(400)
    expect(body.error?.code).toBe('bad_request')
    expect(body.entry).toBeUndefined()
  })
})

describe('single-entry read: the key is attacker-controlled', () => {
  const traversal = [
    'a/../../etc/passwd', // passes the charset, caught by the ".." rule
    '../secret.md', // caught by the leading-character rule
    'a//b.md',
    '/etc/passwd',
    'a\\b.md',
  ]

  for (const bad of traversal) {
    test(`a traversal-shaped key is refused before it names a path: ${JSON.stringify(bad)}`, async () => {
      const ns = 'user:entry-traversal'
      const key = deriveKey('test-pass', ns)
      await seed(ns, { 'a.md': encryptEntry(key, 'a.md', 'x') })

      const { status, body } = await read(ns, `view=entry&key=${encodeURIComponent(bad)}`)
      // Without validateEntryKey these all reach the manifest lookup and come
      // back 404 entry_not_found, so 400/invalid_key is what proves the guard
      // ran rather than the key merely being absent.
      expect(status).toBe(400)
      expect(body.error?.code).toBe('invalid_key')
      expect(body.entry).toBeUndefined()
    })
  }

  test('an ordinary nested key is NOT refused', async () => {
    // Negative control: a guard that rejects everything passes every case above.
    const ns = 'user:entry-ordinary'
    const key = deriveKey('test-pass', ns)
    const ct = encryptEntry(key, 'feedback/2026-09-04.md', 'ok')
    await seed(ns, { 'feedback/2026-09-04.md': ct })
    const { status, body } = await read(ns, 'view=entry&key=feedback/2026-09-04.md')
    expect(status).toBe(200)
    expect(body.entry).toBe(ct)
  })
})

describe('single-entry read: storage reality', () => {
  test('manifest/blob drift answers 503 entry_unreadable, never a silent empty', async () => {
    const ns = 'user:entry-drift'
    const nsSlug = namespaceSlug(ns)
    const key = deriveKey('test-pass', ns)
    const ct = encryptEntry(key, 'gone.md', 'this body will be removed')
    await seed(ns, { 'gone.md': ct })
    // Remove the body the manifest still names, leaving the drift the full read
    // silently skips.
    await getStore().delete(contentPath(nsSlug, ciphertextHash(ct)))

    const { status, body } = await read(ns, 'view=entry&key=gone.md')
    expect(status).toBe(503)
    expect(body.error?.code).toBe('entry_unreadable')
    expect(body.entry).toBeUndefined()
    // And it must not masquerade as either flavour of "not there".
    expect(body.error?.code).not.toBe('empty')
    expect(body.error?.code).not.toBe('entry_not_found')
  })

  test('an entry written under the pre-content-addressing layout still reads', async () => {
    const ns = 'user:entry-legacy'
    const nsSlug = namespaceSlug(ns)
    const key = deriveKey('test-pass', ns)
    const ct = encryptEntry(key, 'legacy.md', 'written before content addressing')
    await seed(ns, { 'legacy.md': ct })
    // Move the blob to where the old layout put it: keyed by sha256(entryKey).
    const bytes = new Uint8Array(Buffer.from(ct, 'base64'))
    await getStore().put(entryPath(nsSlug, sha256Hex('legacy.md')), bytes)
    await getStore().delete(contentPath(nsSlug, ciphertextHash(ct)))

    const { status, body } = await read(ns, 'view=entry&key=legacy.md')
    expect(status).toBe(200)
    expect(body.entry).toBe(ct)
    expect(body.entryChecksum).toBe(ciphertextHash(ct))
    expect(decryptEntry(key, 'legacy.md', body.entry as string)).toBe(
      'written before content addressing',
    )
  })
})

/**
 * Authorization has to be driven against a request that is really refused, and
 * this process runs with ALLOW_UNAUTHENTICATED=true (owner `local` owns
 * everything) with config frozen at import. So: a child process with static
 * keys, driving the same handler.
 */
describe('single-entry read: authorization', () => {
  const SCRIPT = `
    const { handleRequest } = await import(process.cwd() + '/src/handler.ts')
    const { upsert } = await import(process.cwd() + '/src/memory.ts')
    const { namespaceSlug } = await import(process.cwd() + '/src/namespace.ts')
    const ct = Buffer.from('ciphertext-for-alice').toString('base64')
    await upsert('user:alice', namespaceSlug('user:alice'), 'alice',
      { entries: { 'a.md': ct } }, '${NOW}')
    await upsert('user:bob', namespaceSlug('user:bob'), 'bob',
      { entries: { 'a.md': Buffer.from('ciphertext-for-bob').toString('base64') } }, '${NOW}')
    const call = async (ns, token) => {
      const res = await handleRequest(new Request(
        'http://t/api/memory/' + ns + '?view=entry&key=a.md',
        token ? { headers: { authorization: 'Bearer ' + token } } : {},
      ))
      const body = await res.json()
      return [res.status, body.error?.code ?? 'ok', body.entry ?? null]
    }
    console.log(JSON.stringify({
      own: await call('user:alice', 'tok-alice'),
      other: await call('user:bob', 'tok-alice'),
      anon: await call('user:alice', null),
      ct,
    }))
  `

  test('the view sits inside authorizeNamespace: another owner is refused, its own is not', async () => {
    const proc = Bun.spawn(['bun', '-e', SCRIPT], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        STORE: 'fs',
        DATA_DIR: mkdtempSync(join(tmpdir(), 'openrecall-entry-auth-')),
        ALLOW_UNAUTHENTICATED: 'false',
        STATIC_API_KEYS: 'alice:tok-alice,bob:tok-bob',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = await new Response(proc.stdout).text()
    const err = await new Response(proc.stderr).text()
    expect(await proc.exited, `stderr: ${err}`).toBe(0)
    const r = JSON.parse(out.trim().split('\n').pop() as string) as {
      own: [number, string, string | null]
      other: [number, string, string | null]
      anon: [number, string, string | null]
      ct: string
    }

    // Refused for a namespace this key does not own, and no ciphertext with it.
    expect(r.other).toEqual([403, 'forbidden', null])
    // Refused with no key at all.
    expect(r.anon).toEqual([401, 'unauthorized', null])
    // And granted for its own, so the 403 above is the authorization rule
    // rather than the view being broken for every caller.
    expect(r.own).toEqual([200, 'ok', r.ct])
  }, 30_000)
})
