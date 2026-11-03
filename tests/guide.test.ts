/**
 * The memory guide must load from the canonical SKILL.md (frontmatter stripped)
 * so the MCP prompt and the Claude Code skill never drift.
 */

import { describe, expect, test } from 'bun:test'
import { loadMemoryGuide, SHORT_INSTRUCTIONS } from '../src/mcp/guide.ts'

/** Both surfaces are hard-wrapped, so assert on the text, not the line breaks. */
const flat = (t: string) => t.replace(/\s+/g, ' ')

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

describe('retention note (R27, U10)', () => {
  // On fs and s3 a delete erases. On the node driver it does not: prior
  // ciphertext stays in repository history and in any pin already taken. The
  // guide is static and serves every deployment, so it must not claim either
  // outcome. What it can do is tell the model the delete response is where the
  // answer is, so it never reports "deleted" as "gone" on a store that retains.
  test('the guide says deletion may not erase, and points at the delete response', () => {
    const g = flat(loadMemoryGuide()).toLowerCase()
    expect(g).toContain('not every deployment can erase')
    expect(g).toContain('memory_delete')
  })

  test('the guide does not promise erasure', () => {
    // The control that matters. A guide asserting deletion removes the data
    // would be false on the node driver, which is the exact false promise R27
    // exists to stop.
    const g = flat(loadMemoryGuide()).toLowerCase()
    expect(g).not.toContain('permanently deletes')
    expect(g).not.toContain('erases it from the server')
  })
})

describe('memory routing rule', () => {
  // Three independent rules, three controls. Asserting one shared substring
  // would prove nothing about the other two clauses.
  test('the guide sends durable cross-machine facts to openrecall', () => {
    expect(flat(loadMemoryGuide())).toContain('durable facts that must survive across machines')
  })

  test('the guide sends the session log to the host agent local memdir', () => {
    const g = flat(loadMemoryGuide())
    expect(g).toContain("The host agent's local memdir")
    expect(g).toContain('the session log')
  })

  test('the guide sends repo-shared facts to team memory', () => {
    const g = flat(loadMemoryGuide())
    expect(g).toContain('Team memory')
    expect(g).toContain('repo-shared facts')
  })

  test('the short instructions carry all three clauses in one sentence', () => {
    const sentence = flat(SHORT_INSTRUCTIONS)
      .split('. ')
      .find(s => s.includes('openrecall takes'))
    expect(sentence).toBeDefined()
    expect(sentence).toContain('durable facts that must survive across machines')
    expect(sentence).toContain('local memdir keeps the session log')
    expect(sentence).toContain('team memory')
  })

  // The three clauses above only name the categories. What resolves the case
  // this feature exists for is the tie-breaker, and it used to live in SKILL.md
  // alone: the full guide reaches the model only if it chooses to call the
  // memory_guide prompt, and nothing forces it. SHORT_INSTRUCTIONS is in
  // context on every session, so a model that never calls the prompt was left
  // with three categories and no way to pick between two of them.
  const TIE_BREAKER =
    'ask who needs it: you on every machine, this session only, or everyone on the repository'

  test('the short instructions carry the tie-breaker, not just the categories', () => {
    expect(flat(SHORT_INSTRUCTIONS)).toContain(TIE_BREAKER)
  })
})

describe('namespace convention', () => {
  test('the guide pins namespaces to the owner authorized subtree', () => {
    const g = flat(loadMemoryGuide())
    expect(g).toContain('grants an owner `user:<owner>` and its children')
  })
})

describe('guide source controls', () => {
  // The guide is SKILL.md inlined at build time, so it cannot be missing at
  // runtime. These markers exist only in the file, so they go red if the body
  // served stops being the one that ships.
  test('the loaded guide carries the markers only SKILL.md has', () => {
    const g = flat(loadMemoryGuide())
    for (const marker of [
      'Trust but verify',
      'Entry-key conventions',
      'For a fact that seems to fit two of them',
    ])
      expect(`${marker}: guide=${g.includes(marker)}`).toBe(`${marker}: guide=true`)
  })
})
