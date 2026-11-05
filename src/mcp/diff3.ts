/**
 * Line diff and three-way merge for concurrent edits of one memory note.
 *
 * Two sessions can save the same key: the second save gets a 409 from the
 * server because the note's hash moved. Instead of refusing, the tool layer
 * will reconcile the three texts it has — the note as this session last read
 * it (base), what this session is saving (ours) and what the other session
 * stored meanwhile (theirs) — and push the union when the edits do not touch
 * the same lines. This module is that reconciliation, with no dependencies.
 *
 * `diffLines(a, b)` is Myers' O(ND) algorithm in its linear-space form (middle
 * snake, divide and conquer), returning the changed regions as hunks
 * `{aStart, aEnd, bStart, bEnd}`: a[aStart, aEnd) is replaced by
 * b[bStart, bEnd). Hunks are sorted, non-overlapping and maximal, so two
 * adjacent changes are one hunk. Memory is O(N + M) however different the
 * inputs are.
 *
 * `merge3(base, ours, theirs)` rules:
 *   - Each side is diffed against base. Hunks that touch disjoint base ranges
 *     WITH at least one unchanged base line between them are unioned.
 *   - Hunks on both sides that produce the same text for a region are folded:
 *     the same change made twice is not a conflict.
 *   - A hunk adjacent to a hunk on the other side (no unchanged base line
 *     between them, which includes an insertion at the edge of the other
 *     side's change) is treated as overlapping and conflicts. Myers happily
 *     aligns unrelated identical lines, such as blank lines or a repeated
 *     `**Why:**`, so a one-line gap is not evidence the two edits are separate;
 *     a conflict is cheaper than a silently interleaved note.
 *   - Above 5,000 lines on any side the merge is refused with a single
 *     whole-file conflict, so a runaway note cannot pin the MCP process.
 *   - CRLF is normalized to LF for the diff; the output uses CRLF only when
 *     every input that has a line break uses CRLF exclusively.
 *   - The trailing newline is merged like a line: ours wins when ours changed
 *     it, theirs when theirs changed it, otherwise base. An empty text has no
 *     lines.
 *   - `theirsLines` counts the output lines contributed by the other side's
 *     hunks; folded regions and deletions contribute nothing.
 *
 * On conflict, `text` renders only the conflicting hunks, each as
 * `<<<<<<< yours` / `||||||| base` / `=======` / `>>>>>>> current` with the base
 * lines shown, hunks separated by a blank line. `conflicts` carries the same
 * hunks as data (`baseStart`/`baseEnd` are 0-based, end-exclusive line
 * indexes into base).
 */

export type DiffHunk = { aStart: number; aEnd: number; bStart: number; bEnd: number }

export type Hunk = { baseStart: number; baseEnd: number; ours: string[]; theirs: string[] }

export type MergeResult =
  | { ok: true; text: string; theirsLines: number }
  | { ok: false; conflicts: Hunk[]; text: string }

export const MAX_MERGE_LINES = 5000

// ---------------------------------------------------------------------------
// Myers diff (linear space)
// ---------------------------------------------------------------------------

/** Changed regions between `a` and `b`; empty when they are equal. */
export function diffLines(a: string[], b: string[]): DiffHunk[] {
  const raw: DiffHunk[] = []
  walk(a, b, 0, a.length, 0, b.length, raw)
  const out: DiffHunk[] = []
  for (const h of raw) {
    const last = out[out.length - 1]
    if (last && last.aEnd === h.aStart && last.bEnd === h.bStart) {
      last.aEnd = h.aEnd
      last.bEnd = h.bEnd
    } else out.push({ ...h })
  }
  return out
}

function walk(
  a: string[],
  b: string[],
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
  out: DiffHunk[],
): void {
  let a0 = aStart
  let b0 = bStart
  let a1 = aEnd
  let b1 = bEnd
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) {
    a0++
    b0++
  }
  while (a1 > a0 && b1 > b0 && a[a1 - 1] === b[b1 - 1]) {
    a1--
    b1--
  }
  if (a0 === a1 && b0 === b1) return
  if (a0 === a1 || b0 === b1) {
    out.push({ aStart: a0, aEnd: a1, bStart: b0, bEnd: b1 })
    return
  }
  const snake = middleSnake(a, b, a0, a1, b0, b1)
  walk(a, b, a0, snake.aFrom, b0, snake.bFrom, out)
  walk(a, b, snake.aTo, a1, snake.bTo, b1, out)
}

type Snake = { aFrom: number; bFrom: number; aTo: number; bTo: number }

/**
 * Find a middle snake of the shortest edit path between a[a0, a1) and
 * b[b0, b1), after the common prefix and suffix are gone and neither range is
 * empty. Forward and reverse searches meet in the middle; the first overlap
 * found is on a shortest path, and the snake it ends with splits the problem
 * into two strictly smaller ones.
 */
function middleSnake(
  a: string[],
  b: string[],
  a0: number,
  a1: number,
  b0: number,
  b1: number,
): Snake {
  const n = a1 - a0
  const m = b1 - b0
  const max = Math.ceil((n + m) / 2) + 1
  const delta = n - m
  const odd = (delta & 1) !== 0
  const off = max + 1
  // vf[k + off]: furthest x reached on forward diagonal k (x - y = k).
  // vb[k + off]: furthest x' reached on reverse diagonal k' (in reversed
  // coordinates x' = n - x, y' = m - y, k' = x' - y'). Forward diagonal k meets
  // reverse diagonal k' = delta - k.
  const vf = new Int32Array(2 * off + 1).fill(-1)
  const vb = new Int32Array(2 * off + 1).fill(-1)
  vf[off + 1] = 0
  vb[off + 1] = 0
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && vf[off + k - 1] < vf[off + k + 1])) x = vf[off + k + 1]
      else x = vf[off + k - 1] + 1
      let y = x - k
      const xs = x
      const ys = y
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x++
        y++
      }
      vf[off + k] = x
      if (odd) {
        const kr = delta - k
        if (kr >= -(d - 1) && kr <= d - 1 && vb[off + kr] >= 0 && x + vb[off + kr] >= n) {
          return { aFrom: a0 + xs, bFrom: b0 + ys, aTo: a0 + x, bTo: b0 + y }
        }
      }
    }
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && vb[off + k - 1] < vb[off + k + 1])) x = vb[off + k + 1]
      else x = vb[off + k - 1] + 1
      let y = x - k
      const xs = x
      const ys = y
      while (x < n && y < m && a[a1 - 1 - x] === b[b1 - 1 - y]) {
        x++
        y++
      }
      vb[off + k] = x
      if (!odd) {
        const kf = delta - k
        if (kf >= -d && kf <= d && vf[off + kf] >= 0 && vf[off + kf] + x >= n) {
          // The reverse snake runs from (n - x, m - y) to (n - xs, m - ys).
          return { aFrom: a1 - x, bFrom: b1 - y, aTo: a1 - xs, bTo: b1 - ys }
        }
      }
    }
  }
  // Unreachable: a shortest path always exists within `max` steps.
  throw new Error('diffLines: no middle snake found')
}

// ---------------------------------------------------------------------------
// Three-way merge
// ---------------------------------------------------------------------------

type SideHunk = { baseStart: number; baseEnd: number; lines: string[] }

type Split = { lines: string[]; trailingNewline: boolean; crlf: boolean; hasBreak: boolean }

function split(text: string): Split {
  const hasBreak = text.includes('\n')
  const crlf = hasBreak && !/(^|[^\r])\n/.test(text)
  const lf = text.replace(/\r\n/g, '\n')
  const trailingNewline = lf.endsWith('\n')
  const body = trailingNewline ? lf.slice(0, -1) : lf
  const lines = body === '' && !trailingNewline ? [] : body.split('\n')
  return { lines, trailingNewline, crlf, hasBreak }
}

function sideHunks(base: string[], side: string[]): SideHunk[] {
  return diffLines(base, side).map(h => ({
    baseStart: h.aStart,
    baseEnd: h.aEnd,
    lines: side.slice(h.bStart, h.bEnd),
  }))
}

/** A side's version of base[start, end) given its hunks inside that range. */
function render(base: string[], hunks: SideHunk[], start: number, end: number): string[] {
  const out: string[] = []
  let pos = start
  for (const h of hunks) {
    for (let i = pos; i < h.baseStart; i++) out.push(base[i])
    out.push(...h.lines)
    pos = h.baseEnd
  }
  for (let i = pos; i < end; i++) out.push(base[i])
  return out
}

function sameLines(x: string[], y: string[]): boolean {
  return x.length === y.length && x.every((l, i) => l === y[i])
}

/** Merge `ours` and `theirs`, both derived from `base`. See the header. */
export function merge3(base: string, ours: string, theirs: string): MergeResult {
  const b = split(base)
  const o = split(ours)
  const t = split(theirs)
  const crlf =
    (b.crlf || !b.hasBreak) &&
    (o.crlf || !o.hasBreak) &&
    (t.crlf || !t.hasBreak) &&
    (b.hasBreak || o.hasBreak || t.hasBreak)
  const eol = crlf ? '\r\n' : '\n'
  const trailing = o.trailingNewline !== b.trailingNewline ? o.trailingNewline : t.trailingNewline
  const join = (lines: string[], nl: boolean) =>
    lines.length === 0 && !nl ? '' : lines.join(eol) + (nl ? eol : '')

  const tooBig = Math.max(b.lines.length, o.lines.length, t.lines.length) > MAX_MERGE_LINES
  if (tooBig) {
    const whole: Hunk = { baseStart: 0, baseEnd: b.lines.length, ours: o.lines, theirs: t.lines }
    return { ok: false, conflicts: [whole], text: renderConflicts(b.lines, [whole], eol) }
  }

  const oh = sideHunks(b.lines, o.lines)
  const th = sideHunks(b.lines, t.lines)
  const merged: string[] = []
  const conflicts: Hunk[] = []
  let theirsLines = 0
  let pos = 0
  let i = 0
  let j = 0
  while (i < oh.length || j < th.length) {
    // Start a region with whichever side's next hunk comes first, then grow it
    // while the other side has a hunk that overlaps or touches it.
    const fromOurs = j >= th.length || (i < oh.length && oh[i].baseStart <= th[j].baseStart)
    const first = fromOurs ? oh[i] : th[j]
    let start = first.baseStart
    let end = first.baseEnd
    const ro: SideHunk[] = []
    const rt: SideHunk[] = []
    let grew = true
    while (grew) {
      grew = false
      while (i < oh.length && oh[i].baseStart <= end) {
        ro.push(oh[i])
        start = Math.min(start, oh[i].baseStart)
        end = Math.max(end, oh[i].baseEnd)
        i++
        grew = true
      }
      while (j < th.length && th[j].baseStart <= end) {
        rt.push(th[j])
        start = Math.min(start, th[j].baseStart)
        end = Math.max(end, th[j].baseEnd)
        j++
        grew = true
      }
    }
    for (let k = pos; k < start; k++) merged.push(b.lines[k])
    const oursText = render(b.lines, ro, start, end)
    const theirsText = render(b.lines, rt, start, end)
    if (rt.length === 0) merged.push(...oursText)
    else if (ro.length === 0) {
      merged.push(...theirsText)
      for (const h of rt) theirsLines += h.lines.length
    } else if (sameLines(oursText, theirsText)) merged.push(...oursText)
    else conflicts.push({ baseStart: start, baseEnd: end, ours: oursText, theirs: theirsText })
    pos = end
  }
  for (let k = pos; k < b.lines.length; k++) merged.push(b.lines[k])

  if (conflicts.length > 0) {
    return { ok: false, conflicts, text: renderConflicts(b.lines, conflicts, eol) }
  }
  return { ok: true, text: join(merged, trailing), theirsLines }
}

function renderConflicts(base: string[], hunks: Hunk[], eol: string): string {
  const blocks = hunks.map(h =>
    [
      '<<<<<<< yours',
      ...h.ours,
      '||||||| base',
      ...base.slice(h.baseStart, h.baseEnd),
      '=======',
      ...h.theirs,
      '>>>>>>> current',
    ].join(eol),
  )
  return blocks.join(eol + eol) + eol
}
