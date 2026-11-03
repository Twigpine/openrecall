/**
 * The package as a consumer gets it, not as this repo runs it.
 *
 * `npm pack` the working tree, `npm install` the tarball into a throwaway
 * project, then use it the way an agent's own code would: import every
 * exported subpath under plain Node, run the crypto end to end, and type-check
 * a consumer file against the shipped declarations. This is the gap the
 * `exports` map had while it pointed at client/*.ts: bun ran those and Node
 * refused them ("Unknown file extension .ts"), so the library was Bun-only
 * while the README said Node, and nothing in the suite imported the package
 * by name, so nothing noticed.
 *
 * Needs `bun run build` first (dist/client is what it tests), as CI does, and
 * skips itself otherwise, like the stdio suite does for dist/openrecall.js.
 * No network: the package has no runtime dependencies to fetch.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..')
const BUILT = existsSync(join(REPO_ROOT, 'dist/client/index.js'))

function run(cmd: string[], cwd: string): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

async function listeningPort(output: ReadableStream<Uint8Array>): Promise<number> {
  const reader = output.getReader()
  const decoder = new TextDecoder()
  let log = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`server exited before listening:\n${log}`)
      log += decoder.decode(value, { stream: true })
      const port = log.match(/listening on :(\d+)/)?.[1]
      if (port) return Number(port)
    }
  } finally {
    reader.releaseLock()
  }
}

describe.skipIf(!BUILT)('the published package, installed and used under Node', () => {
  let tmp = ''
  let consumer = ''
  let shipped: string[] = []

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'openrecall-pack-'))
    consumer = join(tmp, 'consumer with spaces')

    const pack = run(['npm', 'pack', '--json', '--pack-destination', tmp], REPO_ROOT)
    if (pack.code !== 0) throw new Error(`npm pack failed:\n${pack.err}`)
    const [info] = JSON.parse(pack.out) as [{ filename: string; files: { path: string }[] }]
    shipped = info.files.map(f => f.path)

    mkdirSync(consumer)
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
    )
    const install = run(
      [
        'npm',
        'install',
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        '--ignore-scripts',
        join(tmp, info.filename),
      ],
      consumer,
    )
    if (install.code !== 0) throw new Error(`npm install failed:\n${install.err}`)
  })

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  })

  test('the tarball carries the CLI bundle, the library, its declarations, and no tests', () => {
    for (const p of [
      'dist/openrecall.js',
      'dist/client/index.js',
      'dist/client/index.d.ts',
      'dist/client/crypto.js',
      'dist/client/crypto.d.ts',
      'dist/client/secretscan.js',
      'dist/client/secretscan.d.ts',
      'skills/openrecall-memory/SKILL.md',
    ])
      expect(shipped).toContain(p)
    expect(shipped.filter(p => p.startsWith('tests/') || p.includes('node_modules/'))).toEqual([])
  })

  for (const runtime of ['node', 'bun'] as const) {
    test(`installed serve starts under ${runtime}, keeps server settings, and stops on SIGTERM`, async () => {
      const cli = join(consumer, 'node_modules/.bin/openrecall')
      const dataDir = `./server data ${runtime}`
      const child = Bun.spawn({
        cmd: [runtime === 'node' ? Bun.which('node')! : process.execPath, cli, 'serve'],
        cwd: consumer,
        env: {
          ...process.env,
          // Node can find Bun, but neither launcher can download via npm/bunx.
          PATH: runtime === 'node' ? dirname(process.execPath) : '',
          PORT: '0',
          STORE: 'fs',
          DATA_DIR: dataDir,
          ALLOW_UNAUTHENTICATED: 'false',
          STATIC_API_KEYS: 'probe:probe-api-key',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const deadline = setTimeout(() => child.kill('SIGTERM'), 5_000)
      try {
        const port = await listeningPort(child.stdout)
        const base = `http://127.0.0.1:${port}`
        const health = await fetch(`${base}/health`)
        expect(health.status).toBe(200)
        expect(await health.json()).toEqual({ ok: true, service: 'openrecall' })
        expect(existsSync(join(consumer, dataDir))).toBe(true)
        const path = `${base}/api/memory/user:probe?view=hashes`
        expect((await fetch(path)).status).toBe(401)
        expect(
          (await fetch(path, { headers: { Authorization: 'Bearer probe-api-key' } })).status,
        ).toBe(200)
        child.kill('SIGTERM')
        await child.exited
        expect(child.signalCode).toBe('SIGTERM')
        // The Bun server child must also be gone, not orphaned by its launcher.
        await expect(fetch(`${base}/health`)).rejects.toThrow()
      } finally {
        clearTimeout(deadline)
        child.kill('SIGTERM')
        await child.exited
      }
    }, 10_000)
  }

  test('Node without Bun explains installation, while local memory still works', () => {
    const cli = join(consumer, 'node_modules/.bin/openrecall')
    const node = Bun.which('node')!
    const env = { ...process.env, PATH: '', OPENRECALL_HOME: join(consumer, 'local home') }
    const command = (args: string[]) =>
      Bun.spawnSync([node, cli, ...args], { cwd: consumer, env, stdout: 'pipe', stderr: 'pipe' })
    const serve = command(['serve'])
    expect(serve.exitCode).toBe(1)
    expect(serve.stderr.toString()).toContain('Install Bun')
    expect(serve.stderr.toString()).toContain('on PATH')
    expect(serve.stderr.toString()).toContain('openrecall init')
    expect(command(['init']).exitCode).toBe(0)
    const status = command(['status'])
    expect(status.exitCode).toBe(0)
    expect(status.stdout.toString()).toContain('ok — 0 entries')
  })

  test('Node preserves a Bun server startup failure and its diagnostics', () => {
    const cli = join(consumer, 'node_modules/.bin/openrecall')
    const dataDir = join(consumer, 'not-a-directory')
    writeFileSync(dataDir, 'cannot store here')
    const child = Bun.spawnSync([Bun.which('node')!, cli, 'serve'], {
      cwd: consumer,
      env: { ...process.env, PATH: dirname(process.execPath), STORE: 'fs', DATA_DIR: dataDir },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(child.exitCode).toBe(1)
    expect(child.stderr.toString()).toContain('store probe failed')
  })

  test('every subpath loads under Node, shares one class identity, and the crypto round-trips', () => {
    writeFileSync(
      join(consumer, 'probe.mjs'),
      [
        "const root = await import('@twigpine/openrecall')",
        "const crypto = await import('@twigpine/openrecall/crypto')",
        "const scan = await import('@twigpine/openrecall/secretscan')",
        "const key = crypto.deriveKey('probe-pass', 'user:probe')",
        "const ct = crypto.encryptEntry(key, 'note.md', 'round trip')",
        'console.log(JSON.stringify({',
        '  root: Object.keys(root).sort(),',
        '  crypto: Object.keys(crypto).sort(),',
        '  scan: Object.keys(scan).sort(),',
        '  oneError: root.SecretFoundError === scan.SecretFoundError,',
        "  back: crypto.decryptEntry(key, 'note.md', ct),",
        '}))',
        '',
      ].join('\n'),
    )
    const r = run(['node', 'probe.mjs'], consumer)
    if (r.code !== 0) throw new Error(`node failed:\n${r.err}`)
    const got = JSON.parse(r.out) as {
      root: string[]
      crypto: string[]
      scan: string[]
      oneError: boolean
      back: string
    }
    expect(got.root).toContain('OpenRecallClient')
    expect(got.crypto).toEqual(
      expect.arrayContaining(['ciphertextHash', 'decryptEntry', 'deriveKey', 'encryptEntry']),
    )
    expect(got.scan).toEqual(
      expect.arrayContaining(['SecretFoundError', 'scanEntries', 'scanEntry']),
    )
    // Emitted per file, not bundled per entry point: a bundle would give the
    // root and the subpath each their own copy of the class, and a consumer's
    // `instanceof` against one would miss errors thrown through the other.
    expect(got.oneError).toBe(true)
    expect(got.back).toBe('round trip')
  })

  test('the declarations type a consumer, and reject a wrong one', () => {
    // The repo's own tsc and @types/node, so this needs no network. nodenext
    // resolution is what reads the `types` condition of `exports`.
    const tsc = (file: string) =>
      run(
        [
          join(REPO_ROOT, 'node_modules/.bin/tsc'),
          '--noEmit',
          '--strict',
          '--module',
          'nodenext',
          '--moduleResolution',
          'nodenext',
          '--target',
          'es2022',
          '--skipLibCheck',
          '--types',
          'node',
          '--typeRoots',
          join(REPO_ROOT, 'node_modules/@types'),
          file,
        ],
        consumer,
      )
    writeFileSync(
      join(consumer, 'ok.ts'),
      [
        "import { OpenRecallClient, type PullResult } from '@twigpine/openrecall'",
        "import { deriveKey } from '@twigpine/openrecall/crypto'",
        "import { scanEntries } from '@twigpine/openrecall/secretscan'",
        "const c = new OpenRecallClient({ url: 'https://example.invalid', passphrase: 'x' })",
        "const p: Promise<PullResult> = c.pull('user:me')",
        "const k: Buffer = deriveKey('x', 'user:me')",
        'export { p, k, scanEntries }',
        '',
      ].join('\n'),
    )
    const ok = tsc('ok.ts')
    if (ok.code !== 0) throw new Error(`consumer failed to type-check:\n${ok.out}`)

    // Positive control: the types are the real ones, not `any` from a missing
    // or unresolvable declaration. `--skipLibCheck` can hide a broken .d.ts,
    // but it cannot make a wrong call site pass.
    writeFileSync(
      join(consumer, 'bad.ts'),
      [
        "import { OpenRecallClient } from '@twigpine/openrecall'",
        "new OpenRecallClient({ url: 42, passphrase: 'x' })",
        '',
      ].join('\n'),
    )
    const bad = tsc('bad.ts')
    expect(bad.code).not.toBe(0)
    expect(bad.out).toContain("Type 'number' is not assignable to type 'string'")
  })
})
