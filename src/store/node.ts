/**
 * gitlawb node BlobStore adapter: transport and visibility.
 *
 * The driver's job is not only to move bytes. A public repo on this node is
 * pinned to public IPFS and its slug and owner DID are anchored to Arweave, and
 * neither can be retracted, so every repo openrecall writes must be private and has
 * to be *proved* private rather than assumed. The node's create-repo request
 * defaults to public, so private is a value sent explicitly, and the record is
 * re-read before every push and not only at first use: a repo flipped public
 * mid-process would otherwise publish on the next write (KTD8).
 *
 * Reads come from a local clone, which is authoritative because openrecall is the
 * only writer under its identity and runs one instance. A write stages, commits
 * and pushes; if the push fails the commit stays in the clone, so the next write
 * pushes both and nothing is lost to a node outage.
 *
 * No signature code lives here (KTD9). `git` with the node's remote helper does
 * the signing from the identity file, and `gl` does repo creation and the
 * visibility read. The identity is never read into this process: only its path
 * is handed to the subprocess, in an environment built from an allowlist so the
 * store secret this module holds cannot leak into a child.
 *
 * Erasure is `retains`: git history keeps the bytes a delete removes from the
 * tree, and the node's anchors are permanent. The client reads that and refuses
 * a scan mode that would let a secret land somewhere unremovable (KTD10).
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { BlobStore, Erasure } from './blobstore.ts'
import { mapStorePath } from './node-mapping.ts'
import {
  createNodeNaming,
  NODE_STORE_DESCRIPTION,
  type NodeNaming,
  type NodeStoreConfig,
  resolveNodeConfig,
} from './node-naming.ts'

/** Repo visibility as the node reports it. */
type Visibility = 'absent' | 'public' | 'private'

/**
 * The reverse index from in-repo path to store path, wrapped and committed
 * alongside the objects it names.
 *
 * `list` has to return store paths, and the in-repo leaf is an HMAC of the store
 * leaf (node-naming.ts explains why it must be), so nothing can invert it. The
 * alternative is a `list` that returns nothing, which reads as "no orphans" and
 * would let a crashed write leave ciphertext no quota can count and no reclaim
 * can find. It is wrapped for the same reason the manifest is: a store path
 * carries a namespace slug and an entry's ciphertext hash.
 */
const INDEX_FILE = 'paths.idx'

/** Author on every commit. Fixed, because commit metadata reaches the node. */
const COMMIT_AUTHOR = ['-c', 'user.name=openrecall', '-c', 'user.email=openrecall@invalid']

/** Every commit says the same thing: a message could carry a namespace. */
const COMMIT_MESSAGE = 'update'

/** How long any one subprocess may run before it is killed. A clone of a large
 *  namespace is the slow case; a hung one must not wedge the server. */
const COMMAND_TIMEOUT_MS = 120_000

/** A leaf appended to a prefix so `list` can ask node-mapping which repo a
 *  prefix belongs to. Mapping only ever sees whole object paths, so the prefix
 *  rules live there rather than being re-derived here. */
const LIST_PROBE_LEAF = 'list'

/**
 * The reason a subprocess failed, trimmed to one bounded line for an error
 * message. An operator reading a log gets only that line, and a bare "could not
 * push to repo <64 hex chars>" cannot tell a rate limit from a rejected
 * signature from a node that is down. Observed: the node answers 429 "push rate
 * limit exceeded" and none of it reached the caller.
 *
 * Bounded because git and gl can answer with many lines and an unbounded splice
 * of subprocess output into an error is how a log becomes unreadable. The child
 * environment is an allowlist that carries no secret, so this cannot echo one.
 */
function cause(r: CommandResult): string {
  const text = `${r.err || r.out}`.replace(/\s+/g, ' ').trim()
  if (!text) return `exit ${r.code}`
  return text.length > 300 ? `${text.slice(0, 300)}...` : text
}

/** Refusal to write to a repo the node does not report private. */
export class NodePublicRepoError extends Error {
  constructor(repo: string, found: Visibility) {
    super(
      `node repo ${repo} is ${found}, refusing to write: a public repo on this node is ` +
        'pinned to IPFS and anchored, and neither can be retracted',
    )
    this.name = 'NodePublicRepoError'
  }
}

type CommandResult = { code: number; out: string; err: string }

type Clone = {
  /** The node repo this clone is of. */
  repo: string
  dir: string
  /** in-repo path -> store path, for `list`. */
  index: Map<string, string>
}

export type NodeStoreOptions = {
  /** Where clones live. Defaults to a fresh temp directory. */
  workdir?: string
}

export class NodeBlobStore implements BlobStore {
  readonly erasure: Erasure = 'retains'

  private readonly cfg: NodeStoreConfig
  private readonly naming: NodeNaming
  private readonly identityDir: string
  private readonly workdirOption: string | undefined
  private workdir: string | null = null
  private ownerDid: string | null = null
  private readonly clones = new Map<string, Clone>()
  /** Serializes work per repo: a clone dir is a read-modify-write. */
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(cfg: NodeStoreConfig, opts: NodeStoreOptions = {}) {
    this.cfg = resolveNodeConfig(cfg)
    this.naming = createNodeNaming(this.cfg.secret)
    this.identityDir = dirname(this.cfg.identityPath)
    this.workdirOption = opts.workdir
  }

  describe(): string {
    return NODE_STORE_DESCRIPTION
  }

  async get(path: string): Promise<Uint8Array | null> {
    const obj = mapStorePath(this.naming, path)
    return this.serialize(obj.repo, async () => {
      const clone = await this.openRepo(obj.repo, false)
      if (!clone) return null
      let raw: Buffer
      try {
        raw = await readFile(join(clone.dir, obj.path))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
      return obj.wrap ? this.naming.unwrap(path, new Uint8Array(raw)) : new Uint8Array(raw)
    })
  }

  async put(path: string, bytes: Uint8Array): Promise<void> {
    const obj = mapStorePath(this.naming, path)
    await this.serialize(obj.repo, async () => {
      const clone = await this.openRepo(obj.repo, true)
      if (!clone) throw new Error('node store could not open a repo for writing')
      const dest = join(clone.dir, obj.path)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, obj.wrap ? this.naming.wrap(path, bytes) : bytes)
      clone.index.set(obj.path, path)
      await this.commit(clone, [obj.path])
      await this.push(obj.repo, clone)
    })
  }

  async delete(path: string): Promise<void> {
    const obj = mapStorePath(this.naming, path)
    await this.serialize(obj.repo, async () => {
      const clone = await this.openRepo(obj.repo, false)
      if (!clone) return
      const dest = join(clone.dir, obj.path)
      const present = existsSync(dest)
      const indexed = clone.index.delete(obj.path)
      // A delete of something the repo never held is a no-op, the way it is on
      // every other adapter. Committing anyway would hand `git add` a pathspec
      // matching nothing, which fails, and reclaim deletes paths speculatively:
      // it removes the legacy key-derived path for every key it touches whether
      // one was ever written there or not.
      if (!present && !indexed) return
      await rm(dest, { force: true })
      await this.commit(clone, present ? [obj.path] : [])
      await this.push(obj.repo, clone)
    })
  }

  async list(prefix: string): Promise<string[]> {
    const obj = mapStorePath(this.naming, `${prefix}${LIST_PROBE_LEAF}`)
    return this.serialize(obj.repo, async () => {
      const clone = await this.openRepo(obj.repo, false)
      if (!clone) return []
      return [...clone.index.values()].filter(p => p.startsWith(prefix)).sort()
    })
  }

  // ── Repo lifecycle ────────────────────────────────────────────────────────

  /**
   * Absent means create private then clone; public means refuse; private means
   * clone. Returns null when the repo does not exist and the caller is a read,
   * so a read of a namespace nothing has written yet costs no repo creation.
   */
  private async openRepo(repo: string, create: boolean): Promise<Clone | null> {
    const open = this.clones.get(repo)
    if (open) return open

    let seen = await this.visibility(repo)
    if (seen === 'absent') {
      if (!create) return null
      await this.createPrivate(repo)
      // Re-read rather than trust the flag we sent: the create request defaults
      // to public, so "we asked for private" is not evidence it is private.
      seen = await this.visibility(repo)
    }
    if (seen !== 'private') throw new NodePublicRepoError(repo, seen)

    const dir = join(await this.root(), repo)
    await this.clone(repo, dir)
    const clone: Clone = { repo, dir, index: new Map() }
    await this.loadIndex(repo, clone)
    this.clones.set(repo, clone)
    return clone
  }

  private async visibility(repo: string): Promise<Visibility> {
    const r = await this.command('gl', [
      'repo',
      'info',
      repo,
      '--node',
      this.cfg.url,
      '--dir',
      this.identityDir,
    ])
    if (r.code !== 0) {
      if (/not found/i.test(`${r.err}${r.out}`)) return 'absent'
      throw new Error(`node store could not read the record for repo ${repo}`)
    }
    const m = /^\s*Public:\s+(true|false)\s*$/m.exec(r.out)
    // An unparsed record is not evidence of privacy. Refuse rather than guess.
    if (!m) throw new Error(`node store could not read visibility for repo ${repo}`)
    return m[1] === 'true' ? 'public' : 'private'
  }

  private async createPrivate(repo: string): Promise<void> {
    const r = await this.command('gl', [
      'repo',
      'create',
      repo,
      '--private',
      '--node',
      this.cfg.url,
      '--dir',
      this.identityDir,
    ])
    if (r.code !== 0) throw new Error(`node store could not create repo ${repo}: ${cause(r)}`)
  }

  private async clone(repo: string, dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true })
    await mkdir(dirname(dir), { recursive: true })
    const url = `gitlawb://${await this.owner()}/${repo}`
    const r = await this.command('git', ['clone', '--quiet', url, dir])
    if (r.code !== 0) throw new Error(`node store could not clone repo ${repo}: ${cause(r)}`)
    // An empty repo clones with no HEAD commit and whatever default branch the
    // local git happens to have. Pin it, so the first push lands on main.
    const head = await this.git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    if (head.code !== 0) await this.git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  }

  private async owner(): Promise<string> {
    if (this.ownerDid) return this.ownerDid
    const r = await this.command('gl', ['whoami', '--dir', this.identityDir])
    const m = /did:key:[1-9A-HJ-NP-Za-km-z]+/.exec(r.out)
    if (r.code !== 0 || !m) throw new Error('node store could not resolve its own identity DID')
    this.ownerDid = m[0]
    return this.ownerDid
  }

  private async root(): Promise<string> {
    if (this.workdir) return this.workdir
    this.workdir = this.workdirOption ?? (await mkdtemp(join(tmpdir(), 'openrecall-node-')))
    await mkdir(this.workdir, { recursive: true })
    return this.workdir
  }

  // ── Commit and push ───────────────────────────────────────────────────────

  private async loadIndex(repo: string, clone: Clone): Promise<void> {
    let raw: Buffer
    try {
      raw = await readFile(join(clone.dir, INDEX_FILE))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    const json = new TextDecoder().decode(this.naming.unwrap(indexAad(repo), new Uint8Array(raw)))
    for (const [k, v] of Object.entries(JSON.parse(json) as Record<string, string>)) {
      clone.index.set(k, v)
    }
  }

  private async commit(clone: Clone, paths: string[]): Promise<void> {
    const wrapped = this.naming.wrap(
      indexAad(clone.repo),
      new TextEncoder().encode(JSON.stringify(Object.fromEntries(clone.index))),
    )
    await writeFile(join(clone.dir, INDEX_FILE), wrapped)
    const add = await this.git(clone.dir, ['add', '--', INDEX_FILE, ...paths])
    if (add.code !== 0) throw new Error('node store could not stage a write')
    // A rewrite of identical bytes stages nothing, and `git commit` would fail
    // on an empty commit. The push below still runs, so a commit left behind by
    // an earlier failed push is not stranded by a no-op write.
    const staged = await this.git(clone.dir, ['diff', '--cached', '--quiet'])
    if (staged.code === 0) return
    const c = await this.git(clone.dir, [
      ...COMMIT_AUTHOR,
      'commit',
      '--quiet',
      '-m',
      COMMIT_MESSAGE,
    ])
    if (c.code !== 0) throw new Error('node store could not commit a write')
  }

  /**
   * Push everything the clone holds that the node does not, after re-reading the
   * repo record. A failure throws with the commit still in the clone, so the
   * next write pushes both rather than losing the first.
   */
  private async push(repo: string, clone: Clone): Promise<void> {
    if ((await this.pending(clone)) === 0) return
    const seen = await this.visibility(repo)
    if (seen !== 'private') throw new NodePublicRepoError(repo, seen)
    const r = await this.git(clone.dir, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])
    if (r.code !== 0) throw new Error(`node store could not push to repo ${repo}: ${cause(r)}`)
  }

  /** Commits the clone holds that the node has not acknowledged. */
  private async pending(clone: Clone): Promise<number> {
    const head = await this.git(clone.dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    if (head.code !== 0) return 0
    const remote = await this.git(clone.dir, [
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/remotes/origin/main',
    ])
    const range = remote.code === 0 ? 'refs/remotes/origin/main..HEAD' : 'HEAD'
    const n = await this.git(clone.dir, ['rev-list', '--count', range])
    return n.code === 0 ? Number(n.out.trim()) : 1
  }

  // ── Subprocesses ──────────────────────────────────────────────────────────

  private git(dir: string, args: string[]): Promise<CommandResult> {
    return this.command('git', ['-C', dir, ...args])
  }

  /**
   * Run one command with an environment built from an allowlist rather than
   * inherited. The store secret lives in this process's environment, and a
   * child that inherited it would put the value that names and wraps every
   * tenant's data one `ps` away. Only the node target and the identity *path*
   * cross the boundary; the key itself is never read here.
   */
  private command(bin: string, args: string[]): Promise<CommandResult> {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      // The helper and gl both take the identity explicitly, so HOME exists only
      // so git has somewhere to look and must not be the operator's own.
      HOME: this.workdir ?? tmpdir(),
      GITLAWB_NODE: this.cfg.url,
      GITLAWB_KEY: this.cfg.identityPath,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    }
    return new Promise(resolve => {
      const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      let settled = false
      const timer = setTimeout(() => child.kill('SIGKILL'), COMMAND_TIMEOUT_MS)
      child.stdout.on('data', d => {
        out += d
      })
      child.stderr.on('data', d => {
        err += d
      })
      const done = (code: number) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code, out, err })
      }
      // A binary that is not on PATH is a configuration failure, reported the
      // way a shell reports it rather than as a crash inside the driver.
      child.on('error', () => done(127))
      child.on('close', code => done(code ?? 1))
    })
  }

  /** One operation at a time per repo: a clone dir is a read-modify-write. */
  private serialize<T>(repo: string, work: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(repo) ?? Promise.resolve()
    const next = prev.then(work, work)
    this.queues.set(
      repo,
      next.catch(() => {}),
    )
    return next
  }
}

/** The index is bound to its repo, so one moved between repos fails to open. */
function indexAad(repo: string): string {
  return `${INDEX_FILE}@${repo}`
}
