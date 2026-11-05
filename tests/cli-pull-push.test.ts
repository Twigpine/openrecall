/**
 * `openrecall pull` then `openrecall push` of a namespace that holds a note
 * with version history and a soft-deleted note: the `.json` bookkeeping under
 * `sys.openrecall/` and the deeper trash and history paths come back from
 * disk unchanged, so the push uploads nothing and the manifest version does
 * not move. The namespace is seeded through the real MCP server, which is the
 * only writer of history and trash.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ROOT = join(import.meta.dir, '..')
const home = mkdtempSync(join(tmpdir(), 'openrecall-roundtrip-home-'))
const dir = mkdtempSync(join(tmpdir(), 'openrecall-roundtrip-notes-'))
afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

// An explicit env for both children: the test preload's STORE/DATA_DIR/caps
// must not leak in, so each resolves its own local store under OPENRECALL_HOME.
const ENV = {
  PATH: process.env.PATH ?? '',
  HOME: home,
  OPENRECALL_HOME: home,
  OPENRECALL_PASSPHRASE: 'roundtrip-pass',
}

function cli(args: string[]) {
  const r = Bun.spawnSync(['bun', 'run', join(ROOT, 'bin/openrecall.ts'), ...args], { env: ENV })
  return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode }
}

/** Two saves of one key (its history) and a soft delete (the trash), through `openrecall mcp`. */
async function seed(): Promise<void> {
  const client = new Client({ name: 'roundtrip-agent', version: '0.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'bin/openrecall.ts'), 'mcp'],
    env: ENV,
    stderr: 'pipe',
  })
  await client.connect(transport)
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args })
      expect(r.isError ?? false).toBe(false)
    }
    await call('memory_save', {
      key: 'project/notes/plan.md',
      content: 'The plan, first version.\n',
    })
    await call('memory_save', {
      key: 'project/notes/plan.md',
      content: 'The plan, second version.\n',
    })
    await call('memory_save', {
      key: 'scratch.md',
      content: 'A scratch note that is about to be deleted.\n',
      mode: 'add',
    })
    await call('memory_delete', { key: 'scratch.md' })
  } finally {
    await client.close()
  }
}

describe('openrecall pull then push', () => {
  test('history, the trash and the index round-trip; the manifest version does not move', async () => {
    await seed()
    const pulled = cli(['pull', dir])
    expect(`${pulled.code}: ${pulled.err}`).toBe('0: ')
    const m = pulled.out.match(/^pulled user:me v(\d+): (\d+) files/)
    expect(m).not.toBeNull()
    const [, version, files] = m as RegExpMatchArray
    expect(Number(files)).toBe(4)
    expect(existsSync(join(dir, 'project', 'notes', 'plan.md'))).toBe(true)
    expect(existsSync(join(dir, 'MEMORY.md'))).toBe(true)
    expect(
      existsSync(join(dir, 'sys.openrecall', 'history', 'project', 'notes', 'plan.md.json')),
    ).toBe(true)
    expect(existsSync(join(dir, 'sys.openrecall', 'trash', 'scratch.md'))).toBe(true)

    const pushed = cli(['push', dir])
    expect(`${pushed.code}: ${pushed.err}`).toBe('0: ')
    expect(pushed.out).toBe(`pushed user:me: 0 uploaded, ${files} unchanged → v${version}\n`)
  }, 30_000)
})
