import { describe, expect, test } from 'bun:test'
import { sha256Hex } from '../src/hash.ts'
import { makeProjects, projectId, projectNamespace } from '../src/mcp/projects.ts'
import { rankEntriesDetailed } from '../src/mcp/relevance.ts'
import { type MemoryClient, makeTools } from '../src/mcp/tools.ts'
import { httpError } from './stub-client.ts'

function scopedClient() {
  const store = new Map<string, Record<string, string>>()
  const reads: string[] = []
  let unreadable = ''
  const client: MemoryClient = {
    async pull(namespace) {
      reads.push(namespace)
      if (namespace === unreadable) throw new Error('store unavailable')
      // A namespace nobody has written is at version 0, as on the real server;
      // an empty body at a version past zero reads as lost data.
      const entries = { ...store.get(namespace) }
      return { namespace, version: Object.keys(entries).length ? 1 : 0, entries, updatedAt: {} }
    },
    async entry(namespace, key) {
      reads.push(namespace)
      if (namespace === unreadable) throw new Error('store unavailable')
      const entries = store.get(namespace) ?? {}
      if (Object.keys(entries).length === 0) throw httpError(404, 'empty')
      if (!Object.hasOwn(entries, key)) throw httpError(404, 'entry_not_found')
      return entries[key] as string
    },
    async push(namespace, entries) {
      store.set(namespace, { ...store.get(namespace), ...entries })
      return { namespace, version: 1, uploaded: Object.keys(entries), unchanged: [], deleted: [] }
    },
    async hashes(namespace) {
      return Object.fromEntries(Object.keys(store.get(namespace) ?? {}).map(key => [key, 'hash']))
    },
    async delete(namespace, key) {
      const entries = store.get(namespace)
      if (entries) delete entries[key]
    },
  }
  return { client, store, reads, failReads: (namespace: string) => (unreadable = namespace) }
}

describe('discoverable project memory', () => {
  test('project IDs are stable across agents, machines, case and the .git suffix', () => {
    expect(projectId(' GitHub.com/Twigpine/OpenRecall.git/ ')).toBe(
      'github.com/twigpine/openrecall',
    )
    const ns = projectNamespace('user:me', 'github.com/twigpine/openrecall')
    expect(projectNamespace('user:me', 'GitHub.com/Twigpine/OpenRecall.git')).toBe(ns)
    expect(projectNamespace('user:me', 'github.com/other/openrecall')).not.toBe(ns)
    expect(projectNamespace('user:other', 'github.com/twigpine/openrecall')).not.toBe(ns)
    expect(ns).toStartWith('user:me/projects/')
    expect(ns).not.toContain('twigpine')
  })

  test('rejects local paths, URLs with credentials and traversal before writing', async () => {
    const { client, store } = scopedClient()
    const projects = makeProjects(client, 'user:me')
    for (const id of [
      '/Users/me/repo',
      'C:\\repo',
      '../repo',
      'owner//repo',
      'https://token@host/repo',
    ])
      expect((await projects.open(id)).isError).toBe(true)
    expect(store.size).toBe(0)
  })

  test('independent registrations are discoverable by another agent without touching user facts', async () => {
    const { client, store } = scopedClient()
    const first = makeProjects(client, 'user:me')
    const second = makeProjects(client, 'user:me')
    await Promise.all([first.open('host/team/alpha'), second.open('host/team/beta')])
    expect((await second.list()).text).toContain('2 registered project(s)')
    expect((await second.list()).text).toContain('host/team/alpha')
    await first.open('HOST/TEAM/ALPHA.git')
    expect(Object.keys(store.get('user:me/projects') ?? {})).toHaveLength(2)
    expect(store.has('user:me')).toBe(false)
    const empty = await makeProjects(client, 'user:other').list()
    expect(empty.text).toContain('0 registered project(s)')
  })

  test('project directory pages results and reports malformed entries without trusting them', async () => {
    const { client, store } = scopedClient()
    const projects = makeProjects(client, 'user:me')
    for (const id of ['host/team/gamma', 'host/team/alpha', 'host/team/beta'])
      await projects.open(id)
    const catalog = store.get('user:me/projects')!
    catalog['bad.json'] = 'invalid JSON'
    catalog[`${sha256Hex('host/team/wrong')}.json`] = JSON.stringify({
      version: 1,
      id: 'host/team/wrong',
      namespace: 'user:other',
    })
    const first = await projects.list(2)
    expect(first.text).toContain('host/team/alpha')
    expect(first.text).toContain('host/team/beta')
    expect(first.text).not.toContain('host/team/gamma')
    expect(first.text).not.toContain('user:other')
    expect(first.text).toContain('offset 2')
    expect(first.text).toContain('2 invalid catalog')
    expect((await projects.list(2, 2)).text).toContain('host/team/gamma')
    expect((await projects.list(0)).isError).toBe(true)
    expect((await projects.list(20, -1)).isError).toBe(true)
  })
})

describe('recall across explicit scopes', () => {
  test('combines user and project memory, preserves colliding keys, and excludes other projects', async () => {
    const { client, reads } = scopedClient()
    const shared = 'user:me'
    const alpha = projectNamespace(shared, 'host/team/alpha')
    const beta = projectNamespace(shared, 'host/team/beta')
    await client.push(shared, { 'prefs.md': 'Release preference: concise notes.' })
    await client.push(alpha, { 'prefs.md': 'Release alpha through the preview environment.' })
    await client.push(beta, { 'prefs.md': 'Release beta through an unrelated account.' })
    const result = await makeTools(client, shared).recall('release', undefined, 5, [shared, alpha])
    expect(result.isError).toBeUndefined()
    expect(result.text).toContain(`### prefs.md (${shared})`)
    expect(result.text).toContain(`### prefs.md (${alpha})`)
    expect(result.text).not.toContain('unrelated account')
    expect(reads).toEqual([shared, alpha])
    reads.length = 0
    await makeTools(client, shared).recall('release', undefined, 5, [shared, shared])
    expect(reads).toEqual([shared])
  })

  test('source identity is preserved without treating namespaces as ranking terms', () => {
    const candidates = [
      { namespace: 'user:release', key: 'note.md', content: 'Orchids need indirect sunlight.' },
      { namespace: 'user:me', key: 'note.md', content: 'The release needs review.' },
      { namespace: 'user:me', key: 'MEMORY.md', content: 'release release release' },
      { namespace: 'user:release', key: 'MEMORY.md', content: 'release release release' },
    ]
    const result = rankEntriesDetailed('release', candidates)
    expect(result.searched).toBe(2)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].namespace).toBe('user:me')
  })

  test('one total result limit and size cap includes source labels and follow-up pointers', async () => {
    const { client } = scopedClient()
    for (const ns of ['user:me', 'user:me/projects/a']) {
      await client.push(
        ns,
        Object.fromEntries(
          Array.from({ length: 20 }, (_, i) => [
            `project/release-${i}.md`,
            `# Release\n${'Release review requires signed commits. '.repeat(100)}`,
          ]),
        ),
      )
    }
    const tools = makeTools(client, 'user:me')
    const limited = await tools.recall('release', undefined, 1, ['user:me', 'user:me/projects/a'])
    expect(limited.text.match(/^### /gm)).toHaveLength(1)
    expect(limited.text).toContain('39 further relevant entries')
    const result = await tools.recall('release', undefined, 20, ['user:me', 'user:me/projects/a'])
    expect(result.text.length).toBeLessThanOrEqual(4000)
    expect(result.text).toContain('and namespace "')
    expect(result.text).toContain('recall size cap')
  })

  test('scope validation happens before reads, and an unreadable scope fails visibly', async () => {
    const { client, reads, failReads } = scopedClient()
    const tools = makeTools(client, 'user:me')
    for (const scopes of [[], ['../bad'], Array.from({ length: 9 }, (_, i) => `user:a${i}`)])
      expect((await tools.recall('release', undefined, 5, scopes)).isError).toBe(true)
    expect((await tools.recall('release', 'user:me', 5, ['user:other'])).isError).toBe(true)
    expect(reads).toEqual([])
    failReads('user:me/projects/broken')
    const result = await tools.recall('release', undefined, 5, [
      'user:me',
      'user:me/projects/broken',
    ])
    expect(result.isError).toBe(true)
    expect(result.text).toContain('user:me/projects/broken')
    expect(result.text).toContain('store unavailable')
  })
})
