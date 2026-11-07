/**
 * Secret scanner — catches planted credentials, stays quiet on ordinary prose.
 */

import { describe, expect, test } from 'bun:test'
import { enforce, SecretFoundError, scanEntry } from '../client/secretscan.ts'
import { FAKE } from './secret-fixtures.ts'

describe('secret scanner', () => {
  test('flags common credential shapes', () => {
    const cases: [string, string][] = [
      ['aws', `key = ${FAKE.aws}`],
      ['gh', `token: ${FAKE.github}`],
      ['openai', `use ${FAKE.openai}`],
      ['anthropic', `ANTHROPIC_API_KEY=${FAKE.anthropic}`],
      ['stripe', `stripe ${FAKE.stripe}`],
      ['pem', FAKE.pem],
      ['assign', 'password = "hunter2hunter2"'],
    ]
    for (const [label, text] of cases) {
      expect(scanEntry(`${label}.md`, text).length).toBeGreaterThan(0)
    }
  })

  test('does not flag ordinary memory prose', () => {
    const prose =
      '# What I know\n- The user prefers terse answers.\n' +
      '- The project deploys to Fly in region sin.\n' +
      '- They like the token-bucket rate limiter design.\n'
    expect(scanEntry('MEMORY.md', prose)).toHaveLength(0)
  })

  test('reports the line number and redacts the match', () => {
    const f = scanEntry('n.md', `line one\nkey = ${FAKE.aws}\nline three`)
    expect(f[0].line).toBe(2)
    expect(f[0].match).not.toContain(FAKE.aws)
    expect(f[0].match).toContain('…')
  })

  test('block mode throws, warn mode returns, off mode is silent', () => {
    const entries = { 'a.md': `gh token ${FAKE.github}` }
    expect(() => enforce(entries, 'block')).toThrow(SecretFoundError)
    expect(enforce(entries, 'warn').length).toBe(1)
    expect(enforce(entries, 'off')).toHaveLength(0)
  })

  test('block-mode errors never echo the match fragment', () => {
    const entries = { 'a.md': `line one\ngh token ${FAKE.github}` }
    const finding = scanEntry('a.md', entries['a.md'])[0]
    let err: SecretFoundError | undefined
    try {
      enforce(entries, 'block')
    } catch (e) {
      err = e as SecretFoundError
    }

    expect(err).toBeInstanceOf(SecretFoundError)
    // The message names the key, line and rule for the operator, but the
    // redacted match stays on `findings` and out of anything that gets logged.
    expect(err?.message).toContain('a.md:2')
    expect(err?.message).toContain(finding.description)
    expect(err?.message).not.toContain(finding.match)
    expect(err?.message).not.toContain('…')
  })
})
