/**
 * Drives `openrecall mcp` exactly as an agent does: spawn it, speak MCP over
 * stdio, call the tools. Runs against the source (Bun) and, when present, the
 * published Node bundle (dist/openrecall.js — `bun run build` first), so we know
 * `npx -y @twigpine/openrecall mcp` works without Bun.
 *
 * Two server processes share one local store to prove what one agent saves,
 * another agent recalls.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { TIMING_FIELDS } from '../src/log.ts'
import { TIMINGS_META } from '../src/mcp/server.ts'

const homes: string[] = []
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true })
})

function freshHome(): string {
  const h = mkdtempSync(join(tmpdir(), 'openrecall-home-'))
  homes.push(h)
  return h
}

type Launcher = { name: string; command: string; args: string[] }
const launchers: Launcher[] = [
  { name: 'source (bun)', command: process.execPath, args: ['bin/openrecall.ts'] },
]
if (existsSync('dist/openrecall.js')) {
  launchers.push({ name: 'dist (node)', command: 'node', args: ['dist/openrecall.js'] })
}

async function connect(
  l: Launcher,
  env: Record<string, string>,
  stderr?: string[],
): Promise<Client> {
  // Strip the test preload's server env so the child resolves its own settings.
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k, v]) =>
        v !== undefined && !/^(STORE|DATA_DIR|ALLOW_UNAUTHENTICATED|MAX_|OPENRECALL_)/.test(k),
    ),
  ) as Record<string, string>
  const client = new Client({ name: 'test-agent', version: '0.0.0' })
  const transport = new StdioClientTransport({
    command: l.command,
    args: [...l.args, 'mcp'],
    env: { ...base, ...env },
    stderr: 'pipe',
  })
  await client.connect(transport)
  // The child exists only after connect; anything it wrote before this point
  // (the ready line) is not collected, which is fine for a caller that wants
  // what the tool calls below write.
  if (stderr) transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))
  return client
}

/** Wait for the child's stderr to carry a line satisfying `pred`, up to 2 s. */
async function stderrLine(
  lines: string[],
  pred: (line: string) => boolean,
): Promise<string | undefined> {
  for (let i = 0; i < 40; i++) {
    const hit = lines.join('').split('\n').find(pred)
    if (hit) return hit
    await new Promise(r => setTimeout(r, 50))
  }
  return undefined
}

const text = (r: unknown) =>
  ((r as { content: { type: string; text: string }[] }).content[0]?.text ?? '') as string

for (const l of launchers) {
  describe(`openrecall mcp over stdio — ${l.name}`, () => {
    test('advertises tools, instructions and the memory_guide prompt', async () => {
      const home = freshHome()
      const c = await connect(l, { OPENRECALL_HOME: home, OPENRECALL_PASSPHRASE: 'p' })
      try {
        const { tools } = await c.listTools()
        expect(tools.map(t => t.name).sort()).toEqual([
          'memory_delete',
          'memory_doctor',
          'memory_get',
          'memory_list',
          'memory_project',
          'memory_projects',
          'memory_recall',
          'memory_save',
          'memory_search',
        ])
        expect(c.getInstructions()).toContain('memory_recall')
        const guide = await c.getPrompt({ name: 'memory_guide' })
        const msg = guide.messages[0]?.content as { text: string }
        expect(msg.text).toContain('Recall first')
        expect(msg.text.startsWith('---')).toBe(false)
      } finally {
        await c.close()
      }
    }, 30_000)

    test('two agents share one local memory; disk holds only ciphertext', async () => {
      const home = freshHome()
      const env = { OPENRECALL_HOME: home, OPENRECALL_PASSPHRASE: 'shared-pass' }
      const [agentA, agentB] = await Promise.all([connect(l, env), connect(l, env)])
      try {
        // Concurrent saves from two processes must not lose either write.
        await Promise.all([
          agentA.callTool({
            name: 'memory_save',
            arguments: { key: 'prefs.md', content: 'User prefers pnpm over npm.' },
          }),
          agentB.callTool({
            name: 'memory_save',
            arguments: { key: 'deploy.md', content: 'Deploys go through Fly in region sin.' },
          }),
        ])
        const list = text(await agentA.callTool({ name: 'memory_list', arguments: {} }))
        expect(list).toContain('prefs.md')
        expect(list).toContain('deploy.md')
        // Each save regenerated MEMORY.md in its own request; whichever landed
        // second rebuilt on top of the first, so the index names both notes.
        const index = text(
          await agentB.callTool({ name: 'memory_get', arguments: { key: 'MEMORY.md' } }),
        )
        expect(index).toContain('- [prefs](prefs.md)')
        expect(index).toContain('- [deploy](deploy.md)')

        // Assert on the hit itself: a miss message echoes the query back, so a
        // bare toContain('pnpm') would pass even when nothing was recalled.
        const recalled = text(
          await agentB.callTool({ name: 'memory_recall', arguments: { query: 'pnpm or npm' } }),
        )
        expect(recalled).toContain('### prefs.md')
        expect(recalled).toContain('User prefers pnpm over npm.')

        const dataDir = join(home, 'data')
        const files = readdirSync(dataDir, { recursive: true }) as string[]
        for (const f of files) {
          const p = join(dataDir, f)
          if (!existsSync(p) || !f.includes('entries')) continue
          try {
            expect(readFileSync(p, 'utf8')).not.toContain('pnpm')
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EISDIR') throw err
          }
        }
      } finally {
        await Promise.all([agentA.close(), agentB.close()])
      }
    }, 30_000)

    test('stage timings ride in _meta; OPENRECALL_TIMINGS=1 adds a trailer and a stderr line', async () => {
      const home = freshHome()
      const quiet = await connect(l, { OPENRECALL_HOME: home, OPENRECALL_PASSPHRASE: 'p' })
      try {
        await quiet.callTool({
          name: 'memory_save',
          arguments: { key: 'build.md', content: 'The build runs on bun.' },
        })
        const r = await quiet.callTool({
          name: 'memory_recall',
          arguments: { query: 'what runs the build' },
        })
        const meta = (r as { _meta?: Record<string, unknown> })._meta
        // Two entries read: the note and the MEMORY.md the save generated.
        expect(meta?.[TIMINGS_META]).toMatchObject({ entries: 2 })
        // Off by default: the model's context carries nothing extra.
        expect(text(r)).not.toContain('[timings')
      } finally {
        await quiet.close()
      }

      const errLines: string[] = []
      const loud = await connect(
        l,
        { OPENRECALL_HOME: home, OPENRECALL_PASSPHRASE: 'p', OPENRECALL_TIMINGS: '1' },
        errLines,
      )
      try {
        const r = await loud.callTool({
          name: 'memory_recall',
          arguments: { query: 'what runs the build' },
        })
        expect(text(r)).toMatch(
          /\n\n\[timings fetch=[\d.]+ms decrypt=[\d.]+ms rank=[\d.]+ms format=[\d.]+ms total=[\d.]+ms entries=2 bytes=\d+\]$/,
        )
        const line = await stderrLine(errLines, s => s.includes('"tool":"memory_recall"'))
        expect(line).toBeDefined()
        const parsed = JSON.parse(line as string) as Record<string, unknown>
        expect(Object.keys(parsed).sort()).toEqual([...TIMING_FIELDS].sort())
        // The line is produced where everything is plaintext, and goes into
        // the launcher's log: nothing but counts and durations may be in it.
        // (The ready line names the configured namespace; that is startup
        // output, not a tool-call log line, so only the timing line is held
        // to the allowlist.)
        const all = errLines.join('')
        expect(all).not.toContain('what runs the build')
        expect(all).not.toContain('build.md')
        expect(line).not.toContain('user:me')
      } finally {
        await loud.close()
      }
    }, 30_000)

    test('unconfigured: starts anyway and tools explain how to set up', async () => {
      const c = await connect(l, { OPENRECALL_HOME: freshHome() })
      try {
        const r = await c.callTool({ name: 'memory_recall', arguments: { query: 'x' } })
        expect(r.isError).toBe(true)
        expect(text(r)).toContain('openrecall init')
      } finally {
        await c.close()
      }
    }, 30_000)

    test('agents discover projects, recall shared and project facts together, and encrypt the directory', async () => {
      const home = freshHome()
      const env = { OPENRECALL_HOME: home, OPENRECALL_PASSPHRASE: 'project-probe' }
      const [agentA, agentB] = await Promise.all([connect(l, env), connect(l, env)])
      try {
        const project = 'github.com/twigpine/drawstrike'
        const opened = text(
          await agentA.callTool({ name: 'memory_project', arguments: { project } }),
        )
        const namespace = opened.match(/^Project namespace: (.+)$/m)?.[1]
        expect(namespace).toBeDefined()
        const other = text(
          await agentB.callTool({
            name: 'memory_project',
            arguments: { project: 'github.com/other/drawstrike' },
          }),
        ).match(/^Project namespace: (.+)$/m)?.[1]
        expect(other).toBeDefined()
        expect(other).not.toBe(namespace)
        const directory = text(await agentB.callTool({ name: 'memory_projects', arguments: {} }))
        expect(directory).toContain(project)
        expect(directory).toContain(namespace!)

        await agentA.callTool({
          name: 'memory_save',
          arguments: { key: 'prefs.md', content: 'Release notes must be concise and reviewed.' },
        })
        await agentB.callTool({
          name: 'memory_save',
          arguments: {
            key: 'prefs.md',
            namespace,
            content: 'Release Drawstrike to the zircon preview cluster.',
          },
        })
        await agentB.callTool({
          name: 'memory_save',
          arguments: {
            key: 'prefs.md',
            namespace: other,
            content: 'Release to the forbidden cluster.',
          },
        })
        const result = text(
          await agentA.callTool({
            name: 'memory_recall',
            arguments: { query: 'release', namespaces: ['user:me', namespace] },
          }),
        )
        expect(result).toContain('concise and reviewed')
        expect(result).toContain('zircon preview cluster')
        expect(result).not.toContain('forbidden cluster')
        expect(result).toContain(`### prefs.md (${namespace})`)
        const shared = text(
          await agentA.callTool({ name: 'memory_recall', arguments: { query: 'release' } }),
        )
        expect(shared).not.toContain('zircon preview cluster')
        expect(shared).toContain('concise and reviewed')

        const dataDir = join(home, 'data')
        for (const rel of readdirSync(dataDir, { recursive: true }) as string[]) {
          try {
            const stored = readFileSync(join(dataDir, rel), 'utf8')
            expect(stored).not.toContain(project)
            expect(stored).not.toContain('zircon preview cluster')
            expect(stored).not.toContain('concise and reviewed')
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EISDIR') throw err
          }
        }
      } finally {
        await Promise.all([agentA.close(), agentB.close()])
      }
    }, 30_000)

    test('the startup doctor runs after ready, off the handshake, and memory_doctor reports over stdio', async () => {
      const home = freshHome()
      const env = { OPENRECALL_HOME: home, OPENRECALL_PASSPHRASE: 'p' }
      // Seed a duplicate pair through one server, so the next start has
      // something to find. That server audited an empty namespace at its own
      // start and left a marker two writes old, which is not yet due; the
      // marker is removed so the second start is the no-marker case.
      const seed = await connect(l, env)
      try {
        const body = 'Deploys go through the Ashfield cluster from the release branch.'
        for (const key of ['project/deploy.md', 'project/deploy-copy.md']) {
          const saved = text(
            await seed.callTool({ name: 'memory_save', arguments: { key, content: body } }),
          )
          // The empty-namespace audit found nothing, so no banner rides here.
          expect(saved).toMatch(/^saved "project\/deploy(-copy)?\.md" in user:me \(v\d+\)$/)
        }
      } finally {
        await seed.close()
      }
      const marker = join(home, 'state', 'doctor.json')
      expect(existsSync(marker)).toBe(true)
      rmSync(marker)

      const errLines: string[] = []
      const c = await connect(l, env, errLines)
      try {
        const { tools } = await c.listTools()
        expect(tools.map(t => t.name)).toContain('memory_doctor')
        const line = await stderrLine(errLines, s => s.includes('doctor:'))
        expect(line).toBe('[openrecall mcp] doctor: 1 suggestion for user:me')
        // Ready came first: the audit is queued behind the handshake, never on it.
        const all = errLines.join('')
        expect(all.indexOf('[openrecall mcp] ready')).toBeGreaterThanOrEqual(0)
        expect(all.indexOf('[openrecall mcp] ready')).toBeLessThan(all.indexOf('doctor:'))
        expect(all).not.toContain('Ashfield')

        const recalled = text(
          await c.callTool({
            name: 'memory_recall',
            arguments: { query: 'release branch deploys' },
          }),
        )
        expect(recalled).toContain('### project/deploy.md')
        expect(recalled).toMatch(
          /\n\(memory_doctor: 1 suggestion for user:me \(near-duplicate\); call memory_doctor to see them\)$/,
        )
        const again = text(
          await c.callTool({
            name: 'memory_recall',
            arguments: { query: 'release branch deploys' },
          }),
        )
        expect(again).not.toContain('memory_doctor')

        // Four entries: the pair, the index, and the access sidecar the two
        // recalls above left pending, which the doctor flushes before it reads.
        const report = text(await c.callTool({ name: 'memory_doctor', arguments: {} }))
        expect(report.startsWith('doctor report for user:me:\nentries 4/2000 · ')).toBe(true)
        const listed = text(
          await c.callTool({ name: 'memory_list', arguments: { include_system: true } }),
        )
        expect(listed).toContain('- sys.openrecall/accessed.json')
        expect(report).toContain('\nnear-duplicate (1):\n')
        expect(report).toContain('project/deploy-copy.md')
        expect(report.length).toBeLessThanOrEqual(2000)
        expect(existsSync(marker)).toBe(true)
        if (process.platform !== 'win32') {
          expect((statSync(marker).mode & 0o777).toString(8)).toBe('600')
        }
        expect(readFileSync(marker, 'utf8')).not.toContain('user:me')
      } finally {
        await c.close()
      }
    }, 30_000)
  })
}

/**
 * The stamp carries the connecting agent's name and version, which only the
 * real server over a real transport can prove: the in-process suites run on
 * a default session whose agent is `unknown`.
 */
for (const l of launchers) {
  describe(`stamped frontmatter over stdio — ${l.name}`, () => {
    test('a save through the real server is stamped with the connecting agent', async () => {
      const home = freshHome()
      const c = await connect(l, { OPENRECALL_HOME: home, OPENRECALL_PASSPHRASE: 'p' })
      try {
        const saved = text(
          await c.callTool({
            name: 'memory_save',
            arguments: { key: 'project/stamp.md', content: 'The build runs on bun.' },
          }),
        )
        expect(saved).toMatch(/^saved "project\/stamp.md" in user:me \(v\d+\)$/)
        const got = text(
          await c.callTool({ name: 'memory_get', arguments: { key: 'project/stamp.md' } }),
        )
        expect(got).toContain('\nagent: test-agent/0.0.0\n')
        expect(got).toMatch(/\nsession: s[0-9A-HJKMNP-TV-Z]{8}\n/)
        expect(got).toContain('\ntype: project\n')
        expect(got.endsWith('---\nThe build runs on bun.')).toBe(true)
      } finally {
        await c.close()
      }
    }, 30_000)
  })
}
