/**
 * The memory guide must load from the canonical SKILL.md (frontmatter stripped)
 * so the MCP prompt and the Claude Code skill never drift.
 */

import { describe, expect, test } from 'bun:test'
import { loadMemoryGuide, SHORT_INSTRUCTIONS } from '../src/mcp/guide.ts'

describe('memory guide', () => {
  test('loads the SKILL.md body, not its frontmatter', () => {
    const g = loadMemoryGuide()
    expect(g.length).toBeGreaterThan(200)
    expect(g).toContain('Recall first')
    expect(g).toContain('Save what')
    // Frontmatter delimiters and the name: line must be stripped.
    expect(g.startsWith('---')).toBe(false)
    expect(g).not.toContain('name: openrecall-memory')
  })

  test('short instructions steer recall-first / save-durable', () => {
    expect(SHORT_INSTRUCTIONS).toContain('memory_recall')
    expect(SHORT_INSTRUCTIONS).toContain('memory_save')
    expect(SHORT_INSTRUCTIONS).toContain('memory_guide')
  })
})
