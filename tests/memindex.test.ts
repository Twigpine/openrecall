/**
 * The generated index (`src/mcp/memindex.ts`): grouping and ordering, the
 * Pinned section's survival and cut, the line and byte caps with their tail,
 * the near-cap warning, exclusions, legacy adoption against the fixture
 * corpus's hand-written index, and determinism.
 */

import { describe, expect, test } from 'bun:test'
import {
  DESCRIPTION_CLIP,
  GENERATED_MARKER,
  generateIndex,
  type IndexNote,
  isExpired,
  isLinkLine,
  MAX_BYTES,
  MAX_LINES,
  MAX_PINNED,
  NEAR_CAP_BYTES,
  NEAR_CAP_LINES,
  PINNED_HEADING,
  parseIndex,
  TITLE_LINE,
  utf8Length,
} from '../src/mcp/memindex.ts'
import { CORPUS } from './recall-corpus.ts'

const NOW = new Date('2026-11-05T12:00:00Z')

const n = (key: string, extra: Partial<IndexNote> = {}): IndexNote => ({ key, ...extra })

/** Lines of the section headed `## <name>`, up to the next h2. */
function section(text: string, name: string): string[] {
  const lines = text.split('\n')
  const start = lines.indexOf(`## ${name}`)
  if (start < 0) return []
  const out: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i]) || lines[i].startsWith('… ')) break
    out.push(lines[i])
  }
  while (out.length && out[out.length - 1] === '') out.pop()
  return out
}

/** `k` notes in one group, equal-length lines, note i updated one minute after note i-1. */
function filler(k: number, type = 'project', descLength = 20): IndexNote[] {
  return Array.from({ length: k }, (_, i) =>
    n(`${type}/note-${String(i).padStart(4, '0')}.md`, {
      type,
      description: 'd'.repeat(descLength),
      updated: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    }),
  )
}

describe('generateIndex: shape', () => {
  test('title, marker, Pinned, then sections in type order with other last', () => {
    const notes = [
      n('zeta/other.md', { description: 'untyped goes to other' }),
      n('reference/errors.md', { type: 'reference', description: 'status codes' }),
      n('project/deploy.md', { type: 'project', description: 'how we deploy' }),
      n('feedback/testing.md', { type: 'feedback', description: 'how tests are written' }),
      n('user/prefs.md', { type: 'user', description: 'numbers first' }),
      n('notes/odd.md', { type: 'decision', description: 'unknown type goes to other' }),
    ]
    const { text, truncated, nearCap } = generateIndex(notes, ['keep this line'], NOW)
    const lines = text.split('\n')
    expect(lines[0]).toBe(TITLE_LINE)
    expect(lines[1]).toBe(GENERATED_MARKER)
    expect(lines[2]).toBe('')
    expect(lines[3]).toBe(PINNED_HEADING)
    expect(lines[4]).toBe('keep this line')
    const headings = lines.filter(l => l.startsWith('## '))
    expect(headings).toEqual([
      '## Pinned',
      '## user',
      '## feedback',
      '## project',
      '## reference',
      '## other',
    ])
    expect(section(text, 'user')).toEqual(['- [prefs](user/prefs.md) — numbers first'])
    expect(section(text, 'other')).toEqual([
      '- [odd](notes/odd.md) — unknown type goes to other',
      '- [other](zeta/other.md) — untyped goes to other',
    ])
    expect(truncated).toBe(0)
    expect(nearCap).toBe(false)
    expect(text.endsWith('\n')).toBe(false)
  })

  test('empty sections are omitted, Pinned never is', () => {
    const { text } = generateIndex([n('project/x.md', { type: 'project' })], [], NOW)
    expect(text.split('\n').filter(l => l.startsWith('## '))).toEqual(['## Pinned', '## project'])
    const empty = generateIndex([], [], NOW)
    expect(empty.text).toBe(`${TITLE_LINE}\n${GENERATED_MARKER}\n\n${PINNED_HEADING}`)
    expect(empty.lines).toBe(4)
  })

  test('newest updated first within a group, undated last, ties by key', () => {
    const notes = [
      n('project/b.md', { type: 'project', updated: '2026-03-01T00:00:00Z' }),
      n('project/undated-z.md', { type: 'project' }),
      n('project/a.md', { type: 'project', updated: '2026-03-01T00:00:00Z' }),
      n('project/c.md', { type: 'project', updated: '2026-05-01T00:00:00Z' }),
      n('project/undated-a.md', { type: 'project' }),
    ]
    expect(section(generateIndex(notes, [], NOW).text, 'project')).toEqual([
      '- [c](project/c.md)',
      '- [a](project/a.md)',
      '- [b](project/b.md)',
      '- [undated-a](project/undated-a.md)',
      '- [undated-z](project/undated-z.md)',
    ])
  })

  test('name defaults to the basename without .md; descriptions clip at 120 on one line', () => {
    const notes = [
      n('project/deploy.md', {
        type: 'project',
        name: 'Deploy [prod]',
        description: 'how we\n  deploy',
      }),
      n('project/long.md', { type: 'project', description: 'w'.repeat(200) }),
      n('project/plain', { type: 'project' }),
    ]
    const lines = section(generateIndex(notes, [], NOW).text, 'project')
    expect(lines).toContain('- [Deploy \\[prod\\]](project/deploy.md) — how we deploy')
    expect(lines).toContain('- [plain](project/plain)')
    const long = lines.find(l => l.includes('project/long.md'))!
    const desc = long.slice(long.indexOf('— ') + 2)
    expect(desc).toHaveLength(DESCRIPTION_CLIP)
    expect(desc.endsWith('…')).toBe(true)
  })
})

describe('generateIndex: exclusions', () => {
  test('hidden, inactive and expired notes are absent; today and malformed dates stay', () => {
    const notes = [
      n('MEMORY.md', { type: 'project' }),
      n('project/MEMORY.md', { type: 'project' }),
      n('sys.openrecall/trash/project/old.md', { type: 'project' }),
      n('project/superseded.md', { type: 'project', status: 'superseded' }),
      n('project/deleted.md', { type: 'project', status: 'deleted' }),
      n('project/expired.md', { type: 'project', expires: '2026-11-04' }),
      n('project/expires-today.md', { type: 'project', expires: '2026-11-05' }),
      n('project/expires-later.md', { type: 'project', expires: '2027-01-01' }),
      n('project/odd-expiry.md', { type: 'project', expires: 'someday' }),
      n('project/active.md', { type: 'project', status: 'active' }),
      n('project/implicit.md', { type: 'project' }),
    ]
    const keys = section(generateIndex(notes, [], NOW).text, 'project').map(
      l => /\]\((.*?)\)/.exec(l)![1],
    )
    expect(keys.sort()).toEqual([
      'project/active.md',
      'project/expires-later.md',
      'project/expires-today.md',
      'project/implicit.md',
      'project/odd-expiry.md',
    ])
  })

  test('isExpired compares dates, not instants', () => {
    expect(isExpired('2026-11-04', NOW)).toBe(true)
    expect(isExpired('2026-11-05', NOW)).toBe(false)
    expect(isExpired('2026-11-04T23:59:59Z', NOW)).toBe(true)
    expect(isExpired(undefined, NOW)).toBe(false)
    expect(isExpired('', NOW)).toBe(false)
    expect(isExpired('next week', NOW)).toBe(false)
  })
})

describe('Pinned', () => {
  test('survives a regenerate verbatim, blank lines inside included', () => {
    const pinned = ['- always run the smoke test', '', '  indented note', 'See the runbook.']
    const { text } = generateIndex(filler(3), pinned, NOW)
    expect(parseIndex(text).pinned).toEqual(pinned)
    expect(parseIndex(text).generated).toBe(true)
    expect(parseIndex(text).legacyLines).toEqual([])
  })

  test('is cut to MAX_PINNED lines on both generation and parse', () => {
    const many = Array.from({ length: MAX_PINNED + 5 }, (_, i) => `pinned ${i}`)
    const { text } = generateIndex([], many, NOW)
    expect(section(text, 'Pinned')).toEqual(many.slice(0, MAX_PINNED))
    const handWritten = `${PINNED_HEADING}\n${many.join('\n')}\n`
    expect(parseIndex(handWritten).pinned).toEqual(many.slice(0, MAX_PINNED))
  })

  test('a pinned heading line cannot end its own section', () => {
    const pinned = ['## not a section', '# nor this', '### fine as is']
    const { text } = generateIndex(filler(2), pinned, NOW)
    const back = parseIndex(text).pinned
    expect(back).toEqual(['\\## not a section', '\\# nor this', '### fine as is'])
    // Stable from then on.
    expect(parseIndex(generateIndex(filler(2), back, NOW).text).pinned).toEqual(back)
  })
})

describe('caps', () => {
  test('line cap: exactly MAX_LINES with the tail, dropping the oldest round-robin', () => {
    const notes = [...filler(300, 'project'), ...filler(300, 'reference')]
    const out = generateIndex(notes, [], NOW)
    expect(out.lines).toBe(MAX_LINES)
    expect(out.text.split('\n')).toHaveLength(MAX_LINES)
    expect(out.bytes).toBeLessThanOrEqual(MAX_BYTES)
    expect(out.nearCap).toBe(true)
    const project = section(out.text, 'project')
    const reference = section(out.text, 'reference')
    const listed = project.length + reference.length
    expect(out.truncated).toBe(600 - listed)
    expect(out.text.split('\n').at(-1)).toBe(
      `… ${out.truncated} more entries not listed; memory_list shows every key`,
    )
    // Round-robin: the two groups lose entries evenly.
    expect(Math.abs(project.length - reference.length)).toBeLessThanOrEqual(1)
    // Oldest dropped: what remains in each group is its newest entries, still
    // newest first.
    const numbers = (lines: string[]) => lines.map(l => Number(/note-(\d+)/.exec(l)![1]))
    expect(numbers(project)).toEqual(Array.from({ length: project.length }, (_, i) => 299 - i))
    expect(numbers(reference)).toEqual(Array.from({ length: reference.length }, (_, i) => 299 - i))
  })

  test('byte cap: within one line of MAX_BYTES, with the tail', () => {
    // About 160 bytes a line (the description clips at 120), 180 of them:
    // roughly 29,000 bytes, over the byte cap while under the line cap.
    const notes = filler(180, 'project', 170)
    const out = generateIndex(notes, [], NOW)
    expect(out.lines).toBeLessThan(MAX_LINES)
    expect(out.bytes).toBeLessThanOrEqual(MAX_BYTES)
    expect(out.bytes).toBe(utf8Length(out.text))
    expect(out.truncated).toBeGreaterThan(0)
    const lineBytes = utf8Length(section(out.text, 'project')[0]) + 1
    expect(out.bytes + lineBytes).toBeGreaterThan(MAX_BYTES)
    expect(out.text).toContain(
      `… ${out.truncated} more entries not listed; memory_list shows every key`,
    )
    expect(out.nearCap).toBe(true)
  })

  test('bytes are UTF-8, not characters', () => {
    const notes = filler(120, 'project', 60).map(x => ({ ...x, description: 'é'.repeat(100) }))
    const out = generateIndex(notes, [], NOW)
    expect(out.bytes).toBe(utf8Length(out.text))
    expect(out.bytes).toBeGreaterThan(out.text.length)
    expect(out.bytes).toBeLessThanOrEqual(MAX_BYTES)
  })

  test('nearCap flips at NEAR_CAP_LINES and NEAR_CAP_BYTES exactly', () => {
    // Overhead with no pinned lines and one group: title, marker, blank,
    // Pinned, blank, heading = 6 lines.
    const atLines = generateIndex(filler(NEAR_CAP_LINES - 6), [], NOW)
    expect(atLines.lines).toBe(NEAR_CAP_LINES)
    expect(atLines.nearCap).toBe(true)
    const under = generateIndex(filler(NEAR_CAP_LINES - 7), [], NOW)
    expect(under.lines).toBe(NEAR_CAP_LINES - 1)
    expect(under.nearCap).toBe(false)

    // Grow one description until the byte count crosses the near-cap line.
    const base = filler(100, 'project', 100)
    const sizeWith = (extra: number) =>
      generateIndex(
        [...base, n('project/pad.md', { type: 'project', description: 'p'.repeat(extra) })],
        [],
        NOW,
      )
    const baseline = sizeWith(0).bytes
    expect(baseline).toBeLessThan(NEAR_CAP_BYTES)
    // The pad clips at 120 characters, so push with more notes instead.
    const padNotes = filler(Math.ceil((NEAR_CAP_BYTES - baseline) / 120) + 1, 'reference', 100)
    const over = generateIndex([...base, ...padNotes], [], NOW)
    expect(over.bytes).toBeGreaterThanOrEqual(NEAR_CAP_BYTES)
    expect(over.lines).toBeLessThan(NEAR_CAP_LINES)
    expect(over.nearCap).toBe(true)
  })
})

describe('parseIndex', () => {
  test('null or empty is nothing', () => {
    expect(parseIndex(null)).toEqual({ generated: false, pinned: [], legacyLines: [] })
    expect(parseIndex('')).toEqual({ generated: false, pinned: [], legacyLines: [] })
  })

  test('the fixture corpus index: every link line dropped, heading dropped, nothing left', () => {
    const parsed = parseIndex(CORPUS['MEMORY.md'])
    expect(parsed.generated).toBe(false)
    expect(parsed.pinned).toEqual([])
    const linkLines = CORPUS['MEMORY.md'].split('\n').filter(l => l.startsWith('- ['))
    expect(linkLines).toHaveLength(25)
    expect(parsed.legacyLines).toEqual([])
  })

  test('a hand-maintained index with prose keeps the prose as legacy, in order', () => {
    const text = [
      CORPUS['MEMORY.md'],
      '',
      'Always check the smoke run before a rollout.',
      '- project/release.md: how a version ships',
      '- project/ci.md — the three gates',
      '* [tone](feedback/tone.md)',
      '1. [prefs](user/prefs.md)',
      '- do not page the night shift for a paused site',
      '## Conventions',
      'Keys are lowercase.',
    ].join('\n')
    const parsed = parseIndex(text)
    expect(parsed.generated).toBe(false)
    expect(parsed.legacyLines).toEqual([
      'Always check the smoke run before a rollout.',
      '- do not page the night shift for a paused site',
      'Keys are lowercase.',
    ])
  })

  test('a hand-maintained index may already carry a Pinned section', () => {
    const text = [
      '# index',
      '- [deploy](project/deploy.md)',
      '## Pinned',
      'first',
      'second',
      '## Links',
      'prose after',
    ].join('\n')
    const parsed = parseIndex(text)
    expect(parsed.pinned).toEqual(['first', 'second'])
    expect(parsed.legacyLines).toEqual(['prose after'])
  })

  test('isLinkLine', () => {
    for (const l of [
      '- [deploy](project/deploy.md)',
      '  - [a](b)',
      '* [x](y.md) — desc',
      '1. [x](y)',
      '- project/deploy.md: how we deploy',
      '- project/deploy.md — how we deploy',
      '- feedback/testing: rules',
      '- notes.md',
      '[bare](link.md)',
    ])
      expect(`${l}: ${isLinkLine(l)}`).toBe(`${l}: true`)
    for (const l of [
      'Always check the smoke run.',
      '- do not page the night shift',
      '# index',
      '',
      '- see the runbook: it has the steps',
    ])
      expect(`${l}: ${isLinkLine(l)}`).toBe(`${l}: false`)
  })
})

describe('determinism', () => {
  test('same input, same bytes; input order does not matter', () => {
    const notes = [
      ...filler(50, 'project', 40),
      ...filler(50, 'feedback', 40),
      n('user/prefs.md', { type: 'user', description: 'numbers first', updated: '2026-02-02' }),
    ]
    const a = generateIndex(notes, ['pin'], NOW)
    const b = generateIndex(notes, ['pin'], NOW)
    expect(b.text).toBe(a.text)
    expect(b).toEqual(a)
    const shuffled = [...notes].reverse()
    expect(generateIndex(shuffled, ['pin'], NOW).text).toBe(a.text)
    // And over the cap, the same entries are dropped every time.
    const big = [...filler(400, 'project', 60), ...filler(400, 'reference', 60)]
    expect(generateIndex(big, [], NOW).text).toBe(generateIndex([...big].reverse(), [], NOW).text)
  })

  test('a regenerate from its own output parses back to the same pinned block', () => {
    const pinned = ['one', 'two']
    const first = generateIndex(filler(5), pinned, NOW)
    const again = generateIndex(filler(5), parseIndex(first.text).pinned, NOW)
    expect(again.text).toBe(first.text)
  })
})
