/**
 * Three-way merge on a stale write and per-key version history, through the
 * real server with two real clients. Own namespaces, each holding at most two
 * notes plus bookkeeping: the index, the access sidecar, a history entry and a
 * trash copy each take one of the five slots tests/setup.ts allows.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { OpenRecallClient } from '../client/index.ts'
import { parseFrontmatter } from '../src/mcp/frontmatter.ts'
import { HISTORY_ENV, type HistoryFile } from '../src/mcp/history.ts'
import { HISTORY_PREFIX, historyKey, TRASH_PREFIX } from '../src/mcp/keys.ts'
import { MAX_LAST_READ_NAMESPACES, makeSession } from '../src/mcp/session.ts'
import { type MemoryTools, makeTools } from '../src/mcp/tools.ts'
import { _reset } from '../src/ratelimit.ts'

let server: ReturnType<typeof Bun.serve>
let url: string

beforeAll(async () => {
  const { handleRequest } = await import('../src/handler.ts')
  server = Bun.serve({ port: 0, fetch: handleRequest })
  url = `http://localhost:${server.port}`
})
afterAll(() => server?.stop(true))
afterEach(() => _reset())

const client = () => new OpenRecallClient({ url, passphrase: 'history-merge' })
const mk = (ns: string, session = makeSession()) => makeTools(client(), ns, session)

/** The history entry of `key` as stored, read by name like any hidden key; null when there is none. */
async function historyOf(t: MemoryTools, key: string, ns: string): Promise<HistoryFile | null> {
  const r = await t.get(historyKey(key) as string, ns)
  if (r.text.startsWith('(no entry')) return null
  return JSON.parse(r.text.slice(r.text.indexOf('\n') + 1)) as HistoryFile
}

/** The stored note's frontmatter and body, out of a `memory_get` answer. */
const noteOf = (text: string) => parseFrontmatter(text.slice(text.indexOf('\n') + 1))

const V1 = 'line one\nline two\nline three\n'

describe('three-way merge on a stale write', () => {
  test('edits on different lines are merged, both land, and the merge records history', async () => {
    const NS = 'user:me/merge-lines'
    const sessionA = makeSession()
    const a = mk(NS, sessionA)
    const b = mk(NS)
    expect((await a.save('n.md', V1, NS)).isError).toBeUndefined()
    const id = noteOf((await a.get('n.md', NS)).text)?.fields.get('id')
    // A read the note, so its next write carries a base measured against that
    // read and the session remembers the text as the base of a merge. B
    // changes line three underneath it; A changes line one of what it read.
    const byB = 'line one\nline two\nB wrote line three\n'
    expect((await b.save('n.md', byB, NS)).isError).toBeUndefined()
    const r = await a.save('n.md', 'A wrote line one\nline two\nline three\n', NS)
    expect(r.isError).toBeUndefined()
    expect(r.text).toMatch(
      /^merged "n\.md" in user:me\/merge-lines \(v\d+\): kept both sides' changes \(1 line from the other session\)$/,
    )
    const stored = noteOf((await b.get('n.md', NS)).text)
    expect(stored?.body).toBe('A wrote line one\nline two\nB wrote line three\n')
    // The stamp of a merge: the stored id survives, agent and session are the
    // merging process's.
    expect(stored?.fields.get('id')).toBe(id as string)
    expect(stored?.fields.get('session')).toBe(sessionA.sessionId)
    // History: B's save recorded v1; the merge recorded the version it replaced, B's.
    const h = await historyOf(a, 'n.md', NS)
    expect(h?.versions.map(v => parseFrontmatter(v.content)?.body)).toEqual([byB, V1])
    expect(h?.versions[0]?.hash).toMatch(/^sha256:/)
  })

  test('the base can come from recall; the merge keeps a line the other side added at the end', async () => {
    const NS = 'user:me/merge-recall'
    const a = mk(NS)
    const b = mk(NS)
    const v1 = 'The harbor lantern is lit at dusk.\nThe quill is kept in the marble drawer.\n'
    expect((await a.save('n.md', v1, NS)).isError).toBeUndefined()
    expect((await a.recall('harbor lantern lit', NS)).text).toContain('### n.md')
    expect(
      (await b.save('n.md', `${v1}The orchard gate is locked at night.\n`, NS)).isError,
    ).toBeUndefined()
    const r = await a.save(
      'n.md',
      'The harbor lantern is lit at dawn.\nThe quill is kept in the marble drawer.\n',
      NS,
    )
    expect(r.isError).toBeUndefined()
    expect(r.text).toStartWith('merged "n.md"')
    expect(noteOf((await b.get('n.md', NS)).text)?.body).toBe(
      'The harbor lantern is lit at dawn.\nThe quill is kept in the marble drawer.\nThe orchard gate is locked at night.\n',
    )
  })

  test('edits on the same line conflict: the hunk is shown, nothing is written, and mode: update then lands', async () => {
    const NS = 'user:me/merge-conflict'
    const a = mk(NS)
    const b = mk(NS)
    expect((await a.save('n.md', V1, NS)).isError).toBeUndefined()
    await a.get('n.md', NS)
    const byB = 'line one\nB wrote line two\nline three\n'
    expect((await b.save('n.md', byB, NS)).isError).toBeUndefined()
    const r = await a.save('n.md', 'line one\nA wrote line two\nline three\n', NS)
    expect(r.isError).toBe(true)
    expect(r.text).toStartWith(
      'needs_decision (conflict): "n.md" changed under you and the edits overlap; resolve the hunks below, then resave with mode: "update".\n',
    )
    expect(r.text).toContain(
      '<<<<<<< yours\nA wrote line two\n||||||| base\nline two\n=======\nB wrote line two\n>>>>>>> current\n',
    )
    // Only the conflicting hunk is shown, not the lines both sides left alone.
    expect(r.text).not.toContain('line three')
    // Nothing was written: B's version stands, and its history gained nothing.
    expect(noteOf((await b.get('n.md', NS)).text)?.body).toBe(byB)
    expect((await historyOf(a, 'n.md', NS))?.versions).toHaveLength(1)
    // The agent resolves and resaves with mode: update. The read made during
    // the refusal is the base of this write, so it lands and records B's version.
    const fixed = await a.save('n.md', 'line one\nA and B wrote line two\nline three\n', NS, {
      mode: 'update',
    })
    expect(fixed.isError).toBeUndefined()
    expect(fixed.text).toStartWith('saved "n.md"')
    expect(noteOf((await b.get('n.md', NS)).text)?.body).toContain('A and B wrote line two')
    const h = await historyOf(a, 'n.md', NS)
    expect(h?.versions.map(v => parseFrontmatter(v.content)?.body)).toEqual([byB, V1])
  })

  test('frontmatter merges field-wise: tags are unioned, a description changed on both sides conflicts', async () => {
    const NS = 'user:me/merge-fields'
    const a = mk(NS)
    const b = mk(NS)
    const note = (desc: string, tags: string, body: string) =>
      `---\ndescription: ${desc}\ntags: [${tags}]\n---\n${body}`
    expect((await a.save('n.md', note('the plan', 'alpha', V1), NS)).isError).toBeUndefined()
    await a.get('n.md', NS)
    expect(
      (
        await b.save(
          'n.md',
          note('the plan', 'alpha, beta', 'line one\nline two\nB line three\n'),
          NS,
          {
            mode: 'update',
          },
        )
      ).isError,
    ).toBeUndefined()
    const r = await a.save(
      'n.md',
      note('the plan', 'alpha, gamma', 'A line one\nline two\nline three\n'),
      NS,
    )
    expect(r.isError).toBeUndefined()
    expect(r.text).toStartWith('merged "n.md"')
    const merged = noteOf((await b.get('n.md', NS)).text)
    expect(merged?.fields.get('tags')).toEqual(['alpha', 'gamma', 'beta'])
    expect(merged?.fields.get('description')).toBe('the plan')
    expect(merged?.body).toBe('A line one\nline two\nB line three\n')

    // Both sides now change the description differently, with the same body
    // change: the field conflicts, rendered in the body's own markers.
    await a.get('n.md', NS)
    expect(
      (await b.save('n.md', note('the plan, by B', 'alpha', V1), NS, { mode: 'update' })).isError,
    ).toBeUndefined()
    const c = await a.save('n.md', note('the plan, by A', 'alpha', V1), NS)
    expect(c.isError).toBe(true)
    expect(c.text).toStartWith('needs_decision (conflict): "n.md"')
    expect(c.text).toContain(
      '<<<<<<< yours\ndescription: the plan, by A\n||||||| base\ndescription: the plan\n=======\ndescription: the plan, by B\n>>>>>>> current\n',
    )
    expect(noteOf((await b.get('n.md', NS)).text)?.fields.get('description')).toBe('the plan, by B')
  })

  test('with no remembered base the stale write is refused as before', async () => {
    const NS = 'user:me/merge-nobase'
    const a = mk(NS)
    const b = mk(NS)
    expect((await a.save('n.md', V1, NS)).isError).toBeUndefined()
    // Writing in eight other namespaces drops this one from the session's
    // remembered bases; the client itself still carries the write base.
    for (let i = 0; i < MAX_LAST_READ_NAMESPACES; i++) {
      const other = `user:me/merge-evict-${i}`
      expect(
        (await a.save('o.md', `Note ${i} in another namespace.\n`, other)).isError,
      ).toBeUndefined()
    }
    expect(
      (await b.save('n.md', 'line one\nline two\nB wrote line three\n', NS)).isError,
    ).toBeUndefined()
    const stale = await a.save('n.md', 'A wrote line one\nline two\nline three\n', NS)
    expect(stale.isError).toBe(true)
    expect(stale.text).toContain('409 stale base')
    expect(stale.text).toContain('memory_get')
    expect(stale.text).not.toContain('needs_decision')
    const stored = noteOf((await b.get('n.md', NS)).text)?.body
    expect(stored).toContain('B wrote line three')
    expect(stored).not.toContain('A wrote')
  })
})

describe('version history', () => {
  const body = (n: number) => `---\ndescription: history note\n---\nVersion ${n} of the note.\n`
  const numbers = (h: HistoryFile | null) =>
    h?.versions.map(v => v.content.match(/Version (\d)/)?.[1])

  test('each changed save records the replaced version, newest first, five kept', async () => {
    const NS = 'user:me/history-cap'
    const t = mk(NS)
    expect((await t.save('k.md', body(1), NS)).isError).toBeUndefined()
    // A create replaces nothing.
    expect(await historyOf(t, 'k.md', NS)).toBeNull()
    expect((await t.save('k.md', body(2), NS)).isError).toBeUndefined()
    let h = await historyOf(t, 'k.md', NS)
    expect(numbers(h)).toEqual(['1'])
    expect(h?.versions[0]?.agent).toBe('unknown')
    expect(h?.versions[0]?.hash).toMatch(/^sha256:/)
    expect(h?.versions[0]?.updated).toBe(
      parseFrontmatter(h?.versions[0]?.content ?? '')?.fields.get('updated') as string,
    )
    expect((await t.save('k.md', body(3), NS)).isError).toBeUndefined()
    expect(numbers(await historyOf(t, 'k.md', NS))).toEqual(['2', '1'])
    for (let n = 4; n <= 7; n++) {
      expect((await t.save('k.md', body(n), NS)).isError).toBeUndefined()
    }
    h = await historyOf(t, 'k.md', NS)
    expect(numbers(h)).toEqual(['6', '5', '4', '3', '2'])
    // Hidden: listed only on request, never ranked, never searched.
    expect((await t.list(NS)).text).not.toContain(HISTORY_PREFIX)
    expect((await t.list(NS, { includeSystem: true })).text).toContain(historyKey('k.md') as string)
    const recalled = await t.recall('version of the note', NS)
    expect(recalled.text).toContain('### k.md')
    expect(recalled.text).not.toContain(HISTORY_PREFIX)
    expect(recalled.text).toStartWith('1 relevant memory from')
    expect((await t.search('Version 2', NS)).text).not.toContain(HISTORY_PREFIX)
  })

  test('memory_get reads a prior version under its header; a missing one is an ordinary answer', async () => {
    const NS = 'user:me/history-get'
    const t = mk(NS)
    expect((await t.save('k.md', body(1), NS)).isError).toBeUndefined()
    expect((await t.save('k.md', body(2), NS)).isError).toBeUndefined()
    const r = await t.get('k.md', NS, { version: 1 })
    expect(r.isError).toBeUndefined()
    expect(r.text).toMatch(
      /^### k\.md \(user:me\/history-get\) version 1 of 1, stored \d{4}-\d{2}-\d{2}T\S+ by unknown\n---\n/,
    )
    expect(r.text).toContain('Version 1 of the note.')
    expect(r.text).not.toContain('Version 2')
    const missing = await t.get('k.md', NS, { version: 2 })
    expect(missing.isError).toBeUndefined()
    expect(missing.text).toBe(
      '(no stored version 2 of "k.md" in user:me/history-get: 1 prior version is kept, numbered 1 (most recent) to 1)',
    )
    const never = await t.get('other.md', NS, { version: 1 })
    expect(never.text).toBe(
      '(no stored version 1 of "other.md" in user:me/history-get: 0 prior versions are kept)',
    )
  })

  test('a resave that changes only its stamps spends no history slot', async () => {
    const NS = 'user:me/history-stamps'
    const t = mk(NS)
    expect((await t.save('k.md', body(1), NS)).isError).toBeUndefined()
    expect((await t.save('k.md', body(1), NS)).text).toStartWith('saved "k.md"')
    expect(await historyOf(t, 'k.md', NS)).toBeNull()
  })

  test('OPENRECALL_HISTORY=0 records nothing', async () => {
    const NS = 'user:me/history-off'
    const t = mk(NS)
    const prior = process.env[HISTORY_ENV]
    process.env[HISTORY_ENV] = '0'
    try {
      expect((await t.save('k.md', body(1), NS)).isError).toBeUndefined()
      expect((await t.save('k.md', body(2), NS)).text).toStartWith('saved "k.md"')
    } finally {
      if (prior === undefined) delete process.env[HISTORY_ENV]
      else process.env[HISTORY_ENV] = prior
    }
    expect(await historyOf(t, 'k.md', NS)).toBeNull()
    expect((await t.list(NS, { includeSystem: true })).text).not.toContain(HISTORY_PREFIX)
  })

  test('a soft delete records no history: the trash copy is the last version', async () => {
    const NS = 'user:me/history-delete'
    const t = mk(NS)
    expect((await t.save('k.md', body(1), NS)).isError).toBeUndefined()
    expect((await t.delete('k.md', NS)).text).toStartWith('moved "k.md" to the trash')
    const all = (await t.list(NS, { includeSystem: true })).text
    expect(all).toContain(TRASH_PREFIX)
    expect(all).not.toContain(HISTORY_PREFIX)
  })

  test('supersede records the replaced note as it was before it was marked', async () => {
    const NS = 'user:me/history-supersede'
    const t = mk(NS)
    expect((await t.save('old.md', body(1), NS)).isError).toBeUndefined()
    const r = await t.save(
      'new.md',
      '---\ndescription: the newer note\n---\nA different fact entirely.\n',
      NS,
      { mode: 'supersede', supersedes: 'old.md' },
    )
    expect(r.isError).toBeUndefined()
    const h = await historyOf(t, 'old.md', NS)
    expect(numbers(h)).toEqual(['1'])
    expect(h?.versions[0]?.content).not.toContain('status: superseded')
    expect((await t.get('old.md', NS)).text).toContain('status: superseded')
    expect(await historyOf(t, 'new.md', NS)).toBeNull()
  })

  test('a key too long for a history key is saved and says history was not recorded', async () => {
    const NS = 'user:me/history-long'
    const t = mk(NS)
    const key = `${'k'.repeat(240)}.md`
    expect(historyKey(key)).toBeNull()
    expect((await t.save(key, body(1), NS)).isError).toBeUndefined()
    const r = await t.save(key, body(2), NS)
    expect(r.isError).toBeUndefined()
    expect(r.text).toBe(`${r.text.split('\n')[0]}\n(history not recorded: key-too-long)`)
    expect((await t.get(key, NS, { version: 1 })).text).toStartWith(
      `(no stored version 1 of "${key}"`,
    )
  })

  test('a history entry is erased only with hard: true, never by hand otherwise', async () => {
    const NS = 'user:me/history-erase'
    const t = mk(NS)
    expect((await t.save('k.md', body(1), NS)).isError).toBeUndefined()
    expect((await t.save('k.md', body(2), NS)).isError).toBeUndefined()
    const hk = historyKey('k.md') as string
    const soft = await t.delete(hk, NS)
    expect(soft.isError).toBe(true)
    expect(soft.text).toContain('a version history entry')
    expect((await t.delete(hk, NS, { hard: true })).text).toStartWith(`deleted "${hk}"`)
    expect(await historyOf(t, 'k.md', NS)).toBeNull()
    expect((await t.save(hk, '{}', NS)).isError).toBe(true)
  })
})
