/**
 * Reserved keys and key normalization (`src/mcp/keys.ts`).
 *
 * The one property that matters most is pinned mechanically: every key this
 * module produces is a key the server accepts, including at the 255-character
 * limit, and the limit here is the same one `validateEntryKey` enforces.
 */

import { describe, expect, test } from 'bun:test'
import {
  ACCESSED_KEY,
  accessedKey,
  HISTORY_PREFIX,
  historyKey,
  isHiddenKey,
  isIndexKey,
  isSystemKey,
  MAX_KEY_LENGTH,
  normalizeKey,
  SYSTEM_PREFIX,
  TRASH_PREFIX,
  trashKey,
} from '../src/mcp/keys.ts'
import { InvalidNameError, validateEntryKey } from '../src/namespace.ts'

describe('reserved prefix', () => {
  test('is a path segment the server accepts, where a dot-prefix is not', () => {
    expect(SYSTEM_PREFIX).toBe('sys.openrecall/')
    expect(validateEntryKey(`${SYSTEM_PREFIX}accessed.json`)).toBe('sys.openrecall/accessed.json')
    // The reason the prefix is not `.history/`: a key must start alphanumeric.
    expect(() => validateEntryKey('.history/x.json')).toThrow(InvalidNameError)
  })

  test('isSystemKey matches the segment, not the bare prefix text', () => {
    expect(isSystemKey('sys.openrecall/trash/feedback/testing.md')).toBe(true)
    expect(isSystemKey('sys.openrecall/accessed.json')).toBe(true)
    expect(isSystemKey('sys.openrecall-notes.md')).toBe(false)
    expect(isSystemKey('project/sys.openrecall/x.md')).toBe(false)
    expect(isSystemKey('feedback/testing.md')).toBe(false)
  })

  test('isIndexKey is the root index or any subtree index, case-sensitive', () => {
    expect(isIndexKey('MEMORY.md')).toBe(true)
    expect(isIndexKey('project/MEMORY.md')).toBe(true)
    expect(isIndexKey('a/b/MEMORY.md')).toBe(true)
    expect(isIndexKey('memory.md')).toBe(false)
    expect(isIndexKey('project/notMEMORY.md')).toBe(false)
    expect(isIndexKey('MEMORY.md.bak')).toBe(false)
  })

  test('isHiddenKey is system or index', () => {
    expect(isHiddenKey('MEMORY.md')).toBe(true)
    expect(isHiddenKey('sys.openrecall/history/x.md.json')).toBe(true)
    expect(isHiddenKey('feedback/testing.md')).toBe(false)
    expect(isHiddenKey('user/prefs.md')).toBe(false)
  })
})

describe('normalizeKey', () => {
  test('table of equivalences', () => {
    const cases: [string, string][] = [
      ['feedback/testing.md', 'feedback/testing'],
      ['feedback/testing', 'feedback/testing'],
      ['Feedback/Testing.MD', 'feedback/testing'],
      ['feedback/Testing_Notes.md', 'feedback/testing-notes'],
      ['feedback/testing  notes.md', 'feedback/testing-notes'],
      ['feedback/testing--notes.md', 'feedback/testing-notes'],
      ['feedback/-testing-.md', 'feedback/testing'],
      ['-feedback-/testing.md', 'feedback/testing'],
      ['feedback/_ testing _.md', 'feedback/testing'],
      // NFKC: the fi ligature and a fullwidth letter fold to ASCII.
      ['reference/ﬁle.md', 'reference/file'],
      ['reference/Ａpi.md', 'reference/api'],
      // Only a trailing .md is stripped, and only once.
      ['notes.md.md', 'notes.md'],
      ['readme.markdown', 'readme.markdown'],
      ['MEMORY.md', 'memory'],
    ]
    for (const [input, expected] of cases)
      expect(`${input} -> ${normalizeKey(input)}`).toBe(`${input} -> ${expected}`)
  })

  test('is idempotent', () => {
    for (const k of ['Feedback/Testing_Notes.md', 'a/--b--/C.MD', 'reference/ﬁle.md'])
      expect(normalizeKey(normalizeKey(k))).toBe(normalizeKey(k))
  })

  test('distinct keys stay distinct', () => {
    expect(normalizeKey('feedback/testing.md')).not.toBe(normalizeKey('feedback/tests.md'))
    expect(normalizeKey('feedback/testing.md')).not.toBe(normalizeKey('project/testing.md'))
  })
})

describe('derived keys', () => {
  test('trash, history and accessed have the documented shapes', () => {
    expect(trashKey('feedback/testing.md')).toBe('sys.openrecall/trash/feedback/testing.md')
    expect(historyKey('feedback/testing.md')).toBe(
      'sys.openrecall/history/feedback/testing.md.json',
    )
    expect(accessedKey()).toBe('sys.openrecall/accessed.json')
    expect(accessedKey()).toBe(ACCESSED_KEY)
    expect(TRASH_PREFIX).toBe('sys.openrecall/trash/')
    expect(HISTORY_PREFIX).toBe('sys.openrecall/history/')
  })

  test('the length limit is the one validateEntryKey enforces', () => {
    expect(MAX_KEY_LENGTH).toBe(255)
    const atLimit = `a${'b'.repeat(MAX_KEY_LENGTH - 1)}`
    expect(validateEntryKey(atLimit)).toBe(atLimit)
    expect(() => validateEntryKey(`${atLimit}c`)).toThrow(InvalidNameError)
  })

  test('return null exactly when the derived key would exceed the limit', () => {
    const fits = (n: number) => `k${'x'.repeat(n - 1)}`
    // Longest key that still fits under each prefix, and one character more.
    const trashMax = MAX_KEY_LENGTH - TRASH_PREFIX.length
    expect(trashKey(fits(trashMax))).toHaveLength(MAX_KEY_LENGTH)
    expect(trashKey(fits(trashMax + 1))).toBeNull()

    const historyMax = MAX_KEY_LENGTH - HISTORY_PREFIX.length - '.json'.length
    expect(historyKey(fits(historyMax))).toHaveLength(MAX_KEY_LENGTH)
    expect(historyKey(fits(historyMax + 1))).toBeNull()

    // A key at the server's own limit can be stored but never parked or versioned.
    const atLimit = fits(MAX_KEY_LENGTH)
    expect(validateEntryKey(atLimit)).toBe(atLimit)
    expect(trashKey(atLimit)).toBeNull()
    expect(historyKey(atLimit)).toBeNull()
  })

  test('every produced key passes validateEntryKey', () => {
    const inputs = [
      'MEMORY.md',
      'feedback/testing.md',
      'project/deploy.md',
      'a/b/c.md',
      'notes-2026_11.md',
      `k${'x'.repeat(MAX_KEY_LENGTH - TRASH_PREFIX.length - 1)}`,
      `k${'x'.repeat(MAX_KEY_LENGTH - HISTORY_PREFIX.length - '.json'.length - 1)}`,
    ]
    const produced: string[] = [accessedKey()]
    for (const k of inputs) {
      for (const d of [trashKey(k), historyKey(k)]) if (d !== null) produced.push(d)
    }
    expect(produced.length).toBeGreaterThan(inputs.length)
    for (const k of produced) expect(validateEntryKey(k)).toBe(k)
    // And every one of them is hidden, so no enumeration of notes shows it.
    for (const k of produced) expect(isHiddenKey(k)).toBe(true)
  })
})
