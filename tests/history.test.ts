/**
 * Version history (`src/mcp/history.ts`): parse tolerance, the cap and its
 * newest-first order, the unchanged and too-large skips, the byte guard,
 * `readVersion` indexing, the serialize/parse round trip, and every reason
 * `historyAllowed` can give.
 */

import { describe, expect, test } from 'bun:test'
import {
  appendVersion,
  emptyHistory,
  HISTORY_CAP,
  HISTORY_ENV,
  HISTORY_MAX_BYTES,
  HISTORY_MAX_CONTENT,
  HISTORY_STOP_ENTRIES,
  HISTORY_WARN_ENTRIES,
  type HistoryFile,
  type HistoryVersion,
  historyAllowed,
  parseHistory,
  readVersion,
  serializeHistory,
} from '../src/mcp/history.ts'
import { historyKey, MAX_KEY_LENGTH } from '../src/mcp/keys.ts'
import { utf8Length } from '../src/mcp/memindex.ts'

const KEY = 'project/deploy.md'

const v = (n: number, extra: Partial<HistoryVersion> = {}): HistoryVersion => ({
  updated: `2026-11-${String(n).padStart(2, '0')}T00:00:00Z`,
  content: `version ${n}`,
  ...extra,
})

/** Versions 1..n appended in order, so version n is the newest. */
function filled(n: number): HistoryFile {
  let file = emptyHistory(KEY)
  for (let i = 1; i <= n; i++) file = appendVersion(file, v(i)).file
  return file
}

describe('parseHistory', () => {
  test('null, empty and malformed text all parse as an empty file for the key', () => {
    for (const text of [null, '', 'not json', '[]', '42', '{"v":1}', '{"v":1,"key":"x"}']) {
      expect(parseHistory(text, KEY)).toEqual({ v: 1, key: KEY, versions: [] })
    }
  })

  test('a wrong version, another note’s key or a non-array versions field is empty', () => {
    const base: HistoryFile = { v: 1, key: KEY, versions: [v(1)] }
    expect(parseHistory(JSON.stringify({ ...base, v: 2 }), KEY).versions).toEqual([])
    expect(
      parseHistory(JSON.stringify({ ...base, key: 'project/other.md' }), KEY).versions,
    ).toEqual([])
    expect(parseHistory(JSON.stringify({ ...base, versions: {} }), KEY).versions).toEqual([])
    expect(parseHistory(JSON.stringify(base), KEY)).toEqual(base)
  })

  test('a malformed version entry is dropped; the well-formed ones are kept in order', () => {
    const doc = {
      v: 1,
      key: KEY,
      versions: [
        v(3),
        { updated: 'x' }, // no content
        { content: 'y' }, // no updated
        { updated: 1, content: 'z' }, // wrong type
        'junk',
        null,
        v(2),
      ],
    }
    expect(parseHistory(JSON.stringify(doc), KEY).versions).toEqual([v(3), v(2)])
  })

  test('optional fields survive when they are strings and are dropped when they are not', () => {
    const good = v(1, { agent: 'claude-code/2.1', session: 's1', hash: 'sha256:ab' })
    const bad = { ...v(2), agent: 7, session: null, hash: ['x'] }
    const parsed = parseHistory(JSON.stringify({ v: 1, key: KEY, versions: [good, bad] }), KEY)
    expect(parsed.versions[0]).toEqual(good)
    expect(parsed.versions[1]).toEqual(v(2))
  })

  test('more than HISTORY_CAP stored versions are trimmed from the end', () => {
    const versions = Array.from({ length: HISTORY_CAP + 3 }, (_, i) => v(i + 1))
    const parsed = parseHistory(JSON.stringify({ v: 1, key: KEY, versions }), KEY)
    expect(parsed.versions).toEqual(versions.slice(0, HISTORY_CAP))
  })
})

describe('appendVersion', () => {
  test('keeps the newest first and at most HISTORY_CAP', () => {
    const file = filled(HISTORY_CAP + 2)
    expect(file.versions.length).toBe(HISTORY_CAP)
    expect(file.versions[0].content).toBe(`version ${HISTORY_CAP + 2}`)
    expect(file.versions[HISTORY_CAP - 1].content).toBe('version 3')
    expect(file.key).toBe(KEY)
    expect(file.v).toBe(1)
  })

  test('does not mutate its input', () => {
    const before = filled(2)
    const snapshot = JSON.stringify(before)
    appendVersion(before, v(3))
    expect(JSON.stringify(before)).toBe(snapshot)
  })

  test('skips a version whose content equals the newest stored one', () => {
    const file = filled(2)
    const r = appendVersion(file, v(9, { content: 'version 2' }))
    expect(r.recorded).toBe(false)
    expect(r.reason).toBe('unchanged')
    expect(r.file).toBe(file)
    // Equal to an OLDER version is not "unchanged": the note went back to it.
    const back = appendVersion(file, v(9, { content: 'version 1' }))
    expect(back.recorded).toBe(true)
    expect(back.file.versions[0].content).toBe('version 1')
  })

  test('skips a body over HISTORY_MAX_CONTENT characters and takes one exactly at it', () => {
    const file = filled(1)
    const over = appendVersion(file, v(2, { content: 'x'.repeat(HISTORY_MAX_CONTENT + 1) }))
    expect(over.recorded).toBe(false)
    expect(over.reason).toBe('too-large')
    expect(over.file).toBe(file)
    const at = appendVersion(file, v(2, { content: 'x'.repeat(HISTORY_MAX_CONTENT) }))
    expect(at.recorded).toBe(true)
    expect(at.file.versions.length).toBe(2)
  })

  test('five bodies at the character cap fit the entry cap with the envelope', () => {
    let file = emptyHistory(KEY)
    for (let i = 1; i <= HISTORY_CAP; i++) {
      file = appendVersion(file, v(i, { content: `${i}`.repeat(HISTORY_MAX_CONTENT) })).file
    }
    expect(file.versions.length).toBe(HISTORY_CAP)
    const bytes = utf8Length(serializeHistory(file))
    expect(bytes).toBeLessThanOrEqual(HISTORY_MAX_BYTES)
    expect(bytes + 29).toBeLessThanOrEqual(250_000)
  })

  test('sheds the oldest versions when the serialized file would exceed HISTORY_MAX_BYTES', () => {
    // Three bytes per character: 45,000 characters are 135,000 bytes, so two
    // versions fit and a third does not.
    let file = emptyHistory(KEY)
    for (let i = 1; i <= 4; i++) {
      const r = appendVersion(file, v(i, { content: `€${i}`.repeat(HISTORY_MAX_CONTENT / 2) }))
      expect(r.recorded).toBe(true)
      file = r.file
    }
    expect(file.versions.length).toBeLessThan(4)
    expect(file.versions.length).toBeGreaterThanOrEqual(1)
    expect(file.versions[0].content.startsWith('€4')).toBe(true)
    expect(utf8Length(serializeHistory(file))).toBeLessThanOrEqual(HISTORY_MAX_BYTES)
  })

  test('a single version that cannot fit in bytes is too-large', () => {
    // A control character serializes as six characters, so this body is
    // under the character cap and far over the byte cap on its own.
    const file = filled(1)
    const r = appendVersion(file, v(2, { content: '\u0001'.repeat(HISTORY_MAX_CONTENT) }))
    expect(r.recorded).toBe(false)
    expect(r.reason).toBe('too-large')
    expect(r.file).toBe(file)
  })
})

describe('readVersion', () => {
  test('1 is the newest stored prior version; anything outside the range is undefined', () => {
    const file = filled(3)
    expect(readVersion(file, 1)?.content).toBe('version 3')
    expect(readVersion(file, 2)?.content).toBe('version 2')
    expect(readVersion(file, 3)?.content).toBe('version 1')
    for (const n of [0, -1, 4, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(readVersion(file, n)).toBeUndefined()
    }
    expect(readVersion(emptyHistory(KEY), 1)).toBeUndefined()
  })
})

describe('serializeHistory', () => {
  test('round-trips through parseHistory, optional fields included', () => {
    let file = emptyHistory(KEY)
    file = appendVersion(file, v(1, { agent: 'claude-code/2.1.284', session: 'abc' })).file
    file = appendVersion(file, v(2, { hash: 'sha256:00', content: 'line one\nline "two"\n' })).file
    const text = serializeHistory(file)
    expect(text.startsWith('{"v":1,"key":"project/deploy.md"')).toBe(true)
    expect(parseHistory(text, KEY)).toEqual(file)
  })
})

describe('historyAllowed', () => {
  const ok = { key: KEY, contentLength: 100, namespaceEntries: 10, env: {} }

  test('allows an ordinary write', () => {
    expect(historyAllowed(ok)).toEqual({ ok: true })
  })

  test('disabled by OPENRECALL_HISTORY=0 and its spellings, not by other values', () => {
    for (const value of ['0', 'false', 'OFF', ' no ']) {
      expect(historyAllowed({ ...ok, env: { [HISTORY_ENV]: value } })).toEqual({
        ok: false,
        reason: 'disabled',
      })
    }
    for (const value of ['1', 'true', 'on', '']) {
      expect(historyAllowed({ ...ok, env: { [HISTORY_ENV]: value } })).toEqual({ ok: true })
    }
  })

  test('reads process.env when no env is given', () => {
    const prior = process.env[HISTORY_ENV]
    process.env[HISTORY_ENV] = '0'
    try {
      expect(historyAllowed({ key: KEY, contentLength: 1, namespaceEntries: 1 }).reason).toBe(
        'disabled',
      )
    } finally {
      if (prior === undefined) delete process.env[HISTORY_ENV]
      else process.env[HISTORY_ENV] = prior
    }
  })

  test('key-too-long exactly when historyKey cannot derive a valid key', () => {
    const longest = 'k'.repeat(MAX_KEY_LENGTH - 'sys.openrecall/history/'.length - '.json'.length)
    expect(historyKey(longest)).not.toBeNull()
    expect(historyAllowed({ ...ok, key: longest })).toEqual({ ok: true })
    const over = `${longest}k`
    expect(historyKey(over)).toBeNull()
    expect(historyAllowed({ ...ok, key: over })).toEqual({ ok: false, reason: 'key-too-long' })
  })

  test('too-large over HISTORY_MAX_CONTENT characters', () => {
    expect(historyAllowed({ ...ok, contentLength: HISTORY_MAX_CONTENT })).toEqual({ ok: true })
    expect(historyAllowed({ ...ok, contentLength: HISTORY_MAX_CONTENT + 1 })).toEqual({
      ok: false,
      reason: 'too-large',
    })
  })

  test('namespace-near-cap at HISTORY_STOP_ENTRIES, not one below', () => {
    expect(historyAllowed({ ...ok, namespaceEntries: HISTORY_STOP_ENTRIES - 1 })).toEqual({
      ok: true,
    })
    expect(historyAllowed({ ...ok, namespaceEntries: HISTORY_STOP_ENTRIES })).toEqual({
      ok: false,
      reason: 'namespace-near-cap',
    })
  })

  test('the first failing rule wins, in the documented order', () => {
    const everything = {
      key: 'k'.repeat(MAX_KEY_LENGTH),
      contentLength: HISTORY_MAX_CONTENT + 1,
      namespaceEntries: HISTORY_STOP_ENTRIES,
    }
    expect(historyAllowed({ ...everything, env: { [HISTORY_ENV]: '0' } }).reason).toBe('disabled')
    expect(historyAllowed({ ...everything, env: {} }).reason).toBe('key-too-long')
    expect(historyAllowed({ ...everything, key: KEY, env: {} }).reason).toBe('too-large')
    expect(historyAllowed({ ...everything, key: KEY, contentLength: 1, env: {} }).reason).toBe(
      'namespace-near-cap',
    )
  })

  test('the warn threshold sits below the stop threshold, both under the entry cap', () => {
    expect(HISTORY_WARN_ENTRIES).toBeLessThan(HISTORY_STOP_ENTRIES)
    expect(HISTORY_STOP_ENTRIES).toBeLessThan(2_000)
  })
})
