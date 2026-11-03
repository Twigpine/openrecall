/**
 * The node store driver against a real gitlawb node.
 *
 * Everything that needs a node is opt-in: set OPENRECALL_NODE_TEST_URL and
 * OPENRECALL_NODE_TEST_IDENTITY and the live block runs, otherwise it is skipped so
 * CI without a node stays green. A skipped suite proves nothing, so the skip is
 * loud (a banner on stderr) and the live block ends by asserting the node was
 * really reached: every live test drives its traffic through a local TCP proxy
 * that counts connections, and a run that never opened one is a run where the
 * driver did nothing.
 *
 * Two fixtures have to exist on the node under test, and beforeAll refuses the
 * run with the exact repo names if they do not: a deliberately PUBLIC namespace
 * repo holding one file called ctl.txt, and a deliberately PUBLIC meta repo.
 * They are the positive control for AE5 (a repo the node really does publish)
 * and the subject of the cold-open refusals. Repo names are keyed, so both are
 * named by running createNodeNaming with the two control secrets below.
 *
 * Repos are named from fixed secrets on purpose. The node rate-limits repo
 * creation and pushes, so a run reuses the repos an earlier run made instead of
 * creating fresh ones, and every assertion is written to survive the leftovers.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { sha256Hex, sha256Prefixed } from '../src/hash.ts'
import { getData, getHashes, upsert } from '../src/memory.ts'
import { namespaceSlug } from '../src/namespace.ts'
import type { BlobStore } from '../src/store/blobstore.ts'
import { blobPrefix, contentPath, manifestPath } from '../src/store/blobstore.ts'
import { createStore, resetStore, setStore } from '../src/store/index.ts'
import { NodeBlobStore } from '../src/store/node.ts'
import { createNodeNaming } from '../src/store/node-naming.ts'

/** The identity's DID, read from the identity the run was pointed at rather
 *  than pinned, so the probes cannot end up aimed at someone else's repos. */
let OWNER_DID = ''
let OWNER_SHORT = ''

describe('store factory driver selection', () => {
  test('an unrecognized driver name refuses rather than serving the filesystem', () => {
    expect(() => createStore('fsx')).toThrow(/unknown store driver/i)
  })

  // Negative control: the refusal must not be a blanket throw. Each known name
  // still builds its own driver, so a default branch that swallowed everything
  // would fail here rather than pass the test above.
  test('each known driver name still builds its own driver', () => {
    expect(createStore('fs').describe()).toStartWith('fs:')
    expect(createStore('node').describe()).toBe('node')
    expect(createStore('node').erasure).toBe('retains')
  })
})

describe('the subprocess environment', () => {
  test('carries only the node target and the identity path, never the store secret', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openrecall-node-env-'))
    const dump = join(dir, 'env.txt')
    // A stand-in for gl that records what it was handed and answers "absent",
    // so a read completes without a node.
    writeFileSync(
      join(dir, 'gl'),
      `#!/bin/sh\n/usr/bin/env > ${dump}\necho "Error: repository 'x' not found" >&2\nexit 1\n`,
      { mode: 0o755 },
    )
    const path = process.env.PATH
    process.env.PATH = `${dir}:/usr/bin:/bin`
    try {
      const store = new NodeBlobStore(
        {
          secret: 'the-store-secret-value',
          identityPath: '/keys/identity.pem',
          url: 'http://node.test',
          acknowledged: true,
        },
        { workdir: dir },
      )
      expect(await store.get(manifestPath(namespaceSlug('user:envcheck')))).toBeNull()
    } finally {
      process.env.PATH = path
    }

    const seen = readFileSync(dump, 'utf8').trim().split('\n')
    const names = seen.map(l => l.slice(0, l.indexOf('='))).sort()
    // An exact set, not a denylist: a variable added to the allowlist later has
    // to be looked at here rather than inherited silently.
    expect(names).toEqual([
      'GITLAWB_KEY',
      'GITLAWB_NODE',
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_SYSTEM',
      'GIT_TERMINAL_PROMPT',
      'HOME',
      'PATH',
      'PWD',
    ])
    expect(seen).toContain('GITLAWB_KEY=/keys/identity.pem')
    expect(seen).toContain('GITLAWB_NODE=http://node.test')
    // The value that names and wraps every tenant's data is one `ps` away from
    // anyone on the box if a child inherits it.
    expect(readFileSync(dump, 'utf8')).not.toContain('the-store-secret-value')
    rmSync(dir, { recursive: true, force: true })
  })
})

// ── Live harness ────────────────────────────────────────────────────────────

const NODE_URL = process.env.OPENRECALL_NODE_TEST_URL?.trim()
const IDENTITY = process.env.OPENRECALL_NODE_TEST_IDENTITY?.trim()
const live = Boolean(NODE_URL && IDENTITY)
if (!live) {
  console.warn(
    '\n!! tests/store-node.test.ts: the node driver suite did NOT run.\n' +
      '!! Set OPENRECALL_NODE_TEST_URL and OPENRECALL_NODE_TEST_IDENTITY to run it.\n',
  )
}
if (process.env.OPENRECALL_NODE_TEST_BIN) {
  process.env.PATH = `${process.env.OPENRECALL_NODE_TEST_BIN}:${process.env.PATH ?? ''}`
}

/**
 * A TCP proxy in front of the node. Two jobs: it counts connections, which is
 * the only evidence this suite reached a node at all rather than passing on a
 * driver that never ran, and flipping it unreachable is how the push-failure
 * test breaks the node mid-write without touching the node itself.
 */
type Proxy = {
  url: string
  connections: () => number
  setReachable: (v: boolean) => void
  /** Rewrite the node's answer so it reports every repo public. Same byte
   *  length, so content-length stays right. The node exposes no way to flip a
   *  repo's visibility, so this is how "flipped public mid-process" is staged. */
  setPublicRewrite: (v: boolean) => void
  rewrites: () => number
  /** Kill any request that carries a git push, leaving the signed record reads
   *  working. This is what makes the push itself fail rather than the check in
   *  front of it, which is the only way to test what a failed push leaves. */
  setPushBroken: (v: boolean) => void
  stop: () => void
}

const PRIVATE_JSON = Buffer.from('"is_public":false')
// One byte longer than `true`, so a space keeps the length and the JSON valid.
const PUBLIC_JSON = Buffer.from('"is_public":true ')

async function startProxy(target: string): Promise<Proxy> {
  const t = new URL(target)
  const port = Number(t.port || (t.protocol === 'https:' ? 443 : 80))
  let count = 0
  let reachable = true
  let rewrite = false
  let rewrites = 0
  let pushBroken = false

  function forge(d: Uint8Array): Uint8Array {
    if (!rewrite) return d
    const buf = Buffer.from(d)
    let at = buf.indexOf(PRIVATE_JSON)
    while (at !== -1) {
      PUBLIC_JSON.copy(buf, at)
      rewrites++
      at = buf.indexOf(PRIVATE_JSON, at + 1)
    }
    return buf
  }
  type Conn = { up?: { write: (d: Uint8Array) => void; end: () => void }; pending: Uint8Array[] }
  const server = Bun.listen<Conn>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      async open(sock) {
        count++
        sock.data = { pending: [] }
        if (!reachable) {
          sock.end()
          return
        }
        try {
          const up = await Bun.connect({
            hostname: t.hostname,
            port,
            socket: {
              data: (_u, d) => void sock.write(forge(d)),
              close: () => void sock.end(),
              error: () => void sock.end(),
            },
          })
          if (!reachable) {
            up.end()
            sock.end()
            return
          }
          sock.data.up = up
          for (const p of sock.data.pending) up.write(p)
          sock.data.pending = []
        } catch {
          sock.end()
        }
      },
      data(sock, d) {
        if (pushBroken && /(?:^|\r\n)POST \//.test(Buffer.from(d).toString('latin1'))) {
          sock.data.up?.end()
          sock.end()
          return
        }
        if (sock.data.up) sock.data.up.write(d)
        else sock.data.pending.push(new Uint8Array(d))
      },
      close: sock => void sock.data?.up?.end(),
      error: sock => void sock.data?.up?.end(),
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    connections: () => count,
    setReachable: v => {
      reachable = v
    },
    setPublicRewrite: v => {
      rewrite = v
    },
    setPushBroken: v => {
      pushBroken = v
    },
    rewrites: () => rewrites,
    stop: () => server.stop(true),
  }
}

class Boom extends Error {}

/** Wraps a store and throws on the nth mutating call, counting attempts. The
 *  count is what evidences the plant: an injection the write never reached
 *  would leave the state untouched and look identical to a clean refusal. */
function faulty(inner: BlobStore, failAt: number) {
  let calls = 0
  const guard = () => {
    if (calls++ === failAt) throw new Boom(`injected at ${failAt}`)
  }
  return {
    calls: () => calls,
    store: {
      get: (p: string) => inner.get(p),
      put: async (p: string, b: Uint8Array) => {
        guard()
        return inner.put(p, b)
      },
      delete: async (p: string) => {
        guard()
        return inner.delete(p)
      },
      list: (p: string) => inner.list(p),
      describe: () => `faulty(${inner.describe()})`,
      erasure: inner.erasure,
    } as BlobStore,
  }
}

/** Run a command with gl/git on PATH, returning its captured output. */
async function run(argv: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(argv, {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  return { code: await p.exited, out, err }
}

const IDENTITY_DIR = IDENTITY ? dirname(IDENTITY) : ''

/** Clone one repo fresh into a scratch dir and hand back the path. */
async function cloneFresh(repo: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'openrecall-node-peek-'))
  workdirs.push(dir)
  const env = { GITLAWB_NODE: NODE_URL ?? '', GITLAWB_KEY: IDENTITY ?? '' }
  const c = await run(
    ['git', 'clone', '--quiet', `gitlawb://${OWNER_DID}/${repo}`, join(dir, 'c')],
    env,
  )
  if (c.code !== 0) throw new Error(`could not clone ${repo}: ${c.err}`)
  return join(dir, 'c')
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'

function base32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

/**
 * The CIDv1 the node pins a git object under: raw codec, sha2-256 over the
 * object's content. Pinned against the public control repo below, so this is
 * the node's real addressing rather than a guess.
 */
function cidOf(content: Uint8Array): string {
  const digest = createHash('sha256').update(content).digest()
  return `b${base32(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]))}`
}

/** Every git object in a clone, as `oid type`. One command, because the repos
 *  under test grow by a commit per write and this runs over all of them. */
async function objectIds(dir: string): Promise<{ oid: string; type: string }[]> {
  const listed = await run(['git', '-C', dir, 'cat-file', '--batch-all-objects', '--batch-check'])
  const out: { oid: string; type: string }[] = []
  for (const line of listed.out.trim().split('\n')) {
    const [oid, type] = line.split(' ')
    if (oid && type) out.push({ oid, type })
  }
  return out
}

/** The CID the node would pin one object under. */
async function objectCid(dir: string, o: { oid: string; type: string }): Promise<string> {
  const p = Bun.spawn(['git', '-C', dir, 'cat-file', o.type, o.oid], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const content = new Uint8Array(await new Response(p.stdout).arrayBuffer())
  await p.exited
  return cidOf(content)
}

/** The node rate-limits unsigned reads, and a 429 is not an answer to "is this
 *  published". Back off and ask again rather than record it as a not-found. */
async function probe(path: string): Promise<Response> {
  for (let i = 0; ; i++) {
    const r = await fetch(`${NODE_URL}${path}`)
    if (r.status !== 429 || i === 2) return r
    const after = Number(r.headers.get('retry-after') ?? '1')
    await r.arrayBuffer()
    // Capped well under the node's retry-after: the one route that rate-limits
    // hard is /ipfs, and its probe is gated on a control that reports the 429
    // rather than treating it as an answer, so waiting minutes buys nothing.
    await Bun.sleep(Math.min(Number.isFinite(after) ? after : 1, 5) * 1_000)
  }
}

async function statusOf(path: string): Promise<number> {
  const r = await probe(path)
  await r.arrayBuffer()
  return r.status
}

async function textOf(path: string): Promise<string> {
  return (await probe(path)).text()
}

/** The unsigned routes that could publish a repo, as a closed list. Each is
 *  built for one repo and one in-repo path, so the same probe runs against the
 *  driver's private repo and against the public control. */
function surfaces(repo: string, path: string): { name: string; url: string }[] {
  const base = `/api/v1/repos/${OWNER_SHORT}/${repo}`
  return [
    { name: 'repo record', url: base },
    { name: 'tree', url: `${base}/tree` },
    { name: 'blob', url: `${base}/blob/${path}` },
    { name: 'commits', url: `${base}/commits` },
    { name: 'refs', url: `${base}/refs` },
    { name: 'replicas', url: `${base}/replicas` },
    {
      name: 'git advertisement',
      url: `/${OWNER_SHORT}/${repo}.git/info/refs?service=git-upload-pack`,
    },
  ]
}

/** Commits on the repo's main branch, read by cloning it fresh. Counting from
 *  the node rather than from the driver's own clone is what makes "the push
 *  landed" different from "the driver thinks it landed". */
async function remoteCommits(repo: string): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'openrecall-node-count-'))
  workdirs.push(dir)
  const url = `gitlawb://${OWNER_DID}/${repo}`
  const env = { GITLAWB_NODE: NODE_URL ?? '', GITLAWB_KEY: IDENTITY ?? '' }
  const cloned = await run(['git', 'clone', '--quiet', url, join(dir, 'c')], env)
  if (cloned.code !== 0) throw new Error(`could not clone ${repo}: ${cloned.err}`)
  const n = await run(['git', '-C', join(dir, 'c'), 'rev-list', '--count', 'HEAD'], env)
  return n.code === 0 ? Number(n.out.trim()) : 0
}

/** What the node itself says about a repo, independent of the driver. */
async function repoVisibility(repo: string): Promise<'absent' | 'public' | 'private'> {
  const r = await run(['gl', 'repo', 'info', repo, '--node', NODE_URL ?? '', '--dir', IDENTITY_DIR])
  if (r.code !== 0) return 'absent'
  return /Public:\s+true/.test(r.out) ? 'public' : 'private'
}

/** Repo names are keyed, so a fixed secret is what makes a run reuse repos.
 *  The node rate-limits repo creation, so every live test names its repos from
 *  this one secret rather than a fresh one per run. */
const LIVE_SECRET = 'openrecall-u19-live'
/** Two repos that already exist on the node, deliberately public. */
const PUBLIC_NS_SECRET = 'openrecall-u19-public-control'
const PUBLIC_NS = 'user:ae5public'
const PUBLIC_META_SECRET = 'openrecall-u19-meta-public-control'

let proxy: Proxy
const workdirs: string[] = []

/** Where a driver put its clone of one repo, so a test can read the tree the
 *  node actually holds rather than only what the driver hands back. */
function workdirOf(store: NodeBlobStore): string {
  return (store as unknown as { workdirOption: string }).workdirOption
}

function secondClone(store: NodeBlobStore, repo: string): string {
  return join(workdirOf(store), repo)
}

function newDriver(secret = LIVE_SECRET): NodeBlobStore {
  const workdir = mkdtempSync(join(tmpdir(), 'openrecall-node-'))
  workdirs.push(workdir)
  return new NodeBlobStore(
    { secret, identityPath: IDENTITY as string, url: proxy.url, acknowledged: true },
    { workdir },
  )
}

describe.skipIf(!live)('node driver against a real node', () => {
  beforeAll(async () => {
    proxy = await startProxy(NODE_URL as string)
    const who = await run(['gl', 'whoami', '--dir', IDENTITY_DIR])
    const did = /did:key:[1-9A-HJ-NP-Za-km-z]+/.exec(who.out)
    if (!did) throw new Error(`could not read the test identity's DID: ${who.err}`)
    OWNER_DID = did[0]
    OWNER_SHORT = OWNER_DID.slice('did:key:'.length)

    // The two deliberately-public fixtures. They are what every refusal test and
    // AE5's positive control stand on, so a run without them would assert
    // absence against repos that simply are not there.
    for (const [secret, repo] of [
      [PUBLIC_NS_SECRET, createNodeNaming(PUBLIC_NS_SECRET).repoName(namespaceSlug(PUBLIC_NS))],
      [PUBLIC_META_SECRET, createNodeNaming(PUBLIC_META_SECRET).metaRepoName()],
    ] as [string, string][]) {
      if ((await repoVisibility(repo)) !== 'public') {
        throw new Error(
          `fixture missing: create repo ${repo} PUBLIC on the node under test ` +
            `(it is the keyed name for store secret "${secret}"), and push one ` +
            'file named ctl.txt to the namespace one',
        )
      }
    }
  })
  afterAll(() => {
    proxy?.stop()
    for (const d of workdirs) rmSync(d, { recursive: true, force: true })
  })

  test('a read of a namespace nothing has written finds nothing and creates nothing', async () => {
    // Reads must not create repos: the node rate-limits creation, and a read of
    // an absent namespace happens on every request for one.
    const secret = `${LIVE_SECRET}-never-written`
    const slug = namespaceSlug('user:u19-never')
    const repo = createNodeNaming(secret).repoName(slug)
    expect(await repoVisibility(repo)).toBe('absent')
    expect(await newDriver(secret).get(manifestPath(slug))).toBeNull()
    expect(await repoVisibility(repo)).toBe('absent')
  }, 120_000)

  test('a cold open of an absent repo creates it private, and a write round trips', async () => {
    const store = newDriver()
    const slug = namespaceSlug('user:u19a')
    const stamp = `${Date.now()}-${Math.random()}`
    const body = new TextEncoder().encode(`round-trip ${stamp}`)
    const fresh = contentPath(slug, sha256Hex(stamp))

    // Absent within an existing repo is still null, and this path is new every
    // run, so the assertion cannot be satisfied by a previous run's leftovers.
    expect(await store.get(fresh)).toBeNull()
    await store.put(manifestPath(slug), body)
    await store.put(fresh, body)
    expect(await store.get(manifestPath(slug))).toEqual(body)

    const repo = createNodeNaming(LIVE_SECRET).repoName(slug)
    expect(await repoVisibility(repo)).toBe('private')

    // A second driver with an empty workdir clones what the first pushed, which
    // is what proves the bytes reached the node rather than a local directory.
    const second = newDriver()
    expect(await second.get(manifestPath(slug))).toEqual(body)
    expect(await second.get(fresh)).toEqual(body)

    // The manifest is wrapped and the entry blob is not, so the manifest's bytes
    // on the node must differ from what the driver was handed while the blob's
    // match. Without this the wrap could be a no-op and every read still pass.
    const onNode = await readFile(join(secondClone(second, repo), 'manifest.json'))
    expect(new Uint8Array(onNode)).not.toEqual(body)
    const leaf = createNodeNaming(LIVE_SECRET).entryLeaf(slug, sha256Hex(stamp))
    const blobOnNode = await readFile(join(secondClone(second, repo), 'blobs', leaf))
    expect(new Uint8Array(blobOnNode)).toEqual(body)

    // `list` has to survive a re-clone: the in-repo leaf is a keyed hash of the
    // store leaf, so nothing can invert it and the reverse index is the only
    // thing that lets reclaim see a blob no manifest names. A fresh driver, not
    // this one, is what proves the index was committed rather than remembered.
    expect(await second.list(blobPrefix(slug))).toContain(fresh)

    // And a delete removes it from the tree, with `list` seeing it go.
    expect(await store.list(blobPrefix(slug))).toContain(fresh)
    await store.delete(fresh)
    expect(await store.get(fresh)).toBeNull()
    expect(await store.list(blobPrefix(slug))).not.toContain(fresh)
    expect(await newDriver().get(fresh)).toBeNull()
  }, 300_000)

  test('a cold open that finds the repo public refuses and writes nothing', async () => {
    const store = newDriver(PUBLIC_NS_SECRET)
    const slug = namespaceSlug(PUBLIC_NS)
    const repo = createNodeNaming(PUBLIC_NS_SECRET).repoName(slug)
    // The fixture only means anything if the node really has it, and public.
    expect(await repoVisibility(repo)).toBe('public')

    const before = await run(['curl', '-s', `${NODE_URL}/api/v1/repos/${OWNER_SHORT}/${repo}/tree`])
    await expect(store.put(manifestPath(slug), new TextEncoder().encode('x'))).rejects.toThrow(
      /public/i,
    )
    const after = await run(['curl', '-s', `${NODE_URL}/api/v1/repos/${OWNER_SHORT}/${repo}/tree`])
    expect(after.out).toBe(before.out)

    // A read refuses too, and no clone was taken. Both matter: the refusal in
    // front of the push would keep bytes off a public repo on its own, so
    // without these the cold-open check could be deleted with this test green.
    await expect(store.get(manifestPath(slug))).rejects.toThrow(/public/i)
    expect(existsSync(join(workdirOf(store), repo))).toBe(false)
  }, 120_000)

  test('a failed push leaves the commit local, and the next write lands both', async () => {
    const store = newDriver()
    const slug = namespaceSlug('user:u19a')
    const stamp = `${Date.now()}-${Math.random()}`
    const first = contentPath(slug, sha256Hex(`push-fail-a-${stamp}`))
    const second = contentPath(slug, sha256Hex(`push-fail-b-${stamp}`))
    const bodyA = new TextEncoder().encode(`a ${stamp}`)
    const bodyB = new TextEncoder().encode(`b ${stamp}`)

    // Open the clone while the node is up, so the failure below is the push and
    // not the cold open.
    await store.put(manifestPath(slug), new TextEncoder().encode(`warm ${stamp}`))
    const repo = createNodeNaming(LIVE_SECRET).repoName(slug)
    const before = await remoteCommits(repo)

    // The push fails, not the check in front of it: the record read still gets
    // through, so what this exercises is a commit whose push died.
    proxy.setPushBroken(true)
    const failed = await store.put(first, bodyA).then(
      () => null,
      (e: Error) => e,
    )
    expect(failed).toBeInstanceOf(Error)
    expect(`${failed?.message}`).toMatch(/could not push/)
    // The reason has to survive into the message. An operator reading a log gets
    // only this line, and "could not push to repo <64 hex chars>" cannot tell a
    // rate limit from a rejected signature from a node that is simply down.
    // Observed for real: the node answers 429 "push rate limit exceeded" and the
    // driver reported none of it, which cost an hour of looking in the wrong
    // place. The prefix alone must not be the whole message.
    expect(
      `${failed?.message}`.replace(/^node store could not push to repo \S+:?/, '').trim(),
    ).not.toBe('')
    proxy.setPushBroken(false)

    // And the same holds when the node is gone entirely.
    proxy.setReachable(false)
    await expect(store.put(second, bodyB)).rejects.toThrow()
    proxy.setReachable(true)

    // Both commits survive locally: this driver still reads its own writes back.
    expect(await store.get(first)).toEqual(bodyA)
    expect(await store.get(second)).toEqual(bodyB)
    // And the node has neither, which is what makes the recovery below mean
    // something rather than the pushes having quietly succeeded.
    const stranded = newDriver()
    expect(await stranded.get(first)).toBeNull()
    expect(await stranded.get(second)).toBeNull()
    expect(await remoteCommits(repo)).toBe(before)

    const third = contentPath(slug, sha256Hex(`push-fail-c-${stamp}`))
    await store.put(third, new TextEncoder().encode(`c ${stamp}`))
    const after = newDriver()
    expect(await after.get(first)).toEqual(bodyA)
    expect(await after.get(second)).toEqual(bodyB)
    expect(await after.get(third)).not.toBeNull()
    // Three commits, not one: each retried write is its own commit, so a squash
    // or a reset-on-failure would show up here.
    expect(await remoteCommits(repo)).toBe(before + 3)
  }, 300_000)

  test('a repo flipped public after the process started is refused on the next push', async () => {
    const store = newDriver()
    const slug = namespaceSlug('user:u19a')
    const stamp = `${Date.now()}-${Math.random()}`
    const blocked = contentPath(slug, sha256Hex(`flipped-${stamp}`))
    const repo = createNodeNaming(LIVE_SECRET).repoName(slug)

    // Cold open happens here, while the node still reports the repo private.
    await store.put(manifestPath(slug), new TextEncoder().encode(`open ${stamp}`))
    const before = await remoteCommits(repo)

    proxy.setPublicRewrite(true)
    const rewritesBefore = proxy.rewrites()
    await expect(store.put(blocked, new TextEncoder().encode('x'))).rejects.toThrow(/public/i)
    // The staged flip must actually have reached the driver. Without this the
    // test would pass on a rewrite that never matched and a refusal that came
    // from something else.
    expect(proxy.rewrites()).toBeGreaterThan(rewritesBefore)
    proxy.setPublicRewrite(false)

    expect(await remoteCommits(repo)).toBe(before)
    expect(await newDriver().get(blocked)).toBeNull()
  }, 300_000)

  test('a cold open of the shared meta repo refuses a public repo too', async () => {
    const store = newDriver(PUBLIC_META_SECRET)
    const repo = createNodeNaming(PUBLIC_META_SECRET).metaRepoName()
    expect(await repoVisibility(repo)).toBe('public')
    await expect(
      store.put('owners/deadbeef/usage.json', new TextEncoder().encode('x')),
    ).rejects.toThrow(/public/i)
    await expect(store.get('owners/deadbeef/usage.json')).rejects.toThrow(/public/i)
    expect(existsSync(join(workdirOf(store), repo))).toBe(false)
  }, 120_000)

  test('AE12: the colliding namespace pair lands in two repos, each reading only its own', async () => {
    const store = newDriver()
    const naming = createNodeNaming(LIVE_SECRET)
    const slugA = namespaceSlug('user:a/b')
    const slugB = namespaceSlug('user:a__b')
    const repoA = naming.repoName(slugA)
    const repoB = naming.repoName(slugB)

    expect(repoA).not.toBe(repoB)
    expect(repoA).toMatch(/^[0-9a-f]{64}$/)
    expect(repoB).toMatch(/^[0-9a-f]{64}$/)

    const stamp = `${Date.now()}-${Math.random()}`
    const bodyA = new TextEncoder().encode(`alice ${stamp}`)
    const bodyB = new TextEncoder().encode(`mallory ${stamp}`)
    const pathA = contentPath(slugA, sha256Hex(`alice-${stamp}`))
    const pathB = contentPath(slugB, sha256Hex(`mallory-${stamp}`))

    await store.put(pathA, bodyA)
    await store.put(pathB, bodyB)

    // Each owner reads its own entry, and neither can reach the other's, which
    // is what the old lossy slug broke.
    expect(await store.get(pathA)).toEqual(bodyA)
    expect(await store.get(pathB)).toEqual(bodyB)
    expect(await store.get(contentPath(slugA, sha256Hex(`mallory-${stamp}`)))).toBeNull()
    expect(await store.get(contentPath(slugB, sha256Hex(`alice-${stamp}`)))).toBeNull()

    // And it really is two repos on the node, not one serving both.
    expect(await repoVisibility(repoA)).toBe('private')
    expect(await repoVisibility(repoB)).toBe('private')
    const treeA = await run(['git', '-C', await cloneFresh(repoA), 'ls-files'])
    const treeB = await run(['git', '-C', await cloneFresh(repoB), 'ls-files'])
    const leafA = naming.entryLeaf(slugA, sha256Hex(`alice-${stamp}`))
    const leafB = naming.entryLeaf(slugB, sha256Hex(`mallory-${stamp}`))
    expect(treeA.out).toContain(leafA)
    expect(treeA.out).not.toContain(leafB)
    expect(treeB.out).toContain(leafB)
    expect(treeB.out).not.toContain(leafA)
  }, 300_000)

  test('AE5: no publication surface carries the driver repo, and the control proves each probe', async () => {
    const store = newDriver()
    const slug = namespaceSlug('user:u19a')
    const repo = createNodeNaming(LIVE_SECRET).repoName(slug)
    await store.put(manifestPath(slug), new TextEncoder().encode(`ae5 ${Date.now()}`))

    // Route-by-route, the same probe against the driver's repo and against a
    // repo the same harness deliberately made public. Without the control an
    // absence proves only that the probe was pointed somewhere it never worked.
    const control = createNodeNaming(PUBLIC_NS_SECRET).repoName(namespaceSlug(PUBLIC_NS))
    const mine = surfaces(repo, 'manifest.json')
    const theirs = surfaces(control, 'ctl.txt')
    for (let i = 0; i < mine.length; i++) {
      const probe = mine[i] as { name: string; url: string }
      const ctl = theirs[i] as { name: string; url: string }
      expect(`${probe.name}: ${await statusOf(probe.url)}`).toBe(`${probe.name}: 404`)
      expect(`${ctl.name}: ${await statusOf(ctl.url)}`).toBe(`${ctl.name}: 200`)
    }

    // The pin index, keyed by git object id. Every object of the driver's repo
    // must be absent from it and every object of the control repo present.
    const pins = await textOf('/api/v1/ipfs/pins')
    const mineDir = await cloneFresh(repo)
    const objs = await objectIds(mineDir)
    expect(objs.length).toBeGreaterThan(3)
    for (const o of objs) expect(pins).not.toContain(o.oid)
    const ctlDir = await cloneFresh(control)
    const ctlObjs = await objectIds(ctlDir)
    expect(ctlObjs.length).toBeGreaterThan(0)
    expect(ctlObjs.some(o => pins.includes(o.oid))).toBe(true)

    // /ipfs/{cid} itself. The pin index above is the exhaustive check, because
    // the route serves an object only once it is pinned; this probes the route
    // directly, and the control goes first on purpose. This route answers only a
    // handful of unsigned reads a minute, and a rate-limited 404 would be an
    // absence the probe manufactured. So the driver's object is only asserted
    // when the control has just proved the route is answering.
    const servedCtl = ctlObjs.find(o => pins.includes(o.oid)) as { oid: string; type: string }
    const ipfsControl = await statusOf(`/ipfs/${await objectCid(ctlDir, servedCtl)}`)
    const sample = await objectCid(mineDir, objs[0] as { oid: string; type: string })
    if (ipfsControl === 200) {
      expect(`${sample}: ${await statusOf(`/ipfs/${sample}`)}`).toBe(`${sample}: 404`)
    } else {
      console.warn(
        `AE5: /ipfs/{cid} answered ${ipfsControl} for the public control, so it was ` +
          'rate limited rather than probed. The pin index check above still ran.',
      )
    }

    // The listings: owner-filtered, unfiltered and federated.
    for (const url of [
      '/api/v1/repos',
      `/api/v1/repos?owner=${OWNER_SHORT}`,
      '/api/v1/repos/federated',
    ]) {
      const body = await textOf(url)
      expect(`${url}: ${body.includes(repo)}`).toBe(`${url}: false`)
      expect(`${url}: ${body.includes(control)}`).toBe(`${url}: true`)
    }

    // Arweave anchors. This node anchors nothing at all, including for the
    // public control, so the absence below has no control behind it and proves
    // nothing on its own. Recorded rather than asserted as coverage.
    const anchors = await textOf('/api/v1/arweave/anchors')
    expect(anchors).not.toContain(repo)
    if (!anchors.includes(control)) {
      console.warn(
        'AE5: the anchor index is empty for the public control too, so the ' +
          'anchor probe is not load-bearing on this node.',
      )
    }
  }, 600_000)

  test('the node binds a repo to the identity that created it', async () => {
    // AE11's control, and the reason its other half cannot run here: a repo is
    // owned by a DID, so a rotated identity does not merely lose push rights,
    // it cannot see the repo at all. Rotation on this node means relocation.
    const dir = mkdtempSync(join(tmpdir(), 'openrecall-node-id2-'))
    workdirs.push(dir)
    const made = await run(['gl', 'identity', 'new', '--dir', dir])
    expect(made.code).toBe(0)
    const slug = namespaceSlug('user:u19a')
    const repo = createNodeNaming(LIVE_SECRET).repoName(slug)
    const asOther = await run(
      ['git', 'clone', '--quiet', `gitlawb://${OWNER_DID}/${repo}`, join(dir, 'clone')],
      { GITLAWB_NODE: NODE_URL ?? '', GITLAWB_KEY: join(dir, 'identity.pem') },
    )
    expect(asOther.code).not.toBe(0)
    expect(`${asOther.err}`).toMatch(/not found/i)
    // Control: the same clone under the owning identity works, so the failure
    // above is the identity and not a broken url.
    expect(existsSync(await cloneFresh(repo))).toBe(true)
  }, 300_000)

  test('AE11: rotating the signing identity moves nothing and re-encrypts nothing', async () => {
    // The half of AE11 that is decidable here. Where a namespace lives and how
    // its bytes are wrapped derive from the store secret alone, so the signing
    // identity can be replaced without re-pathing or re-writing anything. The
    // test above shows the other half: this node binds a repo to the DID that
    // created it, so a rotated identity cannot reach the old repo at all, which
    // makes rotation a relocation at the node level and not a driver concern.
    const slug = namespaceSlug('user:u19a')
    const repo = createNodeNaming(LIVE_SECRET).repoName(slug)

    const other = mkdtempSync(join(tmpdir(), 'openrecall-node-id3-'))
    workdirs.push(other)
    expect((await run(['gl', 'identity', 'new', '--dir', other])).code).toBe(0)
    const otherKey = join(other, 'identity.pem')
    // The two identities really are different, or everything below is trivially
    // true and proves nothing.
    const a = await run(['gl', 'whoami', '--dir', IDENTITY_DIR])
    const b = await run(['gl', 'whoami', '--dir', other])
    expect(/did:key:[1-9A-HJ-NP-Za-km-z]+/.exec(a.out)?.[0]).not.toBe(
      /did:key:[1-9A-HJ-NP-Za-km-z]+/.exec(b.out)?.[0],
    )

    // Same store secret, different identity: same repo and same entry leaf.
    const rotated = new NodeBlobStore(
      { secret: LIVE_SECRET, identityPath: otherKey, url: proxy.url, acknowledged: true },
      { workdir: mkdtempSync(join(tmpdir(), 'openrecall-node-rot-')) },
    )
    expect(createNodeNaming(LIVE_SECRET).repoName(slug)).toBe(repo)
    const leaf = createNodeNaming(LIVE_SECRET).entryLeaf(slug, sha256Hex('rotate-probe'))
    expect(rotated.describe()).toBe('node')

    // Negative control: a different store secret does relocate, so the equality
    // above is a property of the secret and not of every input landing on one
    // name.
    expect(createNodeNaming(`${LIVE_SECRET}-other`).repoName(slug)).not.toBe(repo)
    expect(
      createNodeNaming(`${LIVE_SECRET}-other`).entryLeaf(slug, sha256Hex('rotate-probe')),
    ).not.toBe(leaf)
  }, 300_000)

  test('AE4: a fault at any mutating call in the commit leaves a complete, untorn state', async () => {
    const ns = 'user:u19sweep'
    const slug = namespaceSlug(ns)
    const NOW = '2026-09-05T00:00:00.000Z'
    const b64 = (v: string) => Buffer.from(v).toString('base64')
    // Two seed entries rather than three: every store put is a commit and a
    // push, and the node rate-limits pushes, so the sweep is sized to the
    // smallest write that still rewrites, adds and deletes in one commit.
    const seedEntries = { 'a.md': b64('A'), 'c.md': b64('C') }
    const store = newDriver()

    resetStore()
    setStore(store)
    try {
      // Normalize first: the repo outlives the run, so a previous run that died
      // mid-sweep would otherwise seed a different starting state. upsert is a
      // delta, so the deletion list has to be computed from what is actually
      // there: a hardcoded list silently leaves behind any key an older shape of
      // this test wrote (it left a 'b.md' from back when the seed was three
      // entries, and the sweep then failed against its own stale state).
      const before = await getData(ns, slug).catch(() => null)
      const stale = before
        ? Object.keys(before.content.entries).filter(k => !(k in seedEntries))
        : []
      await upsert(
        ns,
        slug,
        'local',
        { entries: seedEntries, deletions: [...new Set([...stale, 'd.md'])] },
        NOW,
      )
      const seed = await getData(ns, slug)
      expect(Object.keys(seed.content.entries).sort()).toEqual(['a.md', 'c.md'])

      const write = { entries: { 'a.md': b64('A2'), 'd.md': b64('D') }, deletions: ['c.md'] }
      const done = ['a.md', 'd.md']
      const rollback = () =>
        upsert(ns, slug, 'local', { entries: seedEntries, deletions: ['d.md'] }, NOW)

      /** Every entry the manifest names resolves to bytes matching its hash. */
      const assertWhole = async (expected: string[]) => {
        const view = await getData(ns, slug)
        const named = await getHashes(ns, slug)
        expect(Object.keys(view.content.entries).sort()).toEqual(expected)
        // No manifest entry lacks a blob: getData drops an entry whose blob is
        // gone, so a shorter list here than the manifest names is drift.
        expect(Object.keys(named.entryChecksums).sort()).toEqual(expected)
        for (const [key, b] of Object.entries(view.content.entries)) {
          const bytes = new Uint8Array(Buffer.from(b as string, 'base64'))
          expect(sha256Prefixed(bytes)).toBe(view.content.entryChecksums[key] as string)
        }
      }

      // How many mutating calls the write makes, measured rather than assumed,
      // so the sweep below covers all of them instead of stopping at the first
      // one the write happens to survive.
      const meter = faulty(store, -1)
      setStore(meter.store)
      await upsert(ns, slug, 'local', write, NOW)
      setStore(store)
      const total = meter.calls()
      expect(total).toBeGreaterThanOrEqual(5)
      await rollback()

      for (let at = 0; at < total; at++) {
        const f = faulty(store, at)
        setStore(f.store)
        let threw = false
        try {
          await upsert(ns, slug, 'local', write, NOW)
        } catch (err) {
          threw = true
          expect(err).toBeInstanceOf(Boom)
        }
        setStore(store)
        // The plant landed: the wrapper really reached call number `at`. Without
        // this an injection the write never got to would leave the previous
        // state in place and read exactly like a clean refusal.
        expect(f.calls()).toBe(at + 1)
        if (threw) {
          await assertWhole(['a.md', 'c.md'])
        } else {
          // Faults past the point of no return (reclaim, the usage record) are
          // survivable by design; the published state must still be the new one.
          await assertWhole(done)
          await rollback()
        }
      }
      await upsert(ns, slug, 'local', write, NOW)
      await assertWhole(done)
      const after = await getData(ns, slug)
      expect(after.content.entries['a.md']).toBe(b64('A2'))

      // Put the namespace back, so the next run starts from the same seed.
      await upsert(ns, slug, 'local', { entries: seedEntries, deletions: ['d.md'] }, NOW)
    } finally {
      resetStore()
    }
  }, 900_000)

  test('the live suite actually reached the node', () => {
    // The whole block is opt-in, and an opt-in suite that quietly did nothing
    // looks exactly like one that passed. Every driver subprocess above went
    // through the counting proxy, so a run that never opened a connection is a
    // run where nothing was exercised.
    expect(proxy.connections()).toBeGreaterThan(50)
  })
})
