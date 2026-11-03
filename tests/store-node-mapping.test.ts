/**
 * Node store driver: naming, wrapping and path mapping (the pure half).
 *
 * Everything here runs with no node present, which is the point: the parts of
 * the driver that decide what a namespace is called on the node, what an object
 * is encrypted under, and where it lands are pure functions of the store secret
 * and the store path, so they can be pinned exactly.
 *
 * The pins matter more than usual. The repo name is the only thing standing
 * between a node repo listing and the namespace it belongs to, so a silent swap
 * back to a plain hash (or to any other algorithm) has to turn a named test red
 * rather than merely change an opaque string. Every literal below was derived
 * from the spec independently of the implementation.
 */

import { describe, expect, test } from 'bun:test'
import { config, readNodeAcknowledgement, type StoreDriver } from '../src/config.ts'
import { sha256Hex } from '../src/hash.ts'
import { namespaceSlug } from '../src/namespace.ts'
import { usagePath } from '../src/quota.ts'
import { mapStorePath } from '../src/store/node-mapping.ts'
import {
  createNodeNaming,
  META_SCOPE,
  NODE_STORE_DESCRIPTION,
  resolveNodeConfig,
} from '../src/store/node-naming.ts'
import { PROBE_PREFIX } from '../src/store/probe.ts'

/** Fixed secret the literal vectors below were derived under. */
const SECRET = 'openrecall-test-store-secret'
const HEX64 = /^[0-9a-f]{64}$/

// Vectors derived from the spec (HMAC-SHA256 under the three labels) before the
// implementation existed. They pin the algorithm, not just the shape.
const PIN = {
  aliceSlug: 'dabd1db8d35ab13106274f61f1bf977812cce4f477b15014cf38fb796c50a4c4',
  aliceRepo: 'a565eccf068b5049e91a85a026e8bc0d56e68ab15bfb9c66a42f3d37c0e2b443',
  metaRepo: 'd2583536b74f59ed531f602a64f3ffc99525a91f0482f6f38fe40bf32f25bbda',
  aliceMemoryLeaf: '86fb05eb17729d51fe80d88a56c7fdafded8e15b409ae6ff6b75fc479367ef7b',
}

const naming = createNodeNaming(SECRET)

describe('node naming', () => {
  test('the historically colliding pair maps to different repo names (AE12)', () => {
    // The pair from docs/solutions/security-issues/namespace-storage-slug-injectivity.md:
    // both valid, owned by different accounts, and collapsed onto one storage
    // segment under the old lossy slug.
    const a = naming.repoName(namespaceSlug('user:a/b'))
    const b = naming.repoName(namespaceSlug('user:a__b'))

    expect(a).toMatch(HEX64)
    expect(b).toMatch(HEX64)
    expect(a).not.toBe(b)
  })

  test('every derived name is pinned to a literal, which is what guards the labels', () => {
    // Shape assertions pass against any hex-producing swap; these do not. This
    // is also the only thing that catches a label being reused for a second
    // purpose, since the parts are NUL-separated and a shared label still
    // yields distinct values.
    expect(namespaceSlug('user:alice')).toBe(PIN.aliceSlug)
    expect(naming.repoName(PIN.aliceSlug)).toBe(PIN.aliceRepo)
    expect(naming.metaRepoName()).toBe(PIN.metaRepo)
    expect(naming.entryLeaf(PIN.aliceSlug, 'MEMORY.md')).toBe(PIN.aliceMemoryLeaf)
  })

  test('naming is keyed: a second secret renames everything', () => {
    const other = createNodeNaming('a different store secret')
    expect(other.repoName(PIN.aliceSlug)).not.toBe(naming.repoName(PIN.aliceSlug))
    expect(other.metaRepoName()).not.toBe(naming.metaRepoName())
    expect(other.entryLeaf(PIN.aliceSlug, 'MEMORY.md')).not.toBe(
      naming.entryLeaf(PIN.aliceSlug, 'MEMORY.md'),
    )
  })

  test('no name is the unkeyed hash anyone holding the namespace could precompute', () => {
    // The revert this catches: dropping the secret and reusing namespaceSlug
    // (or sha256 of the entry key) makes every name confirmable by guessing,
    // which is what R10 forbids on the node.
    expect(naming.repoName(PIN.aliceSlug)).not.toBe(PIN.aliceSlug)
    expect(naming.repoName(PIN.aliceSlug)).not.toBe(sha256Hex(PIN.aliceSlug))
    expect(naming.repoName(PIN.aliceSlug)).not.toBe(sha256Hex('user:alice'))
    expect(naming.entryLeaf(PIN.aliceSlug, 'MEMORY.md')).not.toBe(sha256Hex('MEMORY.md'))
    expect(naming.entryLeaf(PIN.aliceSlug, 'MEMORY.md')).not.toBe(
      sha256Hex(`${PIN.aliceSlug}/MEMORY.md`),
    )
  })

  test('the meta repo cannot be reached by any namespace slug', () => {
    // META_SCOPE is outside the slug alphabet, so no namespace derives it.
    expect(META_SCOPE).not.toMatch(HEX64)
    expect(() => naming.repoName(META_SCOPE)).toThrow(/slug/)
  })

  test('the description is a fixed label with no url, owner or repo in it', () => {
    expect(NODE_STORE_DESCRIPTION).toBe('node')
    expect(NODE_STORE_DESCRIPTION).not.toContain(PIN.aliceRepo)
    expect(NODE_STORE_DESCRIPTION).not.toMatch(/https?:|\.|\//)
  })
})

describe('node config construction', () => {
  const ok = {
    secret: SECRET,
    identityPath: '/run/secrets/node.key',
    url: 'http://node:9000',
    acknowledged: true,
  }

  test('a complete config resolves', () => {
    expect(resolveNodeConfig(ok)).toEqual(ok)
  })

  test('a missing secret throws a message naming what the driver requires', () => {
    expect(() => resolveNodeConfig({ ...ok, secret: '' })).toThrow(
      /node store driver requires.*GITLAWB_NODE_STORE_SECRET/,
    )
  })

  test('a missing identity path throws a message naming what the driver requires', () => {
    expect(() => resolveNodeConfig({ ...ok, identityPath: '  ' })).toThrow(
      /node store driver requires.*GITLAWB_NODE_IDENTITY_PATH/,
    )
  })

  test('the failure names every missing setting, not only the first', () => {
    expect(() =>
      resolveNodeConfig({ secret: '', identityPath: '', url: '', acknowledged: true }),
    ).toThrow(/GITLAWB_NODE_STORE_SECRET.*GITLAWB_NODE_IDENTITY_PATH.*GITLAWB_NODE_URL/)
  })

  test('node storage is refused without an explicit acknowledgement', () => {
    // The three consequences are not recoverable and not obvious from the
    // config: an operator who reads only "STORE=node" learns none of them.
    expect(() => resolveNodeConfig({ ...ok, acknowledged: false })).toThrow(
      /GITLAWB_NODE_ACKNOWLEDGE/,
    )
  })

  test('the refusal names all three consequences, not just that one is missing', () => {
    let message = ''
    try {
      resolveNodeConfig({ ...ok, acknowledged: false })
    } catch (err) {
      message = (err as Error).message
    }
    // Deletion does not erase; anchors and pins cannot be retracted; the only
    // erasure is destroying the passphrase, which takes every namespace that
    // owner holds rather than the one entry they meant to remove. A gate that
    // says "you must acknowledge" without saying to what is a checkbox, not
    // consent.
    expect(message).toMatch(/delet\w+[^;]*(does not|never) erase|not erased/i)
    expect(message).toMatch(/anchor|pin/i)
    expect(message).toMatch(/passphrase/i)
    expect(message).toMatch(/every namespace|all .*namespaces/i)
  })

  test('the value the refusal tells you to set is the value that works', () => {
    // The first version of this gate said `=1` while the config reader accepts
    // only `true`, so following the instruction exactly would have left the
    // deployment refusing with the same message. A refusal that misdirects is
    // worse than no message.
    let message = ''
    try {
      resolveNodeConfig({ ...ok, acknowledged: false })
    } catch (err) {
      message = (err as Error).message
    }
    const told = /GITLAWB_NODE_ACKNOWLEDGE=(\S+?)[\s.,]/.exec(message)?.[1]
    expect(told).toBeTruthy()
    const before = process.env.GITLAWB_NODE_ACKNOWLEDGE
    try {
      process.env.GITLAWB_NODE_ACKNOWLEDGE = told
      expect(readNodeAcknowledgement()).toBe(true)
    } finally {
      process.env.GITLAWB_NODE_ACKNOWLEDGE = before
    }
  })

  test('acknowledging lets the same config through', () => {
    // The positive control: the refusal above is the acknowledgement and not
    // something else wrong with this config.
    expect(resolveNodeConfig({ ...ok, acknowledged: true }).acknowledged).toBe(true)
  })

  test('the failure message carries no secret material', () => {
    let message = ''
    try {
      resolveNodeConfig({ ...ok, identityPath: '' })
    } catch (err) {
      message = (err as Error).message
    }
    // Control: the message is non-empty, so the absence below is not vacuous.
    expect(message).toContain('GITLAWB_NODE_IDENTITY_PATH')
    expect(message).not.toContain(SECRET)
  })
})

describe('at-rest wrapping', () => {
  const slug = namespaceSlug('user:alice')
  const path = `ns/${slug}/manifest.json`
  // A manifest is cleartext entry keys, sizes and timestamps. This one carries a
  // sentinel path so the ciphertext check below has something definite to look
  // for rather than asserting the absence of an unspecified string.
  const SENTINEL = 'feedback/testing.md'
  const manifest = JSON.stringify({
    [SENTINEL]: { hash: 'sha256:00', size: 12, updatedAt: '2026-09-04T00:00:00.000Z' },
  })

  // A wrapped object produced from the spec independently of this code, so a
  // format or label change cannot pass by re-wrapping under its own new rules.
  // Regenerated for the openrecall/ labels and test secret by a separate
  // implementation of the spec, which first reproduced the previous literals
  // exactly from the memlawb/ ones.
  const PINNED_BLOB =
    'AQECAwQFBgcICQoLDAjGtLZffxq1WUjNJLgrbq63laiMiEjqWeSt0ipccuX2dG3ezyLkk6xYOvbFLeJpr2lYVJ6s5Snwk9lL'
  const PINNED_PLAINTEXT = '{"MEMORY.md":{"hash":"sha256:00","size":1}}'

  test('an object opens under its own store path', () => {
    const blob = naming.wrap(path, new TextEncoder().encode(manifest))
    expect(new TextDecoder().decode(naming.unwrap(path, blob))).toBe(manifest)
  })

  test('an object moved to another store path fails to open', () => {
    const blob = naming.wrap(path, new TextEncoder().encode(manifest))
    const elsewhere = `ns/${namespaceSlug('user:mallory')}/manifest.json`
    // Control: it opens where it belongs. Without this, dropping the binding
    // from one side only (which breaks every open) still satisfies "throws".
    expect(() => naming.unwrap(path, blob)).not.toThrow()
    expect(() => naming.unwrap(elsewhere, blob)).toThrow()
    // Same namespace, different object: the binding is to the whole path.
    expect(() => naming.unwrap(`ns/${slug}/blobs/${'0'.repeat(64)}`, blob)).toThrow()
  })

  test('an object does not open under a second store secret', () => {
    const blob = naming.wrap(path, new TextEncoder().encode(manifest))
    expect(() => createNodeNaming('a different store secret').unwrap(path, blob)).toThrow()
  })

  test('the ciphertext carries no entry key, with the plaintext as the control', () => {
    const blob = naming.wrap(path, new TextEncoder().encode(manifest))
    const wire = Buffer.from(blob).toString('binary')
    // Control first: without it, a wrap that produced nothing at all would pass
    // the absence assertion below.
    expect(manifest).toContain(SENTINEL)
    expect(wire.length).toBeGreaterThan(manifest.length)
    expect(wire).not.toContain(SENTINEL)
    expect(wire).not.toContain('updatedAt')
  })

  test('wrapping is randomised, so a rewrite does not advertise equality', () => {
    const a = Buffer.from(naming.wrap(path, new TextEncoder().encode(manifest)))
    const b = Buffer.from(naming.wrap(path, new TextEncoder().encode(manifest)))
    expect(a.equals(b)).toBe(false)
    // ... and both still open, so the randomness is in the nonce, not in the key.
    expect(new TextDecoder().decode(naming.unwrap(path, a))).toBe(manifest)
    expect(new TextDecoder().decode(naming.unwrap(path, b))).toBe(manifest)
  })

  test('the wrapped-object format and key derivation are pinned to a literal', () => {
    const opened = naming.unwrap(
      `ns/${PIN.aliceSlug}/manifest.json`,
      new Uint8Array(Buffer.from(PINNED_BLOB, 'base64')),
    )
    expect(new TextDecoder().decode(opened)).toBe(PINNED_PLAINTEXT)
  })

  test('a truncated or wrong-version object is refused rather than misread', () => {
    const blob = Buffer.from(naming.wrap(path, new TextEncoder().encode(manifest)))
    expect(() => naming.unwrap(path, blob.subarray(0, 20))).toThrow(/too short/)
    const bumped = Buffer.from(blob)
    bumped[0] = 0x02
    expect(() => naming.unwrap(path, bumped)).toThrow(/version/)
  })
})

describe('store path mapping', () => {
  const slug = namespaceSlug('user:alice')
  const ownerHash = sha256Hex('alice')
  const blobHash = 'a'.repeat(64)

  test('a namespace manifest lands in that namespace repo, wrapped', () => {
    expect(mapStorePath(naming, `ns/${slug}/manifest.json`)).toEqual({
      repo: naming.repoName(slug),
      path: 'manifest.json',
      wrap: true,
    })
  })

  test('an entry blob keeps its namespace repo and is never re-wrapped', () => {
    // Entry blobs arrive already encrypted by the client. Wrapping them again
    // would put a server-held key between a tenant and their own memory.
    expect(mapStorePath(naming, `ns/${slug}/blobs/${blobHash}`)).toEqual({
      repo: naming.repoName(slug),
      path: `blobs/${naming.entryLeaf(slug, blobHash)}`,
      wrap: false,
    })
    expect(mapStorePath(naming, `ns/${slug}/entries/${blobHash}`)).toEqual({
      repo: naming.repoName(slug),
      path: `entries/${naming.entryLeaf(slug, blobHash)}`,
      wrap: false,
    })
  })

  test('the in-repo leaf is not the plain hash a reader of the tree could precompute', () => {
    const mapped = mapStorePath(naming, `ns/${slug}/blobs/${blobHash}`)
    expect(mapped.path).not.toContain(blobHash)
    expect(mapped.path).not.toContain(sha256Hex(blobHash))
    expect(mapped.path.slice('blobs/'.length)).toMatch(HEX64)
  })

  test('the colliding pair lands in two different repos (AE12)', () => {
    const a = mapStorePath(naming, `ns/${namespaceSlug('user:a/b')}/manifest.json`)
    const b = mapStorePath(naming, `ns/${namespaceSlug('user:a__b')}/manifest.json`)
    expect(a.repo).toMatch(HEX64)
    expect(b.repo).toMatch(HEX64)
    expect(a.repo).not.toBe(b.repo)
    // Same in-repo path, so the repo name is the only thing separating them.
    expect(a.path).toBe(b.path)
  })

  test('the same entry key in two namespaces gets unrelated leaf names', () => {
    const a = mapStorePath(naming, `ns/${namespaceSlug('user:a/b')}/blobs/${blobHash}`)
    const b = mapStorePath(naming, `ns/${namespaceSlug('user:a__b')}/blobs/${blobHash}`)
    expect(a.path).not.toBe(b.path)
  })

  test('an owner usage record goes to the shared meta repo, wrapped', () => {
    expect(mapStorePath(naming, usagePath('alice'))).toEqual({
      repo: naming.metaRepoName(),
      path: `owners/${naming.entryLeaf(META_SCOPE, ownerHash)}.json`,
      wrap: true,
    })
  })

  test('a probe object goes to the shared meta repo', () => {
    const path = `${PROBE_PREFIX}0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0`
    expect(mapStorePath(naming, path)).toEqual({
      repo: naming.metaRepoName(),
      path,
      wrap: false,
    })
  })

  test('a path outside the three known prefixes throws', () => {
    // KTD6 refuses rather than defaulting: a fourth path family added elsewhere
    // in the server must fail loudly here, not land somewhere plausible.
    for (const path of ['acl/x/grant.json', 'manifest.json', 'nsx/a/manifest.json', '', 'ns']) {
      expect(() => mapStorePath(naming, path)).toThrow(/cannot map/)
    }
  })

  test('an unknown object inside a known namespace throws', () => {
    for (const path of [
      `ns/${slug}/index.json`,
      `ns/${slug}/blobs/a/b`,
      `ns/${slug}`,
      `ns/${slug}/`,
      `owners/${ownerHash}/other.json`,
      `owners/${ownerHash}`,
    ]) {
      expect(() => mapStorePath(naming, path)).toThrow(/cannot map/)
    }
  })

  test('a namespace segment that is not a slug throws', () => {
    const notASlug = /store path carries no namespace slug/
    expect(() => mapStorePath(naming, 'ns/user:alice/manifest.json')).toThrow(notASlug)
    expect(() => mapStorePath(naming, 'ns/../manifest.json')).toThrow(notASlug)
  })

  test('the refusal message names no namespace, owner or repo', () => {
    let message = ''
    try {
      mapStorePath(naming, `acl/${slug}/grant.json`)
    } catch (err) {
      message = (err as Error).message
    }
    // Control: the message exists and identifies the prefix an operator must fix.
    expect(message).toContain('acl/')
    expect(message).not.toContain(slug)
    expect(message).not.toContain(naming.metaRepoName())
  })
})

describe('node config wiring', () => {
  test('the node block reaches the driver from the environment', () => {
    // Pins the field names the driver reads and the test env that supplies
    // them. Without this the config group could be renamed with every other
    // test in this file still green, since they all build naming directly.
    expect(resolveNodeConfig(config.node)).toEqual({
      secret: 'test-node-store-secret',
      identityPath: '/dev/null',
      url: 'http://node.invalid',
      acknowledged: true,
    })
  })

  test("'node' is a store driver the config type accepts", () => {
    const driver: StoreDriver = 'node'
    expect(driver).toBe('node')
  })
})
