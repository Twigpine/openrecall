/**
 * Prove the SHIPPED IMAGE carries the node driver's external binaries, at the
 * pinned version.
 *
 * STORE=node shells out: writes go through `git push` over the gitlawb remote
 * helper, so git, gl and git-remote-gitlawb are runtime dependencies of that
 * driver. openrecall builds none of them. Nothing in the Bun test suite can see
 * them, because the suite never runs inside the image, so this script is the
 * test for that half of the packaging.
 *
 * It asserts the version rather than mere presence. `command -v gl` passes
 * against whatever gl happens to be on PATH, which is exactly the drift pinning
 * exists to prevent, and the signing helper is the last component that should
 * move without someone choosing to move it.
 *
 * Only worth what it has been shown to catch: change the pin in the Dockerfile
 * without changing the install, or drop either COPY, and this must fail.
 *
 * Run: bun run scripts/image-node-deps-test.ts [image-tag]
 *
 * Set DOCKER to run the daemon another way (`DOCKER="sudo docker"`, `podman`).
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const IMAGE = process.argv[2] ?? 'openrecall:test'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) return console.log(`  ok    ${name}`)
  failures++
  console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
}

/**
 * The pin is read from the Dockerfile, not written here. A copy of the version
 * in this file would let the two drift apart and still agree with themselves,
 * which is the failure the whole script exists to prevent.
 */
const dockerfile = readFileSync(resolve(ROOT, 'Dockerfile'), 'utf8')
const pins = [...dockerfile.matchAll(/^ARG GL_VERSION=(\S+)$/gm)].map(m => m[1])

console.log(`\nnode driver binaries in ${IMAGE}`)

check('the Dockerfile declares a GL_VERSION pin', pins.length > 0)
check(
  'every GL_VERSION pin agrees',
  pins.length > 0 && new Set(pins).size === 1,
  `found ${JSON.stringify(pins)}`,
)

const pinned = pins[0]

const DOCKER = (process.env.DOCKER ?? 'docker').split(' ')

function inImage(cmd: string) {
  const [exe, ...lead] = DOCKER
  const r = spawnSync(exe, [...lead, 'run', '--rm', '--entrypoint', 'sh', IMAGE, '-c', cmd], {
    encoding: 'utf8',
  })
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), code: r.status }
}

const probe = inImage('true')
if (probe.code !== 0) {
  console.log(`\n  cannot run ${IMAGE}: ${probe.out}`)
  console.log(`  build it first: ${DOCKER.join(' ')} build -t ${IMAGE} .`)
  process.exit(1)
}

// Both binaries print `<name> <version>`, so the pin is asserted against the
// whole line: a substring test would pass on 0.7.10 against a 0.7.1 pin.
for (const bin of ['gl', 'git-remote-gitlawb']) {
  const { out, code } = inImage(`${bin} --version`)
  check(`${bin} runs in the image`, code === 0, out)
  check(`${bin} reports the pinned ${pinned}`, out === `${bin} ${pinned}`, `got "${out}"`)
}

// git is the third dependency and is not version-pinned: the driver uses only
// stable porcelain, so the distro's git is fine and pinning it would be noise.
const git = inImage('git --version')
check('git is present', git.code === 0 && git.out.startsWith('git version'), git.out)

console.log(failures === 0 ? '\nPASS\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
