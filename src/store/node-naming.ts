/**
 * Node store driver: naming and at-rest wrapping.
 *
 * The gitlawb node is a storage location openrecall does not control the read
 * surface of: whoever runs it can list repos, and the node publishes some of
 * what it holds. Entry blobs are already client-encrypted, so content is safe
 * there by construction. Names and metadata are not, and that is what this
 * module exists for.
 *
 * A repo named `namespaceSlug(ns)` would be enumerable: the namespace grammar is
 * low entropy (`user:alice`), so anyone holding a repo name could confirm which
 * namespace it belongs to by hashing guesses. Naming the in-repo entry leaf
 * `sha256(entryKey)` has the same shape one level down: anyone who can read a
 * repo tree could confirm the namespace holds `feedback/testing.md` by
 * precomputing one hash. So every name the node sees is an HMAC under a
 * server-held store secret, and the leaf is bound to its namespace so the same
 * entry key looks unrelated across two namespaces.
 *
 * The names must also stay injective, for the reason recorded in
 * docs/solutions/security-issues/namespace-storage-slug-injectivity.md: a lossy
 * name transform once collapsed two namespaces onto one storage segment, which
 * is a tenant-isolation break. Keyed does not buy injective on its own, so the
 * derivation takes already-injective inputs (the sha256 slug, the full entry
 * leaf) and separates its parts with a byte that cannot occur in either.
 *
 * Three fixed labels, one secret, three purposes that must never collide:
 * repo name, wrapping key, entry leaf. Rotating the secret re-paths and
 * re-wraps everything, so it is rotatable only by migration.
 *
 * Nothing here moves key material toward the server's crypto-blind boundary.
 * The wrapping key covers the manifest and the usage record, which are stored
 * in cleartext today; entry blobs arrive already encrypted by the client and
 * are never re-wrapped, and this module has no passphrase parameter.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

/** Domain-separation labels. Changing one re-paths or orphans stored data. */
const REPO_LABEL = 'openrecall/node/repo-name/v1'
const WRAP_LABEL = 'openrecall/node/wrap-key/v1'
const LEAF_LABEL = 'openrecall/node/entry-leaf/v1'

/**
 * The scope the shared meta repo is named under. Namespace scopes are sha256
 * slugs, so this literal is outside their alphabet and no namespace can derive
 * the meta repo's name.
 */
export const META_SCOPE = 'meta'

/**
 * What the driver reports to logs and health. A store description is
 * operator-visible and `probe.ts` explains why the store's identity is not:
 * a fixed label carries no node url, owner DID or repo name.
 */
export const NODE_STORE_DESCRIPTION = 'node'

export const SLUG_RE = /^[0-9a-f]{64}$/

const WRAP_VERSION = 0x01
const NONCE_LEN = 12
const TAG_LEN = 16

export type NodeStoreConfig = {
  /** Derives every node-visible name and the wrapping key. Never leaves here. */
  secret: string
  /** Path to the signing identity the driver pushes under. Not the secret. */
  identityPath: string
  /** Base url of the node the driver clones from and pushes to. */
  url: string
  /**
   * The operator has acknowledged what node storage cannot undo. Not a
   * formality: the three consequences are irreversible and none of them are
   * visible from `STORE=node`, so this store refuses to construct without it.
   */
  acknowledged: boolean
}

/**
 * Prove the node driver has what it needs, naming everything that is missing.
 *
 * All of it or none: a driver that starts with a secret and no identity fails
 * later, at the first push, with tenant data already written under names the
 * operator cannot reproduce. The message names the environment variables
 * because that is what an operator can act on, and it carries no value.
 */
export function resolveNodeConfig(raw: NodeStoreConfig): NodeStoreConfig {
  const resolved = {
    secret: raw.secret.trim(),
    identityPath: raw.identityPath.trim(),
    url: raw.url.trim(),
    acknowledged: raw.acknowledged,
  }
  const missing = [
    resolved.secret ? '' : 'GITLAWB_NODE_STORE_SECRET',
    resolved.identityPath ? '' : 'GITLAWB_NODE_IDENTITY_PATH',
    resolved.url ? '' : 'GITLAWB_NODE_URL',
  ].filter(Boolean)
  if (missing.length > 0) {
    throw new Error(`node store driver requires ${missing.join(', ')}`)
  }
  // Consent, not a checkbox: the message states what is being agreed to. An
  // operator who reads only `STORE=node` learns none of this, and all three are
  // irreversible, so the refusal is the only place they are guaranteed to see
  // it. Checked after the settings above so a misconfigured deployment hears
  // about its missing secret rather than being asked to consent first.
  if (!resolved.acknowledged) {
    throw new Error(
      'node storage needs an explicit acknowledgement: set GITLAWB_NODE_ACKNOWLEDGE=true to ' +
        'confirm you accept that (1) deleting an entry does not erase it, since prior ' +
        'ciphertext stays in repository history; (2) any pin or anchor already taken is ' +
        'permanent and cannot be retracted; and (3) the only real erasure is destroying the ' +
        'passphrase, which destroys every namespace that owner holds, not the one entry you ' +
        'meant to remove.',
    )
  }
  return resolved
}

export type NodeNaming = {
  /** The node repo holding one namespace, given its `namespaceSlug`. */
  repoName(nsSlug: string): string
  /** The one shared repo holding owner usage records and the store probe. */
  metaRepoName(): string
  /** The in-repo leaf name for one object, bound to its namespace scope. */
  entryLeaf(scope: string, leaf: string): string
  /** Encrypt an at-rest object, bound to the store path it lives at. */
  wrap(storePath: string, plaintext: Uint8Array): Uint8Array
  /** Decrypt one. Throws if the object was moved to another store path. */
  unwrap(storePath: string, blob: Uint8Array): Uint8Array
}

export function createNodeNaming(secret: string): NodeNaming {
  const wrapKey = derive(secret, WRAP_LABEL, [])

  const nameFor = (scope: string) => derive(secret, REPO_LABEL, [scope]).toString('hex')

  return {
    repoName(nsSlug) {
      if (!SLUG_RE.test(nsSlug)) throw new Error('node repo name needs a sha256 namespace slug')
      return nameFor(nsSlug)
    },
    metaRepoName: () => nameFor(META_SCOPE),
    entryLeaf: (scope, leaf) => derive(secret, LEAF_LABEL, [scope, leaf]).toString('hex'),
    wrap: (storePath, plaintext) => wrap(wrapKey, storePath, plaintext),
    unwrap: (storePath, blob) => unwrap(wrapKey, storePath, blob),
  }
}

/**
 * HMAC-SHA256 over the label and each part, separated by NUL. Slugs, leaf names
 * and the meta scope are all NUL-free (namespace.ts rejects NUL in an entry key
 * and hex digests cannot contain one), so no two distinct part lists produce the
 * same message and the derivation stays injective.
 */
function derive(secret: string, label: string, parts: string[]): Buffer {
  const mac = createHmac('sha256', Buffer.from(secret, 'utf8'))
  mac.update(Buffer.from(label, 'utf8'))
  for (const part of parts) {
    mac.update(Buffer.from([0]))
    mac.update(Buffer.from(part, 'utf8'))
  }
  return mac.digest()
}

/**
 * AES-256-GCM with the store path as associated data, laid out the way
 * client/crypto.ts lays out an entry blob: version, nonce, tag, ciphertext.
 *
 * The path binding is the point. These objects go to a node as opaque files, and
 * an operator who can move one file over another could otherwise graft one
 * tenant's manifest onto another's namespace. Bound to the path, a moved object
 * fails to open instead of being read as the target's own.
 *
 * The nonce is random, unlike the client's. Nothing compares these objects by
 * ciphertext, so there is no delta-sync reason to make them deterministic, and
 * a random nonce keeps a rewritten manifest from advertising that it is
 * byte-identical to an earlier one.
 */
function wrap(key: Buffer, storePath: string, plaintext: Uint8Array): Uint8Array {
  const nonce = randomBytes(NONCE_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(storePath, 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([Buffer.from([WRAP_VERSION]), nonce, cipher.getAuthTag(), ct])
}

function unwrap(key: Buffer, storePath: string, blob: Uint8Array): Uint8Array {
  const buf = Buffer.from(blob)
  if (buf.length < 1 + NONCE_LEN + TAG_LEN) throw new Error('wrapped object too short')
  if (buf[0] !== WRAP_VERSION) throw new Error(`unsupported wrapped object version ${buf[0]}`)
  const nonce = buf.subarray(1, 1 + NONCE_LEN)
  const tag = buf.subarray(1 + NONCE_LEN, 1 + NONCE_LEN + TAG_LEN)
  const ct = buf.subarray(1 + NONCE_LEN + TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(Buffer.from(storePath, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}
