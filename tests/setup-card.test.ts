/**
 * Setup card tests. The card is what a first-time user pastes, so two
 * properties matter more than its wording: the namespace it pins must be one
 * the server will actually authorize for that owner and nobody else, and the
 * passphrase must never be something this module could put on the wire.
 *
 * The passphrase claim is proved two ways here: a type-level pin that the
 * render function takes no passphrase, and a structural read of the module
 * source showing it imports nothing and names no network capability. A
 * request-capture assertion would pass by construction against a module that
 * makes no call, so it is deliberately absent.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  assertServiceUrl,
  generateRetypablePassphrase,
  ownerNamespace,
  PASSPHRASE_ALPHABET,
  PASSPHRASE_LENGTH,
  renderSetupCard,
  repoNamespace,
} from '../client/setup.ts'
import { authorizeNamespace } from '../src/auth.ts'
import { loadMemoryGuide } from '../src/mcp/guide.ts'

const id = (owner: string) => ({ owner })
const HOSTED = 'https://memory.twigpine.com'
const KEY = 'mk_live_example'

describe('setup card: namespace authorization (AE6, R19)', () => {
  test('the owner default is authorized for its owner and refused for another', () => {
    const ns = ownerNamespace('alice')
    expect(renderSetupCard('openclaude', { owner: 'alice', url: HOSTED, apiKey: KEY })).toContain(
      `"OPENRECALL_NAMESPACE": "${ns}"`,
    )
    expect(authorizeNamespace(id('alice'), ns)).toBe(true)
    expect(authorizeNamespace(id('bob'), ns)).toBe(false)
    // The sibling-prefix case the auth rule exists for.
    expect(authorizeNamespace(id('alic'), ns)).toBe(false)
    // Control for the two refusals above: authorizeNamespace does return true
    // for a caller that owns this namespace, so `false` is a discriminating
    // answer rather than a rule that refuses everything. (src/auth.ts is not
    // mutable from here, so this stands in for neutering the rule itself.)
    expect(authorizeNamespace(id('local'), ns)).toBe(true)
  })

  test('the per-repository form is documented and stays inside the owner subtree', () => {
    const card = renderSetupCard('openclaude', {
      owner: 'alice',
      url: HOSTED,
      apiKey: KEY,
      repo: 'openrecall',
    })
    const perRepo = repoNamespace('alice', 'openrecall')
    // Both forms appear: the owner default in the block, the per-repo form as
    // the documented convention beside it.
    expect(card).toContain(ownerNamespace('alice'))
    expect(card).toContain(perRepo)
    expect(authorizeNamespace(id('alice'), perRepo)).toBe(true)
    expect(authorizeNamespace(id('bob'), perRepo)).toBe(false)
  })

  test('a rendered namespace for one owner is never authorized for a neighbour', () => {
    for (const owner of ['ab', 'abc', 'a-b', 'alice']) {
      const ns = repoNamespace(owner, 'openrecall')
      expect(authorizeNamespace(id(owner), ns)).toBe(true)
      for (const other of ['ab', 'abc', 'a-b', 'alice']) {
        if (other === owner) continue
        expect(`${other} -> ${ns}: ${authorizeNamespace(id(other), ns)}`).toBe(
          `${other} -> ${ns}: false`,
        )
      }
    }
  })
})

/** Pull the pasted JSON block back out of the card, so it can be parsed. */
function configBlock(card: string): unknown {
  const start = card.indexOf('{')
  const end = card.lastIndexOf('}')
  return JSON.parse(card.slice(start, end + 1))
}

describe('setup card: the pasted block (R16)', () => {
  test('the block is valid JSON in the documented MCP shape', () => {
    const card = renderSetupCard('openclaude', { owner: 'alice', url: HOSTED, apiKey: KEY })
    expect(configBlock(card)).toEqual({
      mcpServers: {
        openrecall: {
          command: 'bunx',
          args: ['-y', '@twigpine/openrecall', 'mcp'],
          env: {
            OPENRECALL_URL: HOSTED,
            OPENRECALL_API_KEY: KEY,
            OPENRECALL_PASSPHRASE: '<paste your passphrase here>',
            OPENRECALL_NAMESPACE: 'user:alice',
            OPENRECALL_SCAN: 'block',
          },
        },
      },
    })
  })

  test('both consumers get the same block', () => {
    const input = { owner: 'alice', url: HOSTED, apiKey: KEY }
    expect(configBlock(renderSetupCard('zero', input))).toEqual(
      configBlock(renderSetupCard('openclaude', input)),
    )
  })

  test('the env keys are exactly the ones the MCP server reads', () => {
    // Both modules, because env reading lives in startup.ts since the preflight
    // landed while the server module still owns the transport. Naming only the
    // file that happens to read them today turns this guard red on a move that
    // changed nothing, and naming only the other one would miss a key moving
    // back. What it asserts is that the key is read SOMEWHERE the MCP server
    // runs, which is the property the card depends on.
    const src = ['../src/mcp/server.ts', '../src/mcp/startup.ts', '../src/cli/settings.ts']
      .map(f => readFileSync(new URL(f, import.meta.url), 'utf8'))
      .join('\n')
    const card = renderSetupCard('zero', { owner: 'alice', url: HOSTED, apiKey: KEY })
    const env = (
      configBlock(card) as { mcpServers: { openrecall: { env: Record<string, string> } } }
    ).mcpServers.openrecall.env
    for (const key of Object.keys(env))
      expect(`${key} read by server: ${src.includes(`'${key}'`)}`).toBe(
        `${key} read by server: true`,
      )
  })
})

describe('setup card: the passphrase is not an input (AE10, R20)', () => {
  test('the render function has no passphrase parameter', () => {
    const card = renderSetupCard('openclaude', {
      owner: 'alice',
      url: HOSTED,
      apiKey: KEY,
      // @ts-expect-error the card must never accept a passphrase: that is the
      // mechanism keeping it off the wire when the console renders the card.
      passphrase: 'correct-horse-battery-staple',
    })
    // And nothing resembling it reaches the output at runtime either.
    expect(card).not.toContain('correct-horse-battery-staple')
  })

  test('the rendered block carries a placeholder, never a generated secret', () => {
    const card = renderSetupCard('zero', { owner: 'alice', url: HOSTED, apiKey: KEY })
    expect(card).toContain('"OPENRECALL_PASSPHRASE": "<paste your passphrase here>"')
    expect(card).toContain(KEY)
  })
})

/**
 * Structural proof that the module cannot transmit anything: it must import
 * nothing at all, and it must name no network capability. Fail-closed on the
 * module system (any surviving import/require token is a violation) rather
 * than enumerating the ways a network reach could be spelled.
 */
function networkRisks(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/\b(import|require)\b/g)) {
    // Comments and prose mention neither in this module; treat every hit as a
    // module-system reference rather than trying to parse around them.
    out.push(`module-system reference: ${m[1]}`)
  }
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'EventSource']) {
    if (new RegExp(`\\b${name}\\b`).test(src)) out.push(`network capability: ${name}`)
  }
  return out
}

describe('setup card: the module makes no network call (AE10)', () => {
  test('client/setup.ts references no module system and no network capability', () => {
    const src = readFileSync(new URL('../client/setup.ts', import.meta.url), 'utf8')
    expect(src.length).toBeGreaterThan(500)
    expect(networkRisks(src)).toEqual([])
  })

  test('positive control: an import is reported', () => {
    expect(networkRisks("import { x } from './y.ts'\n")).toEqual([
      'module-system reference: import',
    ])
  })

  test('positive control: a dynamic import is reported', () => {
    expect(networkRisks("await import('./y.ts')\n")).toEqual(['module-system reference: import'])
  })

  test('positive control: a require is reported', () => {
    expect(networkRisks("const y = require('./y.ts')\n")).toEqual([
      'module-system reference: require',
    ])
  })

  test('positive control: each network capability is reported by name', () => {
    expect(networkRisks('await fetch(url)\n')).toEqual(['network capability: fetch'])
    expect(networkRisks('new XMLHttpRequest()\n')).toEqual(['network capability: XMLHttpRequest'])
    expect(networkRisks('new WebSocket(url)\n')).toEqual(['network capability: WebSocket'])
    expect(networkRisks('navigator.sendBeacon(url, body)\n')).toEqual([
      'network capability: sendBeacon',
    ])
    expect(networkRisks('new EventSource(url)\n')).toEqual(['network capability: EventSource'])
  })

  test('negative control: ordinary code is not reported', () => {
    const ordinary = [
      'export const pick = (a: string[]) => a[0]\n',
      'const bytes = new Uint8Array(32)\ncrypto.getRandomValues(bytes)\n',
      'export const url = new URL("https://example.com")\n',
      'const parts = ["a", "b"].join("\\n")\n',
    ]
    for (const src of ordinary)
      expect(`${src.slice(0, 20)} :: ${networkRisks(src)}`).toBe(`${src.slice(0, 20)} :: `)
  })
})

describe('setup card: passphrase entropy (AE10, R20)', () => {
  test('the alphabet and length give at least 128 bits', () => {
    const bits = PASSPHRASE_LENGTH * Math.log2(PASSPHRASE_ALPHABET.length)
    expect(bits).toBeGreaterThanOrEqual(128)
    // The declared alphabet has no duplicate characters, or the bits above
    // overstate what a draw actually carries.
    expect(new Set(PASSPHRASE_ALPHABET).size).toBe(PASSPHRASE_ALPHABET.length)
  })

  test('a generated passphrase matches the declared alphabet and length', () => {
    const p = generateRetypablePassphrase()
    expect(p.length).toBe(PASSPHRASE_LENGTH)
    for (const ch of p)
      expect(`${ch} in alphabet: ${PASSPHRASE_ALPHABET.includes(ch)}`).toBe(
        `${ch} in alphabet: true`,
      )
  })

  test('generation uses the whole declared alphabet, so the bits are real', () => {
    // A generator drawing from a subset would still pass the charset check
    // above while carrying far fewer bits than PASSPHRASE_LENGTH * log2(n).
    const seen = new Set<string>()
    for (let i = 0; i < 300; i++) for (const ch of generateRetypablePassphrase()) seen.add(ch)
    expect(seen.size).toBe(PASSPHRASE_ALPHABET.length)
  })

  test('two generations differ', () => {
    const runs = new Set(Array.from({ length: 50 }, () => generateRetypablePassphrase()))
    expect(runs.size).toBe(50)
  })
})

describe('setup card: URL rule (R23)', () => {
  test('https is accepted', () => {
    expect(assertServiceUrl('https://memory.twigpine.com')).toBe('https://memory.twigpine.com')
    expect(renderSetupCard('openclaude', { owner: 'a', url: HOSTED, apiKey: KEY })).toContain(
      HOSTED,
    )
  })

  test('http to a non-loopback host is refused', () => {
    expect(() => assertServiceUrl('http://memory.twigpine.com')).toThrow(/https/)
    expect(() =>
      renderSetupCard('openclaude', { owner: 'a', url: 'http://memory.twigpine.com', apiKey: KEY }),
    ).toThrow(/https/)
  })

  test('http to loopback is accepted', () => {
    for (const url of [
      'http://localhost:8080',
      'http://127.0.0.1:8080',
      'http://127.1.2.3:8080',
      'http://[::1]:8080',
    ])
      expect(`${url} -> ${assertServiceUrl(url)}`).toBe(`${url} -> ${url}`)
  })

  test('near-loopback hosts are refused', () => {
    for (const url of [
      'http://localhost.attacker.com',
      'http://127.0.0.1.attacker.com',
      'http://128.0.0.1',
      'http://169.254.169.254',
      'http://0.0.0.0',
      'http://[::2]',
    ])
      expect(() => assertServiceUrl(url)).toThrow()
  })

  test('anything that is not http(s) is refused, and so is a non-URL', () => {
    for (const url of [
      'ftp://localhost/x',
      'file:///etc/passwd',
      'ws://localhost',
      'not a url',
      '',
    ])
      expect(() => assertServiceUrl(url)).toThrow()
  })
})

/**
 * The guide and the card are two onboarding surfaces for the same decision, and
 * they drifted once already: the guide told the model `user:<owner>/<repo>`
 * while the card told the operator `user:<owner>/repo/<repo>`, so the same
 * repository's memory landed in two subtrees and recall found nothing in
 * whichever one was not used, with no error anywhere. This pins them together
 * by reading the form out of the guide text rather than restating it here, so
 * changing either side alone turns it red.
 */
function documentedRepoNamespace(guide: string): string {
  const forms = [...guide.matchAll(/`(user:<owner>[^`]*)`/g)].map(m => m[1])
  const withRepo = forms.filter(f => f.includes('<repo>'))
  if (withRepo.length !== 1)
    throw new Error(`guide documents ${withRepo.length} per-repo namespace forms: ${forms}`)
  return withRepo[0]
}

describe('setup card: the guide and the card agree on the namespace form', () => {
  test('the card renders exactly the per-repository form the guide documents', () => {
    const template = documentedRepoNamespace(loadMemoryGuide())
    const expected = template.replace('<owner>', 'alice').replace('<repo>', 'openrecall')
    expect(repoNamespace('alice', 'openrecall')).toBe(expected)
    // And the operator-facing prose carries the same string the model is told.
    expect(
      renderSetupCard('openclaude', {
        owner: 'alice',
        url: HOSTED,
        apiKey: KEY,
        repo: 'openrecall',
      }),
    ).toContain(expected)
  })
})

/**
 * `openrecall setup` end to end. The pure functions above are well covered, but
 * cmdSetup is where they are wired together, and the wiring is what carries the
 * property that matters: the passphrase is generated here, printed once,
 * separately, and is never an input to the render function, so it cannot reach
 * the pasted block. Spawning the real CLI is the only way to see the two
 * outputs as a user does.
 */
const CLI = fileURLToPath(new URL('../bin/openrecall.ts', import.meta.url))

/** A clean env, so ambient OPENRECALL_* vars cannot change what the CLI prints. */
function runCli(args: string[]) {
  const r = Bun.spawnSync(['bun', 'run', CLI, ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    code: r.exitCode,
    stdout: new TextDecoder().decode(r.stdout),
    stderr: new TextDecoder().decode(r.stderr),
  }
}

describe('openrecall card (CLI)', () => {
  test('prints the pasted block for the named owner and url', () => {
    const r = runCli(['card', 'alice', HOSTED])
    expect(`exit ${r.code}: ${r.stderr}`).toBe('exit 0: ')
    expect(configBlock(r.stdout)).toEqual({
      mcpServers: {
        openrecall: {
          command: 'bunx',
          args: ['-y', '@twigpine/openrecall', 'mcp'],
          env: {
            OPENRECALL_URL: HOSTED,
            OPENRECALL_API_KEY: '<paste your service key here>',
            OPENRECALL_PASSPHRASE: '<paste your passphrase here>',
            OPENRECALL_NAMESPACE: 'user:alice',
            OPENRECALL_SCAN: 'block',
          },
        },
      },
    })
    // The per-repository convention the guide gives the model, in the prose.
    expect(r.stdout).toContain(repoNamespace('alice', 'my-repo'))
  })

  test('the printed passphrase is shown once and is not in the pasted block', () => {
    const r = runCli(['card', 'alice', HOSTED])
    const m = /passphrase \(shown once, back it up now\):\s+(\S+)/.exec(r.stdout)
    expect(m).not.toBeNull()
    const pass = (m as RegExpExecArray)[1]
    expect(pass.length).toBe(PASSPHRASE_LENGTH)
    for (const ch of pass)
      expect(`${ch} in alphabet: ${PASSPHRASE_ALPHABET.includes(ch)}`).toBe(
        `${ch} in alphabet: true`,
      )
    // The block keeps the placeholder: the generated value is printed beside
    // the card, never rendered into it.
    const env = (
      configBlock(r.stdout) as {
        mcpServers: { openrecall: { env: Record<string, string> } }
      }
    ).mcpServers.openrecall.env
    expect(env.OPENRECALL_PASSPHRASE).toBe('<paste your passphrase here>')
    expect(r.stdout.slice(0, r.stdout.lastIndexOf('}'))).not.toContain(pass)
  })

  test('a run with no owner fails instead of rendering a namespace', () => {
    const r = runCli(['card'])
    expect(r.code).not.toBe(0)
    expect(r.stdout).toContain('openrecall card <owner> [url]')
    expect(r.stdout).not.toContain('mcpServers')
  })

  test('a refused url fails rather than printing a card', () => {
    const r = runCli(['card', 'alice', 'http://memory.twigpine.com'])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('https')
    expect(r.stdout).not.toContain('mcpServers')
  })
})

/**
 * Credentials in the URL. The card is a block the user pastes into a config
 * file and copies between machines, and the service key already has its own
 * env var in that block. A userinfo component puts a second copy of a
 * credential somewhere nothing reads it from, so it is refused rather than
 * stripped: a silently rewritten URL is not the one the caller asked for.
 *
 * Every refusal below is paired with the neighbouring URL that differs only by
 * the userinfo, because a validator that refused everything would pass the
 * refusals on its own.
 */
describe('setup card: the URL carries no credentials (R23)', () => {
  test('a userinfo component is refused and the same url without it is accepted', () => {
    for (const [bad, good] of [
      ['https://key@memory.twigpine.com', 'https://memory.twigpine.com'],
      ['https://user:pw@memory.twigpine.com', 'https://memory.twigpine.com'],
      ['https://:pw@memory.twigpine.com', 'https://memory.twigpine.com'],
      ['https://key@memory.twigpine.com/path', 'https://memory.twigpine.com/path'],
    ]) {
      expect(() => assertServiceUrl(bad)).toThrow(/OPENRECALL_API_KEY/)
      expect(`${good} -> ${assertServiceUrl(good)}`).toBe(`${good} -> ${good}`)
    }
  })

  test('loopback does not excuse credentials', () => {
    // The http exemption is about there being no network to listen on, which
    // says nothing about a credential landing in a pasted file.
    expect(() => assertServiceUrl('http://key@localhost:8080')).toThrow(/OPENRECALL_API_KEY/)
    expect(assertServiceUrl('http://localhost:8080')).toBe('http://localhost:8080')
  })

  test('the card refuses to render a url with credentials', () => {
    expect(() =>
      renderSetupCard('openclaude', {
        owner: 'alice',
        url: 'https://key@memory.twigpine.com',
        apiKey: KEY,
      }),
    ).toThrow(/OPENRECALL_API_KEY/)
    // ... and still renders the same url without the userinfo.
    expect(
      renderSetupCard('openclaude', {
        owner: 'alice',
        url: 'https://memory.twigpine.com',
        apiKey: KEY,
      }),
    ).toContain('"OPENRECALL_URL": "https://memory.twigpine.com"')
  })
})

/**
 * Owner and repo validation. The rendered namespace is what decides whether the
 * first save succeeds, so a name the server will refuse should fail here, at
 * render time, where the message can say why, rather than as an opaque 400 on
 * the user's first memory write.
 *
 * Each rejected class is paired with an accepted neighbour, and every accepted
 * owner is driven through the real authorizeNamespace in both directions, so a
 * validator that refused everything (or one that let `/` through and moved the
 * owner segment) cannot pass this block.
 */
const BAD_NAMES = [
  ['a/b', 'a slash makes the owner segment something else entirely'],
  ['a//b', 'double slash'],
  ['..', 'traversal'],
  ['a..b', 'traversal inside a name'],
  ['../etc', 'traversal prefix'],
  ['a b', 'whitespace'],
  ['a\tb', 'tab'],
  ['a\nb', 'newline'],
  ['a:b', 'a colon, which the namespace grammar reserves for the scope'],
  ['user:alice', 'an already-qualified namespace'],
  ['', 'empty'],
  ['.hidden', 'leading dot'],
  ['-alice', 'leading dash'],
  ['_alice', 'leading underscore'],
  ['/alice', 'leading slash'],
  ['alice/', 'trailing slash'],
  ['a\\b', 'backslash'],
  ['a\0b', 'NUL'],
  ['alicé', 'non-ascii'],
  ['a#b', 'fragment character'],
  ['a?b', 'query character'],
  ['a%2fb', 'percent-encoded slash'],
  ['a'.repeat(64), 'over the segment length cap'],
]

const GOOD_NAMES = ['a', 'ab', 'alice', 'a-b', 'a_b', 'a.b', 'ABC123', '0', 'a'.repeat(63)]

describe('setup card: owner and repo are validated before they become a namespace', () => {
  test('a bad owner is refused rather than silently rewritten', () => {
    for (const [owner, why] of BAD_NAMES) {
      expect(
        `${why}: ${(() => {
          try {
            return ownerNamespace(owner)
          } catch (e) {
            return `refused: ${(e as Error).message.includes('owner')}`
          }
        })()}`,
      ).toBe(`${why}: refused: true`)
    }
  })

  test('an ordinary owner still renders and is authorized for exactly its owner', () => {
    for (const owner of GOOD_NAMES) {
      const ns = ownerNamespace(owner)
      expect(ns).toBe(`user:${owner}`)
      expect(`${owner} owns ${ns}: ${authorizeNamespace(id(owner), ns)}`).toBe(
        `${owner} owns ${ns}: true`,
      )
      const other = owner === 'alice' ? 'bob' : 'alice'
      expect(`${other} owns ${ns}: ${authorizeNamespace(id(other), ns)}`).toBe(
        `${other} owns ${ns}: false`,
      )
    }
  })

  test('a bad repo is refused rather than silently rewritten', () => {
    for (const [repo, why] of BAD_NAMES) {
      expect(
        `${why}: ${(() => {
          try {
            return repoNamespace('alice', repo)
          } catch (e) {
            return `refused: ${(e as Error).message.includes('repo')}`
          }
        })()}`,
      ).toBe(`${why}: refused: true`)
    }
  })

  test('an ordinary repo still renders inside the owner subtree', () => {
    for (const repo of GOOD_NAMES) {
      const ns = repoNamespace('alice', repo)
      expect(ns).toBe(`user:alice/${repo}`)
      expect(`alice owns ${ns}: ${authorizeNamespace(id('alice'), ns)}`).toBe(
        `alice owns ${ns}: true`,
      )
      expect(`bob owns ${ns}: ${authorizeNamespace(id('bob'), ns)}`).toBe(`bob owns ${ns}: false`)
    }
  })

  test('the card refuses a bad owner or repo instead of rendering a block', () => {
    expect(() =>
      renderSetupCard('openclaude', { owner: 'alice/evil', url: HOSTED, apiKey: KEY }),
    ).toThrow(/owner/)
    expect(() =>
      renderSetupCard('openclaude', { owner: 'alice', url: HOSTED, apiKey: KEY, repo: '../evil' }),
    ).toThrow(/repo/)
    // The neighbouring good input still renders both namespaces.
    const card = renderSetupCard('openclaude', {
      owner: 'alice',
      url: HOSTED,
      apiKey: KEY,
      repo: 'openrecall',
    })
    expect(card).toContain('"OPENRECALL_NAMESPACE": "user:alice"')
    expect(card).toContain('user:alice/openrecall')
  })

  test('a rejected owner never reaches a namespace the server would authorize elsewhere', () => {
    // The concrete harm: `alice/../bob` would render `user:alice/../bob`, which
    // authorizeNamespace grants to alice because it is a textual child of her
    // root, while the storage layer reads it as bob's subtree.
    expect(authorizeNamespace(id('alice'), 'user:alice/../bob')).toBe(true)
    expect(() => ownerNamespace('alice/../bob')).toThrow(/owner/)
  })
})
