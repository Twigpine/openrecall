/**
 * Driver behaviour that needs no node: fake `gl` and `git` scripts on PATH.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { namespaceSlug } from '../src/namespace.ts'
import { manifestPath } from '../src/store/blobstore.ts'
import { NodeBlobStore } from '../src/store/node.ts'
import { mapStorePath } from '../src/store/node-mapping.ts'
import { createNodeNaming } from '../src/store/node-naming.ts'

const cfg = {
  secret: 'offline-test-store-secret',
  identityPath: '/keys/identity.pem',
  url: 'http://node.test',
  acknowledged: true,
}

async function withPath<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const path = process.env.PATH
  process.env.PATH = `${dir}:/usr/bin:/bin`
  try {
    return await fn()
  } finally {
    process.env.PATH = path
  }
}

describe('a command that outlives its timeout', () => {
  test('is killed with its children and the call fails promptly instead of hanging', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openrecall-node-timeout-'))
    // `sleep` is a grandchild of the node store: killing only `sh` would leave it
    // holding the pipes open and the call would wait the full 30 seconds.
    writeFileSync(join(dir, 'gl'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 })
    const store = new NodeBlobStore(cfg, { workdir: dir, commandTimeoutMs: 300 })
    const started = Date.now()
    const outcome = await withPath(dir, () =>
      store.get(manifestPath(namespaceSlug('user:timeout'))).then(
        () => 'resolved',
        (err: Error) => err.message,
      ),
    )
    expect(Date.now() - started).toBeLessThan(5000)
    // The call failed (it did not pretend the repo was absent or empty).
    expect(outcome).not.toBe('resolved')
  })
})

describe('the clone of a repository the node serves', () => {
  test('is made with symlinks disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openrecall-node-clone-'))
    const argv = join(dir, 'git-argv.txt')
    writeFileSync(
      join(dir, 'gl'),
      '#!/bin/sh\necho "Public: false"\necho "did:key:z6MkTestIdentity"\nexit 0\n',
      { mode: 0o755 },
    )
    writeFileSync(join(dir, 'git'), `#!/bin/sh\necho "$@" >> ${argv}\nexit 1\n`, { mode: 0o755 })
    const store = new NodeBlobStore(cfg, { workdir: dir })
    await withPath(dir, () =>
      store.get(manifestPath(namespaceSlug('user:clone'))).catch(() => null),
    )
    const calls = readFileSync(argv, 'utf8')
    expect(calls).toContain('clone')
    expect(calls).toContain('core.symlinks=false')
  })
})

describe('what the migration can address', () => {
  test('an owner usage record maps, the owner directory listing does not', () => {
    const naming = createNodeNaming(cfg.secret)
    expect(() => mapStorePath(naming, 'owners/abc/usage.json')).not.toThrow()
    expect(() => mapStorePath(naming, 'owners/abc/list')).toThrow()
  })
})

describe('a write whose push fails', () => {
  test('is rolled back, so it is neither readable nor left to be pushed with the next write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openrecall-node-rollback-'))
    const log = join(dir, 'git-log.txt')
    writeFileSync(
      join(dir, 'gl'),
      '#!/bin/sh\necho "Public: false"\necho "did:key:z6MkTestIdentity"\nexit 0\n',
      { mode: 0o755 },
    )
    // A git that clones into an empty directory, has a HEAD to return to, and
    // refuses only the push.
    writeFileSync(
      join(dir, 'git'),
      `#!/bin/sh
echo "$@" >> ${log}
case "$*" in
  *" clone "*) for last; do :; done; mkdir -p "$last"; exit 0 ;;
  *"rev-parse --verify --quiet HEAD"*) echo abc123; exit 0 ;;
  *"rev-parse --verify --quiet refs/remotes"*) exit 1 ;;
  *"rev-list --count"*) echo 1; exit 0 ;;
  *"diff --cached --quiet"*) exit 1 ;;
  *" push "*) echo "remote: rejected" >&2; exit 1 ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 },
    )
    const store = new NodeBlobStore(cfg, { workdir: dir })
    const slug = namespaceSlug('user:rollback')
    const outcome = await withPath(dir, () =>
      store.put(manifestPath(slug), new TextEncoder().encode('{}')).then(
        () => 'resolved',
        (err: Error) => err.message,
      ),
    )
    expect(outcome).toContain('could not push')
    const calls = readFileSync(log, 'utf8')
    expect(calls).toContain('reset --hard --quiet abc123')
  })
})

describe('the private-repo proof before a push', () => {
  test('a repo that turned public after it was opened is refused and never pushed to', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openrecall-node-flip-'))
    const log = join(dir, 'git-log.txt')
    const counter = join(dir, 'gl-count')
    // First `gl repo info` (opening the repo) says private; every later one says
    // public, as if the repo were flipped while the process ran.
    writeFileSync(
      join(dir, 'gl'),
      `#!/bin/sh
case "$1 $2" in
  "repo info")
    n=$(cat ${counter} 2>/dev/null || echo 0); echo $((n+1)) > ${counter}
    if [ "$n" -ge 1 ]; then echo "Public: true"; else echo "Public: false"; fi ;;
  *) echo "did:key:z6MkTestIdentity" ;;
esac
exit 0
`,
      { mode: 0o755 },
    )
    writeFileSync(
      join(dir, 'git'),
      `#!/bin/sh
echo "$@" >> ${log}
case "$*" in
  *" clone "*) for last; do :; done; mkdir -p "$last"; exit 0 ;;
  *"rev-parse --verify --quiet HEAD"*) echo abc123; exit 0 ;;
  *"rev-parse --verify --quiet refs/remotes"*) exit 1 ;;
  *"rev-list --count"*) echo 1; exit 0 ;;
  *"diff --cached --quiet"*) exit 1 ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 },
    )
    const store = new NodeBlobStore(cfg, { workdir: dir })
    const outcome = await withPath(dir, () =>
      store.put(manifestPath(namespaceSlug('user:flip')), new TextEncoder().encode('{}')).then(
        () => 'resolved',
        (err: Error) => err.message,
      ),
    )
    expect(outcome).not.toBe('resolved')
    expect(outcome).toMatch(/public|private/i)
    expect(readFileSync(log, 'utf8')).not.toMatch(/(^| )push /m)
  })
})
