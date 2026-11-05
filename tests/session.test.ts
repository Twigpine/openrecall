/**
 * Per-process session state (`src/mcp/session.ts`): where the agent label
 * comes from, in what order, and the shape of the session id.
 */

import { describe, expect, test } from 'bun:test'
import { agentLabelOf, makeSession, newSessionId, UNKNOWN_AGENT } from '../src/mcp/session.ts'

describe('agent label', () => {
  test('is name/version from the client info getter', () => {
    const s = makeSession({ agent: () => ({ name: 'claude-code', version: '2.1.284' }), env: {} })
    expect(s.agentLabel()).toBe('claude-code/2.1.284')
  })

  test('OPENRECALL_AGENT in the environment overrides the getter', () => {
    const s = makeSession({
      agent: () => ({ name: 'claude-code', version: '2.1.284' }),
      env: { OPENRECALL_AGENT: 'zero/0.9' },
    })
    expect(s.agentLabel()).toBe('zero/0.9')
    // Blank is not an override.
    const blank = makeSession({
      agent: () => ({ name: 'codex', version: '1' }),
      env: { OPENRECALL_AGENT: '   ' },
    })
    expect(blank.agentLabel()).toBe('codex/1')
  })

  test('is unknown when nothing is available', () => {
    expect(makeSession().agentLabel()).toBe(UNKNOWN_AGENT)
    expect(makeSession({ agent: () => undefined, env: {} }).agentLabel()).toBe(UNKNOWN_AGENT)
    expect(
      makeSession({
        agent: () => {
          throw new Error('not connected')
        },
      }).agentLabel(),
    ).toBe(UNKNOWN_AGENT)
    expect(makeSession({ agent: () => ({ name: '', version: '1' }) }).agentLabel()).toBe(
      UNKNOWN_AGENT,
    )
  })

  test('reads the getter on every call, so a client that connects later is seen', () => {
    let info: { name: string; version: string } | undefined
    const s = makeSession({ agent: () => info, env: {} })
    expect(s.agentLabel()).toBe(UNKNOWN_AGENT)
    info = { name: 'cursor', version: '3.1' }
    expect(s.agentLabel()).toBe('cursor/3.1')
  })

  test('a name without a version is the name alone', () => {
    expect(agentLabelOf({ name: 'gemini-cli', version: '' })).toBe('gemini-cli')
  })

  test('is one bounded printable line whatever the client sent', () => {
    const hostile = { name: 'evil\nagent\u0000\u001b[31m', version: `1.0 ${'x'.repeat(200)}` }
    const label = agentLabelOf(hostile)
    expect(label).not.toContain('\n')
    expect(label).not.toContain('\u0000')
    expect(label).not.toContain('\u001b')
    expect(label.length).toBeLessThanOrEqual(80)
    expect(label.startsWith('evilagent')).toBe(true)
  })
})

describe('session id', () => {
  test('is s followed by eight Crockford base32 characters', () => {
    for (let i = 0; i < 50; i++) expect(newSessionId()).toMatch(/^s[0-9A-HJKMNP-TV-Z]{8}$/)
  })

  test('is fixed for one session and differs between sessions', () => {
    const a = makeSession()
    const b = makeSession()
    expect(a.sessionId).toBe(a.sessionId)
    expect(a.sessionId).not.toBe(b.sessionId)
    expect(new Set(Array.from({ length: 100 }, () => newSessionId())).size).toBe(100)
  })

  test('a fresh session has opened no project and has nothing pending', () => {
    const s = makeSession()
    expect(s.openedProjects.size).toBe(0)
    expect(s.pendingAccess.size).toBe(0)
  })
})
