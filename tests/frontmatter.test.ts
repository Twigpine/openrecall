/**
 * Frontmatter parser, serializer and save-time stamp (`src/mcp/frontmatter.ts`).
 * Round-trips every accepted form, pins the opaque-line rule against Claude
 * Code's nested `metadata:` map, exercises each validation error, and checks
 * the two invariants the rest of the MCP layer relies on: `description:` is
 * the first line that can contain that substring, and `stripFrontmatter`
 * agrees with the regex `src/mcp/tools.ts` uses on the recall corpus.
 */

import { describe, expect, test } from 'bun:test'
import {
  type FmValue,
  FrontmatterError,
  inferType,
  parseFrontmatter,
  type StampContext,
  serializeFrontmatter,
  stampForSave,
  stripFrontmatter,
  TYPES,
  ulid,
} from '../src/mcp/frontmatter.ts'
import { CORPUS } from './recall-corpus.ts'

const ctx: StampContext = {
  now: '2026-11-05T10:00:00.000Z',
  agent: 'claude-code/2.1.284',
  session: 'sess-1',
  key: 'project/deploy.md',
}

function fields(content: string): Map<string, FmValue> {
  const fm = parseFrontmatter(content)
  if (!fm) throw new Error('expected frontmatter')
  return fm.fields
}

function block(content: string): string[] {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(content)
  if (!m) throw new Error('expected a frontmatter block')
  return m[1].split('\n')
}

describe('parseFrontmatter', () => {
  test('every accepted form parses and round-trips through the serializer', () => {
    const src = [
      '---',
      'name: plain scalar',
      'tags: [a, b, "c, d"]',
      'list:',
      '  - one',
      '  - "two"',
      "  - 'three'",
      'dq: "say \\"hi\\" \\\\ now"',
      "sq: 'it''s'",
      'yes: true',
      'no: false',
      'empty:',
      'spaced: ',
      'url: https://example.test/path',
      'flow_empty: []',
      '---',
      'body line',
      '',
    ].join('\n')
    const fm = parseFrontmatter(src)
    expect(fm).not.toBeNull()
    const f = fm!.fields
    expect(f.get('name')).toBe('plain scalar')
    expect(f.get('tags')).toEqual(['a', 'b', 'c, d'])
    expect(f.get('list')).toEqual(['one', 'two', 'three'])
    expect(f.get('dq')).toBe('say "hi" \\ now')
    expect(f.get('sq')).toBe("it's")
    expect(f.get('yes')).toBe(true)
    expect(f.get('no')).toBe(false)
    expect(f.get('empty')).toBe('')
    expect(f.get('spaced')).toBe('')
    expect(f.get('url')).toBe('https://example.test/path')
    expect(f.get('flow_empty')).toEqual([])
    expect(fm!.opaque.size).toBe(0)
    expect(fm!.body).toBe('body line\n')

    const again = parseFrontmatter(serializeFrontmatter(f, fm!.opaque) + fm!.body)
    expect(again).not.toBeNull()
    expect([...again!.fields.entries()]).toEqual([...f.entries()])
    expect(again!.body).toBe('body line\n')
  })

  test('returns null without a block, and for an opening that never closes', () => {
    expect(parseFrontmatter('# just a note')).toBeNull()
    expect(parseFrontmatter('')).toBeNull()
    expect(parseFrontmatter('---\nname: x\nno closing here')).toBeNull()
    expect(parseFrontmatter(' ---\nname: x\n---\n')).toBeNull()
  })

  test('closing line may carry trailing blanks or end the text', () => {
    expect(parseFrontmatter('---\nname: x\n--- \t\nbody')!.body).toBe('body')
    expect(parseFrontmatter('---\nname: x\n---')!.body).toBe('')
    expect(parseFrontmatter('---\n---\nbody')!.fields.size).toBe(0)
  })

  test('CRLF frontmatter parses and the body keeps its own bytes', () => {
    const fm = parseFrontmatter('---\r\nname: x\r\ntags: [a]\r\n---\r\nline\r\n')
    expect(fm!.fields.get('name')).toBe('x')
    expect(fm!.fields.get('tags')).toEqual(['a'])
    expect(fm!.body).toBe('line\r\n')
  })

  test('opaque lines are kept verbatim and anchored to the preceding key', () => {
    const src = [
      '---',
      '# leading comment',
      'name: n',
      'description: d',
      'metadata:',
      '  type: project',
      '  nested:',
      '    deeper: true',
      'folded: >',
      '  a long',
      '  scalar',
      'anchored: &x value',
      'commented: value # trailing comment',
      'badlist:',
      '  - ok',
      '  - {flow: map}',
      'after: last',
      '',
      '---',
      'body',
    ].join('\n')
    const fm = parseFrontmatter(src)!
    expect([...fm.fields.keys()]).toEqual(['name', 'description', 'after'])
    expect(fm.opaque.get('')).toEqual(['# leading comment'])
    expect(fm.opaque.get('description')).toEqual([
      'metadata:',
      '  type: project',
      '  nested:',
      '    deeper: true',
      'folded: >',
      '  a long',
      '  scalar',
      'anchored: &x value',
      'commented: value # trailing comment',
      'badlist:',
      '  - ok',
      '  - {flow: map}',
    ])
    expect(fm.opaque.get('after')).toEqual([''])

    // Re-emitted in place: the top comment right after the header keys, the
    // metadata run after `description`, the blank after `after`.
    const out = serializeFrontmatter(fm.fields, fm.opaque)
    expect(out).toBe(
      [
        '---',
        'description: d',
        '# leading comment',
        'metadata:',
        '  type: project',
        '  nested:',
        '    deeper: true',
        'folded: >',
        '  a long',
        '  scalar',
        'anchored: &x value',
        'commented: value # trailing comment',
        'badlist:',
        '  - ok',
        '  - {flow: map}',
        'name: n',
        'after: last',
        '',
        '---',
        '',
      ].join('\n'),
    )
    // The second parse sees the same fields; the top comment now travels with
    // `description`, which is the documented cost of keeping that key first.
    const again = parseFrontmatter(out + fm.body)!
    expect(Object.fromEntries(again.fields)).toEqual(Object.fromEntries(fm.fields))
    expect([...again.opaque.entries()]).toEqual([
      ['description', ['# leading comment', ...fm.opaque.get('description')!]],
      ['after', ['']],
    ])
  })

  test("Claude Code's auto-memory frontmatter round-trips with its nested map intact", () => {
    const note = [
      '---',
      'name: twigpine-product-family',
      'description: OpenRecall is a Twigpine product; naming rules',
      'metadata:',
      '  type: project',
      '---',
      '# Twigpine product family',
      '',
      'OpenRecall sits next to Zero and OpenClaude.',
      '',
    ].join('\n')
    const { content, meta } = stampForSave(null, note, ctx)
    expect(meta.description).toBe('OpenRecall is a Twigpine product; naming rules')
    expect(content).toContain('\nmetadata:\n  type: project\n')
    expect(
      content.endsWith(
        '---\n# Twigpine product family\n\nOpenRecall sits next to Zero and OpenClaude.\n',
      ),
    ).toBe(true)
    const again = parseFrontmatter(content)!
    expect(again.opaque.get('description')).toEqual(['metadata:', '  type: project'])
  })

  test('a duplicate accepted key keeps the first value and drops the rest', () => {
    const fm = parseFrontmatter('---\ndescription: first\ndescription: second\n---\n')!
    expect(fm.fields.get('description')).toBe('first')
    expect(fm.opaque.size).toBe(0)
    expect(serializeFrontmatter(fm.fields, fm.opaque).match(/description:/g)).toHaveLength(1)
  })

  test('lines outside the subset are opaque, not misread', () => {
    const fm = parseFrontmatter(
      [
        '---',
        'a: "unterminated',
        'b: "quoted" trailing',
        'c: [a, b',
        'd: [a,]',
        'e: {x: 1}',
        'f: |',
        '  block',
        'g: - item',
        'h:value',
        '- not a key',
        '---',
        '',
      ].join('\n'),
    )!
    expect(fm.fields.size).toBe(0)
    expect(fm.opaque.get('')).toHaveLength(10)
  })
})

describe('serializeFrontmatter', () => {
  test('emits the known keys in the fixed order, then others in insertion order', () => {
    const f = new Map<string, FmValue>([
      ['zeta', 'z'],
      ['updated', 'u'],
      ['name', 'n'],
      ['tags', ['a']],
      ['alpha', 'a'],
      ['id', 'i'],
      ['locked', true],
      ['description', 'd'],
      ['type', 'user'],
      ['created', 'c'],
    ])
    expect(serializeFrontmatter(f)).toBe(
      [
        '---',
        'id: i',
        'type: user',
        'description: d',
        'name: n',
        'tags: [a]',
        'created: c',
        'updated: u',
        'locked: true',
        'zeta: z',
        'alpha: a',
        '---',
        '',
      ].join('\n'),
    )
  })

  test('quotes a scalar only when a plain emission would not round-trip', () => {
    const cases: Array<[string, string]> = [
      ['plain words', 'plain words'],
      ['https://x.test/a:b', 'https://x.test/a:b'],
      ['', '""'],
      [' leading', '" leading"'],
      ['trailing ', '"trailing "'],
      ['key: value', '"key: value"'],
      ['ends:', '"ends:"'],
      ['has # hash', '"has # hash"'],
      ['[bracket', '"[bracket"'],
      ['-dash', '"-dash"'],
      ['"quoted"', '"\\"quoted\\""'],
      ["'single'", '"\'single\'"'],
      ['true', '"true"'],
      ['two\nlines', '"two\\nlines"'],
      ['back\\slash', 'back\\slash'],
    ]
    for (const [value, emitted] of cases) {
      const out = serializeFrontmatter(new Map([['k', value]]))
      expect(out).toBe(`---\nk: ${emitted}\n---\n`)
      expect(fields(out).get('k')).toBe(value)
    }
    const list = serializeFrontmatter(new Map([['k', ['a', 'b,c', 'd]e', '', ' f']]]))
    expect(list).toBe('---\nk: [a, "b,c", "d]e", "", " f"]\n---\n')
    expect(fields(list).get('k')).toEqual(['a', 'b,c', 'd]e', '', ' f'])
  })

  test('a plain array of opaque lines is emitted after every key', () => {
    const out = serializeFrontmatter(new Map([['name', 'n']]), ['# tail'])
    expect(out).toBe('---\nname: n\n# tail\n---\n')
  })

  test('refuses a key the parser would not read back', () => {
    expect(() => serializeFrontmatter(new Map([['bad key', 'x']]))).toThrow(FrontmatterError)
  })
})

describe('ulid', () => {
  const alphabet = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/

  test('is 26 Crockford base32 characters with the timestamp in the first ten', () => {
    const t = Date.parse('2026-11-05T10:00:00.000Z')
    const id = ulid(t)
    expect(id).toMatch(alphabet)
    const digits = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    let decoded = 0
    for (const ch of id.slice(0, 10)) decoded = decoded * 32 + digits.indexOf(ch)
    expect(decoded).toBe(t)
  })

  test('is monotone by time and random within a millisecond', () => {
    const a = ulid(1_000)
    const b = ulid(2_000)
    const c = ulid(2_000)
    expect(a < b).toBe(true)
    expect(b.slice(0, 10)).toBe(c.slice(0, 10))
    expect(b).not.toBe(c)
    const sorted = [ulid(3), ulid(2), ulid(1)].sort()
    expect(sorted.map(x => x.slice(0, 10))).toEqual(
      [ulid(1), ulid(2), ulid(3)].map(x => x.slice(0, 10)),
    )
  })

  test('rejects a timestamp outside 48 bits', () => {
    expect(() => ulid(-1)).toThrow(RangeError)
    expect(() => ulid(2 ** 48)).toThrow(RangeError)
    expect(() => ulid(1.5)).toThrow(RangeError)
  })
})

describe('inferType', () => {
  test('reads the four prefixes and nothing else', () => {
    expect(TYPES).toEqual(['user', 'feedback', 'project', 'reference'])
    expect(inferType('user/prefs.md')).toBe('user')
    expect(inferType('feedback/testing.md')).toBe('feedback')
    expect(inferType('project/deploy.md')).toBe('project')
    expect(inferType('reference/quotas.md')).toBe('reference')
    expect(inferType('MEMORY.md')).toBeUndefined()
    expect(inferType('agent/tools.md')).toBeUndefined()
    expect(inferType('user.md')).toBeUndefined()
    expect(inferType('users/x.md')).toBeUndefined()
  })
})

describe('stampForSave', () => {
  test('a note with no frontmatter gains one, with the body untouched', () => {
    const body =
      '# deploy\n\nWe deploy from the release branch.\n\n**Why:** the smoke run gates it.\n'
    const { content, corrected, meta } = stampForSave(null, body, ctx)
    expect(corrected).toEqual([])
    expect(content.endsWith(`---\n${body}`)).toBe(true)
    expect(block(content)).toEqual([
      `id: ${meta.id}`,
      'type: project',
      'created: 2026-11-05T10:00:00.000Z',
      'updated: 2026-11-05T10:00:00.000Z',
      'agent: claude-code/2.1.284',
      'session: sess-1',
    ])
    expect(meta.id).toHaveLength(26)
    expect(meta.type).toBe('project')
    expect(meta.created).toBe(ctx.now)
    expect(meta.updated).toBe(ctx.now)
    expect(stripFrontmatter(content)).toBe(body)
  })

  test('a corpus-shaped note keeps description and name verbatim', () => {
    const { content, meta } = stampForSave(null, CORPUS['project/deploy.md'], ctx)
    expect(meta.description).toBe('how we deploy Quillrun')
    expect(meta.name).toBe('deploy')
    expect(content).toContain('\ndescription: how we deploy Quillrun\nname: deploy\n')
    expect(stripFrontmatter(content)).toBe(stripFrontmatter(CORPUS['project/deploy.md']))
  })

  test('id and created are preserved from the existing note on update', () => {
    const first = stampForSave(null, 'v1\n', ctx)
    const later = { ...ctx, now: '2026-11-06T10:00:00.000Z', session: 'sess-2' }
    const second = stampForSave(first.content, 'v2\n', later)
    expect(second.meta.id).toBe(first.meta.id)
    expect(second.meta.created).toBe(ctx.now)
    expect(second.meta.updated).toBe(later.now)
    expect(second.meta.session).toBe('sess-2')
    expect(second.corrected).toEqual([])
    expect(stripFrontmatter(second.content)).toBe('v2\n')
  })

  test('an agent-supplied id that differs is replaced and reported', () => {
    const first = stampForSave(null, 'v1\n', ctx)
    const forged = `---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n---\nv2\n`
    const second = stampForSave(first.content, forged, ctx)
    expect(second.meta.id).toBe(first.meta.id)
    expect(second.corrected).toEqual(['id'])
    const fresh = stampForSave(null, forged, ctx)
    expect(fresh.meta.id).not.toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(fresh.corrected).toEqual(['id'])
    // Resaving exactly what memory_get returned corrects nothing.
    const resave = stampForSave(first.content, first.content, ctx)
    expect(resave.corrected).toEqual([])
  })

  test('a legacy note without created takes the server timestamp, else now', () => {
    const legacy = CORPUS['user/prefs.md']
    const stamped = stampForSave(legacy, legacy, {
      ...ctx,
      key: 'user/prefs.md',
      serverUpdatedAt: '2026-01-04T00:00:00.000Z',
    })
    expect(stamped.meta.created).toBe('2026-01-04T00:00:00.000Z')
    expect(stamped.meta.type).toBe('user')
    const noServer = stampForSave(legacy, legacy, { ...ctx, key: 'user/prefs.md' })
    expect(noServer.meta.created).toBe(ctx.now)
    const fresh = stampForSave(null, legacy, {
      ...ctx,
      key: 'user/prefs.md',
      serverUpdatedAt: '2026-01-04T00:00:00.000Z',
    })
    expect(fresh.meta.created).toBe('2026-01-04T00:00:00.000Z')
  })

  test('agent-supplied updated, agent, session and created are overwritten and reported', () => {
    const forged = [
      '---',
      'updated: 2001-01-01T00:00:00.000Z',
      'agent: someone-else/9.9',
      'session: not-mine',
      'created: 1999-12-31T00:00:00.000Z',
      '---',
      'body',
    ].join('\n')
    const { content, corrected, meta } = stampForSave(null, forged, ctx)
    expect(corrected.sort()).toEqual(['agent', 'created', 'session', 'updated'])
    expect(meta.updated).toBe(ctx.now)
    expect(meta.agent).toBe(ctx.agent)
    expect(meta.session).toBe(ctx.session)
    expect(meta.created).toBe(ctx.now)
    expect(content).not.toContain('someone-else')
    expect(content).not.toContain('1999')
  })

  test('type: explicit wins, else the existing note, else the key prefix, else absent', () => {
    const explicit = stampForSave(null, '---\ntype: reference\n---\nx', ctx)
    expect(explicit.meta.type).toBe('reference')
    const kept = stampForSave(explicit.content, 'x', ctx)
    expect(kept.meta.type).toBe('reference')
    const inferred = stampForSave(null, 'x', { ...ctx, key: 'feedback/testing.md' })
    expect(inferred.meta.type).toBe('feedback')
    const untyped = stampForSave(null, 'x', { ...ctx, key: 'agent/tools.md' })
    expect(untyped.meta.type).toBeUndefined()
    expect(untyped.content).not.toContain('type:')
  })

  test('a type outside the closed set is an error naming the set', () => {
    for (const bad of [
      '---\ntype: note\n---\n',
      '---\ntype: true\n---\n',
      '---\ntype: [user]\n---\n',
    ]) {
      let err: unknown
      try {
        stampForSave(null, bad, ctx)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(FrontmatterError)
      expect((err as FrontmatterError).field).toBe('type')
      expect((err as Error).message).toContain('user, feedback, project, reference')
    }
  })

  test('supersedes is validated as an entry key and may come from the context', () => {
    const ok = stampForSave(null, '---\nsupersedes: project/postgres-old.md\n---\n', ctx)
    expect(ok.meta.supersedes).toBe('project/postgres-old.md')
    const fromCtx = stampForSave(null, 'x', { ...ctx, supersedes: 'project/old.md' })
    expect(fromCtx.meta.supersedes).toBe('project/old.md')
    expect(fromCtx.content).toContain('\nsupersedes: project/old.md\n')
    for (const bad of ['../etc', '/abs', 'a//b', 'a\\b', '']) {
      expect(() => stampForSave(null, `---\nsupersedes: '${bad}'\n---\n`, ctx)).toThrow(
        FrontmatterError,
      )
    }
    expect(() => stampForSave(null, `---\nsupersedes: ${ctx.key}\n---\n`, ctx)).toThrow(
      /must not name the note itself/,
    )
    expect(() => stampForSave(null, '---\nsuperseded_by: ../x\n---\n', ctx)).toThrow(
      FrontmatterError,
    )
  })

  test('expires must be a real YYYY-MM-DD date', () => {
    const ok = stampForSave(null, '---\nexpires: 2027-02-28\n---\n', ctx)
    expect(ok.meta.expires).toBe('2027-02-28')
    for (const bad of [
      '2027-2-28',
      '2027-02-30',
      '2027-13-01',
      '2027-00-10',
      'tomorrow',
      '2027-02-28T00:00:00Z',
    ]) {
      let err: unknown
      try {
        stampForSave(null, `---\nexpires: "${bad}"\n---\n`, ctx)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(FrontmatterError)
      expect((err as FrontmatterError).field).toBe('expires')
    }
  })

  test('tags are lowercase slugs, de-duplicated, at most eight', () => {
    const ok = stampForSave(null, '---\ntags: [ci, release-notes, ci, a1]\n---\n', ctx)
    expect(ok.meta.tags).toEqual(['ci', 'release-notes', 'a1'])
    expect(ok.content).toContain('\ntags: [ci, release-notes, a1]\n')
    const scalar = stampForSave(null, '---\ntags: ci, deploy\n---\n', ctx)
    expect(scalar.meta.tags).toEqual(['ci', 'deploy'])
    const blockList = stampForSave(null, '---\ntags:\n  - ci\n  - deploy\n---\n', ctx)
    expect(blockList.meta.tags).toEqual(['ci', 'deploy'])
    for (const bad of ['[Ci]', '[-x]', '[a b]', '[a_b]', '[a, b, c, d, e, f, g, h, i]', 'true']) {
      let err: unknown
      try {
        stampForSave(null, `---\ntags: ${bad}\n---\n`, ctx)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(FrontmatterError)
      expect((err as FrontmatterError).field).toBe('tags')
    }
  })

  test('locked must be a boolean; description must be a string', () => {
    expect(stampForSave(null, '---\nlocked: true\n---\n', ctx).meta.locked).toBe(true)
    expect(stampForSave(null, '---\nlocked: false\n---\n', ctx).meta.locked).toBe(false)
    expect(() => stampForSave(null, '---\nlocked: yes\n---\n', ctx)).toThrow(/locked must be/)
    expect(() => stampForSave(null, '---\nlocked: "true"\n---\n', ctx)).toThrow(/locked must be/)
    expect(() => stampForSave(null, '---\ndescription: [a, b]\n---\n', ctx)).toThrow(
      /description must be/,
    )
    expect(() => stampForSave(null, 'x', { ...ctx, now: 'not a date' })).toThrow(FrontmatterError)
  })

  test('status, deleted and unknown keys ride along', () => {
    const src = '---\nstatus: superseded\ndeleted: 2026-11-05\ncustom: kept\n---\nx'
    const { content, meta } = stampForSave(null, src, ctx)
    expect(meta.status).toBe('superseded')
    expect(meta.deleted).toBe('2026-11-05')
    expect(content).toContain('\nstatus: superseded\ndeleted: 2026-11-05\ncustom: kept\n---\n')
  })

  test('description: appears exactly once and before any other key containing it', () => {
    const src = [
      '---',
      'old_description: stale',
      'name: n',
      'metadata:',
      '  description: nested',
      'description: the real one',
      'description_long: longer',
      '---',
      'body',
    ].join('\n')
    const { content } = stampForSave(null, src, ctx)
    const lines = block(content)
    const hits = lines.filter(l => /description:/i.test(l))
    expect(lines.filter(l => l.startsWith('description:'))).toHaveLength(1)
    expect(hits[0]).toBe('description: the real one')
    // Exactly what relevance.ts's unanchored regex sees.
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)!
    expect(/description:\s*(.+)/i.exec(m[1])![1]).toBe('the real one')
    // And the stamped header never interleaves anything between id, type and
    // description, so a leading opaque comment cannot get in front either.
    const commented = stampForSave(
      null,
      '---\n# my description: fake\ndescription: real\n---\n',
      ctx,
    )
    expect(block(commented.content).slice(0, 3)).toEqual([
      `id: ${commented.meta.id}`,
      'type: project',
      'description: real',
    ])
  })

  test('stamping is stable: a second pass over its own output changes only updated', () => {
    const first = stampForSave(null, CORPUS['feedback/testing.md'], {
      ...ctx,
      key: 'feedback/testing.md',
    })
    const later = { ...ctx, key: 'feedback/testing.md', now: '2026-11-06T00:00:00.000Z' }
    const second = stampForSave(first.content, first.content, later)
    expect(second.corrected).toEqual([])
    expect(second.content).toBe(
      first.content.replace(`updated: ${ctx.now}`, `updated: ${later.now}`),
    )
  })
})

describe('stripFrontmatter', () => {
  /** Copy of the regex `regionFor` strips with in src/mcp/tools.ts. */
  function toolsStrip(content: string): string {
    const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(content)
    return m ? content.slice(m[0].length) : content
  }

  test('agrees with the tools.ts regex on every corpus entry', () => {
    for (const [key, content] of Object.entries(CORPUS)) {
      expect(stripFrontmatter(content)).toBe(toolsStrip(content))
      if (key !== 'MEMORY.md') expect(stripFrontmatter(content)).not.toBe(content)
    }
  })

  test('agrees on the edge shapes the regex covers', () => {
    for (const c of [
      '---\nx: 1\n---\nbody',
      '---\nx: 1\n---',
      '---\t\r\nx: 1\r\n--- \r\nbody\r\n',
      '---\nx: 1\nnever closes',
      'no block\n---\nx\n---\n',
      '---\n\n---\nbody',
      '',
    ]) {
      expect(stripFrontmatter(c)).toBe(toolsStrip(c))
    }
  })
})
