/**
 * Myers line diff and three-way merge (`src/mcp/diff3.ts`). The diff is
 * checked against known cases and against a textbook LCS table on random
 * inputs; the merge pins each rule in the module header: union, folding,
 * overlap and adjacency conflicts, the line cap, line endings and the
 * trailing newline.
 */

import { describe, expect, test } from 'bun:test'
import { type DiffHunk, diffLines, MAX_MERGE_LINES, merge3 } from '../src/mcp/diff3.ts'

/** Apply hunks to `a`; must reproduce `b` for any correct diff. */
function patch(a: string[], hunks: DiffHunk[], b: string[]): string[] {
  const out: string[] = []
  let pos = 0
  for (const h of hunks) {
    out.push(...a.slice(pos, h.aStart))
    out.push(...b.slice(h.bStart, h.bEnd))
    pos = h.aEnd
  }
  out.push(...a.slice(pos))
  return out
}

function editCount(hunks: DiffHunk[]): number {
  return hunks.reduce((n, h) => n + (h.aEnd - h.aStart) + (h.bEnd - h.bStart), 0)
}

/** Textbook O(NM) LCS length, the oracle for minimality. */
function lcs(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp[a.length][b.length]
}

function wellFormed(hunks: DiffHunk[]): void {
  let a = -1
  let b = -1
  for (const h of hunks) {
    expect(h.aStart).toBeLessThanOrEqual(h.aEnd)
    expect(h.bStart).toBeLessThanOrEqual(h.bEnd)
    expect(h.aEnd - h.aStart + (h.bEnd - h.bStart)).toBeGreaterThan(0)
    // Sorted, non-overlapping and never adjacent (adjacent changes coalesce).
    expect(h.aStart).toBeGreaterThan(a)
    expect(h.bStart).toBeGreaterThan(b)
    a = h.aEnd
    b = h.bEnd
  }
}

/** Small deterministic PRNG so the random cases are reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

describe('diffLines', () => {
  test("the paper's example: ABCABBA -> CBABAC is a 5-edit script", () => {
    const a = [...'ABCABBA']
    const b = [...'CBABAC']
    const hunks = diffLines(a, b)
    wellFormed(hunks)
    expect(editCount(hunks)).toBe(5)
    expect(patch(a, hunks, b)).toEqual(b)
  })

  test('small known cases', () => {
    expect(diffLines([], [])).toEqual([])
    expect(diffLines(['a'], ['a'])).toEqual([])
    expect(diffLines([], ['a', 'b'])).toEqual([{ aStart: 0, aEnd: 0, bStart: 0, bEnd: 2 }])
    expect(diffLines(['a', 'b'], [])).toEqual([{ aStart: 0, aEnd: 2, bStart: 0, bEnd: 0 }])
    expect(diffLines(['a', 'b', 'c'], ['a', 'X', 'c'])).toEqual([
      { aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 },
    ])
    expect(diffLines(['a', 'b', 'c'], ['a', 'c'])).toEqual([
      { aStart: 1, aEnd: 2, bStart: 1, bEnd: 1 },
    ])
    expect(diffLines(['a', 'c'], ['a', 'b', 'c'])).toEqual([
      { aStart: 1, aEnd: 1, bStart: 1, bEnd: 2 },
    ])
    expect(diffLines(['a', 'b', 'c', 'd'], ['X', 'b', 'c', 'Y'])).toEqual([
      { aStart: 0, aEnd: 1, bStart: 0, bEnd: 1 },
      { aStart: 3, aEnd: 4, bStart: 3, bEnd: 4 },
    ])
    expect(editCount(diffLines(['a', 'b'], ['b', 'a']))).toBe(2)
    expect(diffLines(['x'], ['y'])).toEqual([{ aStart: 0, aEnd: 1, bStart: 0, bEnd: 1 }])
  })

  test('a replaced middle, a repeated line, and a shift all stay minimal', () => {
    const cases: Array<[string[], string[]]> = [
      [[...'AAAA'], [...'AA']],
      [[...'AB'], [...'BA']],
      [[...'ABCDEF'], [...'AXCYEZ']],
      [[...'MZJAWXU'], [...'XMJYAUZ']],
      [[...'ABBBBA'], [...'BBBB']],
      [
        ['', 'a', '', 'b', ''],
        ['', 'b', '', 'a', ''],
      ],
    ]
    for (const [a, b] of cases) {
      const hunks = diffLines(a, b)
      wellFormed(hunks)
      expect(patch(a, hunks, b)).toEqual(b)
      expect(editCount(hunks)).toBe(a.length + b.length - 2 * lcs(a, b))
    }
  })

  test('matches the LCS oracle on 400 random inputs', () => {
    const next = rng(20261105)
    for (let round = 0; round < 400; round++) {
      const alphabet = 2 + Math.floor(next() * 4)
      const gen = (len: number) =>
        Array.from({ length: len }, () => String.fromCharCode(97 + Math.floor(next() * alphabet)))
      const a = gen(Math.floor(next() * 14))
      const b = next() < 0.3 ? [...a] : gen(Math.floor(next() * 14))
      if (next() < 0.3 && a.length > 2) b.splice(1, 1, 'q')
      const hunks = diffLines(a, b)
      wellFormed(hunks)
      expect(patch(a, hunks, b)).toEqual(b)
      expect(editCount(hunks)).toBe(a.length + b.length - 2 * lcs(a, b))
    }
  })

  test('stays fast and minimal on large, mostly different inputs', () => {
    const next = rng(7)
    const a = Array.from({ length: 2000 }, (_, i) => (next() < 0.5 ? `same ${i}` : `a ${i}`))
    const b = Array.from({ length: 2000 }, (_, i) => (next() < 0.5 ? `same ${i}` : `b ${i}`))
    const t0 = performance.now()
    const hunks = diffLines(a, b)
    expect(performance.now() - t0).toBeLessThan(2000)
    wellFormed(hunks)
    expect(patch(a, hunks, b)).toEqual(b)
  })
})

const note = [
  '---',
  'name: deploy',
  'description: how we deploy Quillrun',
  '---',
  '# deploy',
  '',
  'We deploy Quillrun to the Ashfield cluster from the release branch.',
  'The smoke run must be green before a rollout; a red run stops it.',
  '',
  '**Why:** a red smoke run has shipped broken dispatchers before.',
  '',
].join('\n')

function lines(s: string): string[] {
  return s.split('\n')
}

function withLine(s: string, index: number, line: string): string {
  const l = lines(s)
  l[index] = line
  return l.join('\n')
}

describe('merge3', () => {
  test('nothing changed on either side', () => {
    expect(merge3(note, note, note)).toEqual({ ok: true, text: note, theirsLines: 0 })
  })

  test('one side unchanged takes the other side whole', () => {
    const ours = withLine(note, 6, 'We deploy from main now.')
    expect(merge3(note, ours, note)).toEqual({ ok: true, text: ours, theirsLines: 0 })
    const r = merge3(note, note, ours)
    expect(r).toEqual({ ok: true, text: ours, theirsLines: 1 })
  })

  test('edits on different lines with an unchanged line between union cleanly', () => {
    const ours = withLine(note, 4, '# deploy (Ashfield)')
    const theirs = withLine(note, 7, 'The smoke run must be green; a red run stops the rollout.')
    const r = merge3(note, ours, theirs)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.theirsLines).toBe(1)
    expect(lines(r.text)[4]).toBe('# deploy (Ashfield)')
    expect(lines(r.text)[7]).toBe('The smoke run must be green; a red run stops the rollout.')
    expect(lines(r.text)).toHaveLength(lines(note).length)
  })

  test('frontmatter-plus-body note: one side edits a body line, the other appends', () => {
    const ours = withLine(note, 6, 'We deploy Quillrun to the Ashfield cluster from main.')
    const theirs = `${note}Rollbacks go through the same smoke gate.\n`
    const r = merge3(note, ours, theirs)
    expect(r).toEqual({
      ok: true,
      text: `${ours}Rollbacks go through the same smoke gate.\n`,
      theirsLines: 1,
    })
    // And the mirror image, with theirs editing and ours appending.
    const r2 = merge3(note, theirs, ours)
    expect(r2).toEqual({ ok: true, text: r.text, theirsLines: 1 })
  })

  test('counts every line the other side contributed', () => {
    const theirs = `${note}one\ntwo\nthree\n`
    const ours = withLine(note, 4, '# deploy!')
    const r = merge3(note, ours, theirs)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.theirsLines).toBe(3)
  })

  test('identical changes on both sides fold into one', () => {
    const same = withLine(note, 6, 'We deploy from main.')
    expect(merge3(note, same, same)).toEqual({ ok: true, text: same, theirsLines: 0 })
    const theirs = withLine(same, 9, '**Why:** it shipped a broken dispatcher once.')
    const r = merge3(note, same, theirs)
    expect(r).toEqual({ ok: true, text: theirs, theirsLines: 1 })
  })

  test('overlapping edits of the same line conflict and render only that hunk', () => {
    const ours = withLine(note, 6, 'We deploy from main.')
    const theirs = withLine(note, 6, 'We deploy from the release branch, by hand.')
    const r = merge3(note, ours, theirs)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.conflicts).toEqual([
      {
        baseStart: 6,
        baseEnd: 7,
        ours: ['We deploy from main.'],
        theirs: ['We deploy from the release branch, by hand.'],
      },
    ])
    expect(r.text).toBe(
      [
        '<<<<<<< yours',
        'We deploy from main.',
        '||||||| base',
        'We deploy Quillrun to the Ashfield cluster from the release branch.',
        '=======',
        'We deploy from the release branch, by hand.',
        '>>>>>>> current',
        '',
      ].join('\n'),
    )
    expect(r.text).not.toContain('smoke run')
  })

  test('deleting a line one side edited conflicts', () => {
    const l = lines(note)
    l.splice(7, 1)
    const ours = l.join('\n')
    const theirs = withLine(note, 7, 'The smoke run must be green; red stops it.')
    const r = merge3(note, ours, theirs)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0]).toMatchObject({ baseStart: 7, baseEnd: 8, ours: [] })
    expect(r.text).toContain('<<<<<<< yours\n||||||| base\n')
  })

  test('adjacent hunks with no unchanged line between conflict', () => {
    const ours = withLine(note, 6, 'edited six')
    const theirs = withLine(note, 7, 'edited seven')
    const r = merge3(note, ours, theirs)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.conflicts).toEqual([
      {
        baseStart: 6,
        baseEnd: 8,
        ours: ['edited six', 'The smoke run must be green before a rollout; a red run stops it.'],
        theirs: [
          'We deploy Quillrun to the Ashfield cluster from the release branch.',
          'edited seven',
        ],
      },
    ])
  })

  test('an insertion touching the other side’s edit conflicts', () => {
    const l = lines(note)
    l.splice(7, 0, 'inserted before the smoke line')
    const ours = l.join('\n')
    const theirs = withLine(note, 7, 'edited smoke line')
    expect(merge3(note, ours, theirs).ok).toBe(false)
    const theirs2 = withLine(note, 6, 'edited deploy line')
    expect(merge3(note, ours, theirs2).ok).toBe(false)
    // Two different appends at the same spot conflict too.
    expect(merge3(note, `${note}a\n`, `${note}b\n`).ok).toBe(false)
    // One line of distance is enough.
    const theirs3 = withLine(note, 4, '# deploy!')
    expect(merge3(note, ours, theirs3).ok).toBe(true)
  })

  test('two conflicts render as two blocks, in order', () => {
    const ours = withLine(withLine(note, 4, 'ours 4'), 9, 'ours 9')
    const theirs = withLine(withLine(note, 4, 'theirs 4'), 9, 'theirs 9')
    const r = merge3(note, ours, theirs)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.conflicts.map(h => [h.baseStart, h.baseEnd])).toEqual([
      [4, 5],
      [9, 10],
    ])
    expect(r.text.split('<<<<<<< yours')).toHaveLength(3)
    expect(r.text).toContain('>>>>>>> current\n\n<<<<<<< yours')
  })

  test('refuses more than the line cap with one whole-file conflict', () => {
    const big = Array.from({ length: MAX_MERGE_LINES + 1 }, (_, i) => `line ${i}`).join('\n')
    const r = merge3(big, big, `${big}\nmore`)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0].baseStart).toBe(0)
    expect(r.conflicts[0].baseEnd).toBe(MAX_MERGE_LINES + 1)
    expect(r.text.startsWith('<<<<<<< yours\nline 0\n')).toBe(true)
    const atCap = Array.from({ length: MAX_MERGE_LINES }, (_, i) => `line ${i}`).join('\n')
    expect(merge3(atCap, atCap, atCap.replace('line 1\n', 'LINE 1\n')).ok).toBe(true)
  })

  test('CRLF input merges and comes back as CRLF when every side uses it', () => {
    const base = 'a\r\nb\r\nc\r\n'
    const ours = 'A\r\nb\r\nc\r\n'
    const theirs = 'a\r\nb\r\nC\r\n'
    expect(merge3(base, ours, theirs)).toEqual({
      ok: true,
      text: 'A\r\nb\r\nC\r\n',
      theirsLines: 1,
    })
    const conflict = merge3(base, 'X\r\nb\r\nc\r\n', 'Y\r\nb\r\nc\r\n')
    expect(conflict.ok).toBe(false)
    if (!conflict.ok)
      expect(conflict.text).toBe(
        '<<<<<<< yours\r\nX\r\n||||||| base\r\na\r\n=======\r\nY\r\n>>>>>>> current\r\n',
      )
  })

  test('mixed line endings normalize to LF', () => {
    const r = merge3('a\r\nb\r\nc\r\n', 'A\nb\nc\n', 'a\r\nb\r\nC\r\n')
    expect(r).toEqual({ ok: true, text: 'A\nb\nC\n', theirsLines: 1 })
  })

  test('trailing newline follows whichever side changed it', () => {
    expect(merge3('a\nb\n', 'a\nb', 'a\nb\n')).toEqual({ ok: true, text: 'a\nb', theirsLines: 0 })
    expect(merge3('a\nb\n', 'a\nb\n', 'a\nb')).toEqual({ ok: true, text: 'a\nb', theirsLines: 0 })
    expect(merge3('a\nb', 'A\nb', 'a\nb\n')).toEqual({ ok: true, text: 'A\nb\n', theirsLines: 0 })
    expect(merge3('a\nb\n', 'a\nb\n', 'a\nb\n')).toEqual({
      ok: true,
      text: 'a\nb\n',
      theirsLines: 0,
    })
    expect(merge3('', '', 'x\n')).toEqual({ ok: true, text: 'x\n', theirsLines: 1 })
    expect(merge3('', 'x', '')).toEqual({ ok: true, text: 'x', theirsLines: 0 })
    expect(merge3('\n', '\n', '\n')).toEqual({ ok: true, text: '\n', theirsLines: 0 })
  })

  test('does not stitch unrelated edits across a blank line that Myers aligned', () => {
    // Both sides rewrite a paragraph around the same blank line; the blank is
    // the only "unchanged" line between them, so adjacency makes it a
    // conflict rather than an interleaved paragraph.
    const base = 'one\ntwo\n\nthree\nfour\n'
    const ours = 'uno\ndos\n\nthree\nfour\n'
    const theirs = 'one\ntwo\n\ntres\ncuatro\n'
    // These are separated by the blank line, which is unchanged: a clean union.
    expect(merge3(base, ours, theirs)).toEqual({
      ok: true,
      text: 'uno\ndos\n\ntres\ncuatro\n',
      theirsLines: 2,
    })
    // Remove the gap and the same shape conflicts.
    const base2 = 'one\ntwo\nthree\nfour\n'
    expect(merge3(base2, 'uno\ndos\nthree\nfour\n', 'one\ntwo\ntres\ncuatro\n').ok).toBe(false)
  })
})
