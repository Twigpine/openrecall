/**
 * The timing log is produced on the client side of the crypto, where the query
 * and every entry are plaintext, and it lands in the launching agent's log. So
 * the field set is an allowlist, pinned here by the test and by the type.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { logTiming, setTimingSink, TIMING_FIELDS } from '../src/log.ts'

const lines: Record<string, unknown>[] = []
afterEach(() => {
  setTimingSink(null)
  lines.length = 0
})

describe('timing log', () => {
  test('a timing line carries exactly the allowlisted fields, as numbers and a tool name', () => {
    setTimingSink(l => lines.push(l as Record<string, unknown>))
    logTiming({
      tool: 'memory_recall',
      fetchMs: 1.5,
      decryptMs: 0.2,
      rankMs: 3,
      formatMs: 0.1,
      totalMs: 5,
      entries: 42,
      bytes: 9001,
    })
    expect(lines).toHaveLength(1)
    const line = lines[0] as Record<string, unknown>
    expect(Object.keys(line).sort()).toEqual([...TIMING_FIELDS].sort())
    expect(typeof line.timestamp).toBe('string')
    expect(line.tool).toBe('memory_recall')
    for (const k of TIMING_FIELDS) {
      if (k === 'timestamp' || k === 'tool') continue
      expect(`${k}: ${typeof line[k]}`).toBe(`${k}: number`)
    }
  })
})
