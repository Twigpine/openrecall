/**
 * Node store driver: store path -> node repo plus in-repo path.
 *
 * openrecall addresses everything by a flat store path; the node addresses things
 * by repo and path within it. The translation has one fixed shape: one
 * private repo per namespace, so a repo is the unit that can be created,
 * verified private and (if it ever came to it) deleted per tenant, and one
 * shared meta repo for the two things that belong to no namespace, the owner
 * usage records and the startup probe.
 *
 * The refusal is the load-bearing part. There are exactly three path families in
 * the server today (`ns/`, `owners/`, `probe/`), no module enumerates them, and
 * a fourth added later would otherwise land in whatever branch happened to be
 * the default: the wrong repo, or a namespace repo named after a segment that is
 * not a slug. So anything this module cannot positively account for throws, and
 * the node driver fails loudly instead of writing tenant data somewhere it can
 * neither be found nor unpublished.
 *
 * Names reaching the node are keyed (see node-naming.ts), which is why the
 * in-repo leaf is derived rather than carried through: passing the store path's
 * own leaf would put a precomputable hash of an entry key in a repo tree.
 * `manifest.json` is the one literal name, and it is the same in every repo, so
 * it identifies nothing about the namespace it belongs to.
 */

import { META_SCOPE, type NodeNaming, SLUG_RE } from './node-naming.ts'
import { PROBE_PREFIX } from './probe.ts'

/** Where one store object lives on the node, and whether the driver wraps it. */
export type NodeObject = {
  /** Node repo name, always a keyed hex string. */
  repo: string
  /** Path inside that repo. */
  path: string
  /**
   * Whether the driver encrypts this object at rest. True for the manifest and
   * the usage record, which are server-written cleartext metadata. False for
   * entry blobs, which the client already encrypted and which must never be
   * re-wrapped under a server-held key, and for the probe's random bytes.
   */
  wrap: boolean
}

const NS_PREFIX = 'ns/'
const OWNERS_PREFIX = 'owners/'

export function mapStorePath(naming: NodeNaming, storePath: string): NodeObject {
  const seg = storePath.split('/')

  if (storePath.startsWith(NS_PREFIX)) {
    const [, slug, ...rest] = seg
    if (!SLUG_RE.test(slug ?? '')) throw new Error('node store path carries no namespace slug')
    const repo = naming.repoName(slug)
    if (rest.length === 1 && rest[0] === 'manifest.json') {
      return { repo, path: 'manifest.json', wrap: true }
    }
    if (rest.length === 2 && (rest[0] === 'blobs' || rest[0] === 'entries') && rest[1]) {
      return { repo, path: `${rest[0]}/${naming.entryLeaf(slug, rest[1])}`, wrap: false }
    }
    throw refuse(NS_PREFIX)
  }

  if (storePath.startsWith(OWNERS_PREFIX)) {
    const [, ownerHash, ...rest] = seg
    if (!ownerHash || rest.length !== 1 || rest[0] !== 'usage.json') throw refuse(OWNERS_PREFIX)
    return {
      repo: naming.metaRepoName(),
      path: `owners/${naming.entryLeaf(META_SCOPE, ownerHash)}.json`,
      wrap: true,
    }
  }

  // The probe writes a random uuid it generated itself and reads the same bytes
  // straight back, so its leaf names nothing and needs no derivation.
  if (storePath.startsWith(PROBE_PREFIX)) {
    if (seg.length !== 2 || !seg[1]) throw refuse(PROBE_PREFIX)
    return { repo: naming.metaRepoName(), path: storePath, wrap: false }
  }

  throw refuse(`${seg[0]}/`)
}

/**
 * The message names the path family and nothing else. A store error commonly
 * ends up in a log line an operator reads, and a full store path carries a
 * namespace slug (probe.ts makes the same point about store failure details).
 */
function refuse(prefix: string): Error {
  return new Error(`node store cannot map a store path under "${prefix}"`)
}
