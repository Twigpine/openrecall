/**
 * Startup preflight for `openrecall mcp`.
 *
 * The failure this exists to prevent: a wrong or unexpanded passphrase still
 * lists keys today, because the manifest is cleartext, and still saves. That
 * first save leaves a namespace written with two different keys, after which
 * every later pull fails GCM authentication for the CORRECT passphrase too. So
 * the interesting assertion in the undecryptable case is not "startup was
 * refused", it is "the namespace is still fully readable afterwards".
 *
 * Each defect gets its own control and each control asserts WHICH diagnostic
 * fired, not merely that something did. A preflight that refused every
 * configuration would pass a pile of one-sided refusal tests; `markerOf` below
 * makes that impossible by classifying the diagnostic into exactly one bucket,
 * and the ready-configuration tests are the negative controls beside them.
 *
 * The same rule covers the non-fatal warnings: each is asserted in both states,
 * present against a deployment that earns it and absent against one that does
 * not, because a warning emitted unconditionally passes every test that only
 * looks for it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenRecallClient } from '../client/index.ts'
import { preflight } from '../src/mcp/startup.ts'

const PASSPHRASE = 'correct horse battery staple'
const WRONG = 'wrong horse battery staple'

let server: ReturnType<typeof Bun.serve>
let url: string

beforeAll(async () => {
  const { handleRequest } = await import('../src/handler.ts')
  server = Bun.serve({ port: 0, fetch: handleRequest })
  url = `http://localhost:${server.port}`
})

afterAll(() => server?.stop(true))

/**
 * Which diagnostic this text is, by a phrase unique to it. Returns 'other' for
 * anything unclassified, so a reworded diagnostic, or a new refusal that nobody
 * added a marker for, fails loudly rather than quietly matching a neighbour.
 */
function markerOf(text: string): string {
  const table: [string, RegExp][] = [
    ['misexpansion', /unexpanded variable reference/],
    ['missing-passphrase', /OPENRECALL_PASSPHRASE \(or OPENRECALL_PASSPHRASE_FILE\) is not set/],
    ['unreachable', /cannot reach the openrecall server/],
    ['rejected-key', /rejected the service key/],
    ['unauthorized-namespace', /refused namespace/],
    ['undecryptable', /cannot decrypt the existing entries/],
    ['unservable', /but served none of the/],
    ['read-failed', /failed before anything could be decrypted/],
    ['invalid-scan-mode', /which is not a scan mode/],
    ['server-refused', /refused the startup read/],
    ['no-answer', /accepted the connection but did not answer/],
    ['passphrase-file', /OPENRECALL_PASSPHRASE_FILE points at/],
  ]
  const hits = table.filter(([, re]) => re.test(text)).map(([name]) => name)
  return hits.length === 1 ? (hits[0] as string) : `other(${hits.join('+') || 'none'})`
}

/**
 * A server that answers each path+view differently. The one-shot `stub` below
 * cannot express the interesting shapes here, which all need the hashes view
 * and the full read to disagree.
 */
function routeStub(route: (req: Request) => Response | Promise<Response>) {
  const s = Bun.serve({ port: 0, fetch: route })
  return { url: `http://localhost:${s.port}`, stop: () => s.stop(true) }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A one-shot server that answers every request the same way. */
function stub(status: number, body: unknown) {
  const hits: string[] = []
  const s = Bun.serve({
    port: 0,
    fetch(req) {
      hits.push(new URL(req.url).pathname)
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  return { url: `http://localhost:${s.port}`, hits, stop: () => s.stop(true) }
}

const envFor = (over: Record<string, string | undefined>) => ({
  OPENRECALL_URL: url,
  OPENRECALL_PASSPHRASE: PASSPHRASE,
  OPENRECALL_NAMESPACE: 'user:me',
  ...over,
})

describe('mcp startup preflight', () => {
  test('no diagnostic ever echoes the passphrase or the service key', async () => {
    // Diagnostics go to stderr, which is exactly what a launcher captures into
    // a log file. The passphrase is the one value that must never leave this
    // process, and a message quoting the thing that failed is the natural way
    // to write one, so this is asserted across every refusal rather than left
    // to review.
    // Built rather than written literally so the file itself carries no
    // template-curly string for the linter to object to.
    const UNEXPANDED_PREFIX = `${'$'}{VAR}`
    const SECRET = 'zzz-passphrase-must-not-appear-zzz'
    const APIKEY = 'zzz-apikey-must-not-appear-zzz'
    const ns = 'user:pf-secrets'
    await new OpenRecallClient({ url, passphrase: PASSPHRASE }).push(ns, { 'a.md': 'hi' })
    const denier = stub(401, { error: { code: 'unauthorized' } })
    const forbidder = stub(403, { error: { code: 'forbidden' } })
    // The two paths that interpolate a fully server-controlled string into a
    // diagnostic: an unmapped status from the hashes read, and an HTTP error
    // raised by the pull. They are where an absence claim is worth the least
    // and needed the most, and neither was in this matrix.
    const SERVER_TEXT = 'zzz-server-controlled-zzz'
    const unmapped = stub(503, { error: { code: 'overloaded', note: SERVER_TEXT } })
    const pullFails = routeStub(req =>
      new URL(req.url).search.includes('view=hashes')
        ? json(200, {
            version: 1,
            entryChecksums: { 'note.md': 'deadbeef' },
            supports: ['entry-view'],
          })
        : json(500, { error: { code: 'internal', note: SERVER_TEXT } }),
    )

    const cases: Record<string, string | undefined>[] = [
      { OPENRECALL_PASSPHRASE: `${UNEXPANDED_PREFIX}${SECRET}`, OPENRECALL_API_KEY: APIKEY },
      { OPENRECALL_PASSPHRASE: undefined, OPENRECALL_API_KEY: APIKEY },
      {
        OPENRECALL_URL: 'http://127.0.0.1:1',
        OPENRECALL_PASSPHRASE: SECRET,
        OPENRECALL_API_KEY: APIKEY,
      },
      { OPENRECALL_URL: denier.url, OPENRECALL_PASSPHRASE: SECRET, OPENRECALL_API_KEY: APIKEY },
      { OPENRECALL_URL: forbidder.url, OPENRECALL_PASSPHRASE: SECRET, OPENRECALL_API_KEY: APIKEY },
      { OPENRECALL_NAMESPACE: ns, OPENRECALL_PASSPHRASE: SECRET, OPENRECALL_API_KEY: APIKEY },
      { OPENRECALL_URL: unmapped.url, OPENRECALL_PASSPHRASE: SECRET, OPENRECALL_API_KEY: APIKEY },
      { OPENRECALL_URL: pullFails.url, OPENRECALL_PASSPHRASE: SECRET, OPENRECALL_API_KEY: APIKEY },
      { OPENRECALL_SCAN: 'blcok', OPENRECALL_PASSPHRASE: SECRET, OPENRECALL_API_KEY: APIKEY },
    ]
    const seen: string[] = []
    const serverRefusals: string[] = []
    for (const over of cases) {
      const r = await preflight(envFor(over))
      expect(r.ready).toBe(false)
      if (!r.ready) {
        seen.push(markerOf(r.diagnostic))
        if (markerOf(r.diagnostic) === 'server-refused') serverRefusals.push(r.diagnostic)
        expect(`${markerOf(r.diagnostic)} leaks: ${r.diagnostic.includes(SECRET)}`).toBe(
          `${markerOf(r.diagnostic)} leaks: false`,
        )
        expect(r.diagnostic).not.toContain(APIKEY)
      }
    }
    denier.stop()
    forbidder.stop()
    unmapped.stop()
    pullFails.stop()
    // Positive control: every refusal was actually exercised. Without this the
    // absence claim would hold just as well over an empty list.
    expect(seen).toEqual([
      'misexpansion',
      'missing-passphrase',
      'unreachable',
      'rejected-key',
      'unauthorized-namespace',
      'undecryptable',
      'server-refused',
      'server-refused',
      'invalid-scan-mode',
    ])
    // And the two server-refused cases really did carry the server's own text
    // into the diagnostic. Without this the no-leak claim over them would hold
    // over a diagnostic that interpolated nothing at all.
    expect(serverRefusals.filter(d => d.includes(SERVER_TEXT))).toHaveLength(2)
  })

  test('a correct configuration against an empty namespace is ready', async () => {
    const r = await preflight(envFor({ OPENRECALL_NAMESPACE: 'user:pf-empty' }))
    expect(r.ready).toBe(true)
    if (r.ready) expect(r.namespace).toBe('user:pf-empty')
  })

  test('a correct configuration against a non-empty namespace is ready', async () => {
    const ns = 'user:pf-ready'
    await new OpenRecallClient({ url, passphrase: PASSPHRASE }).push(ns, { 'a.md': 'hello' })
    const r = await preflight(envFor({ OPENRECALL_NAMESPACE: ns }))
    expect(r.ready).toBe(true)
  })

  test('an unexpanded variable reference in the passphrase is refused as misexpansion', async () => {
    const s = stub(200, { version: 1, entryChecksums: {} })
    try {
      const r = await preflight(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal is the fixture.
        envFor({ OPENRECALL_URL: s.url, OPENRECALL_PASSPHRASE: '${OPENRECALL_PASSPHRASE}' }),
      )
      expect(r.ready).toBe(false)
      expect(markerOf(r.ready ? '' : r.diagnostic)).toBe('misexpansion')
      // Before any request, not just before any write: the literal must never
      // reach a server that would then hold entries under a key nobody has.
      expect(s.hits).toEqual([])
    } finally {
      s.stop()
    }
  })

  test('an unexpanded reference in the API key is refused as misexpansion', async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal is the fixture.
    const r = await preflight(envFor({ OPENRECALL_API_KEY: '${OPENRECALL_API_KEY}' }))
    expect(r.ready).toBe(false)
    expect(markerOf(r.ready ? '' : r.diagnostic)).toBe('misexpansion')
  })

  test('a bare $VAR reference in the passphrase is refused as misexpansion', async () => {
    // The braced form is what openclaude writes, but a config written by hand
    // or by another launcher carries the bare form just as easily and the
    // consequence is identical: template text saved as a passphrase, and a
    // namespace left under a key nobody can reproduce. Built from a separate
    // '$' rather than written literally, like the fixture above, so the file
    // itself carries no shell-looking literal for a reader to misread.
    const s = stub(200, { version: 1, entryChecksums: {} })
    try {
      const r = await preflight(
        envFor({ OPENRECALL_URL: s.url, OPENRECALL_PASSPHRASE: `${'$'}OPENRECALL_PASSPHRASE` }),
      )
      expect(r.ready).toBe(false)
      expect(markerOf(r.ready ? '' : r.diagnostic)).toBe('misexpansion')
      // Same standard as the braced form: refused before anything is sent, so
      // the literal never reaches a server that would then hold entries under
      // a key nobody has.
      expect(s.hits).toEqual([])
    } finally {
      s.stop()
    }
  })

  test('a bare $VAR reference in the API key is refused as misexpansion', async () => {
    const r = await preflight(envFor({ OPENRECALL_API_KEY: `${'$'}OPENRECALL_API_KEY` }))
    expect(r.ready).toBe(false)
    expect(markerOf(r.ready ? '' : r.diagnostic)).toBe('misexpansion')
  })

  test('an unexpanded namespace is refused as misexpansion, in either spelling', async () => {
    // Not secret-bearing, so nothing is corrupted by it, but the diagnostic it
    // used to get came from the server: a 400 on the startup read, which reads
    // as a server problem and costs a round trip that carries the operator's
    // own config text to a third party's logs. There is no false-positive risk
    // to weigh against that, because the namespace grammar
    // (src/namespace.ts NAMESPACE_RE) has no `$` in it at all, so no legal
    // namespace can trip either rule.
    const outcomes: string[] = []
    for (const ns of [`${'$'}OPENRECALL_NAMESPACE`, `${'$'}{OPENRECALL_NAMESPACE}`]) {
      const s = stub(200, { version: 1, entryChecksums: {} })
      try {
        const r = await preflight(envFor({ OPENRECALL_URL: s.url, OPENRECALL_NAMESPACE: ns }))
        outcomes.push(
          `${ns} => ${r.ready ? 'ready' : markerOf(r.diagnostic)} hits:${s.hits.length}`,
        )
      } finally {
        s.stop()
      }
    }
    expect(outcomes).toEqual([
      `${'$'}OPENRECALL_NAMESPACE => misexpansion hits:0`,
      `${'$'}{OPENRECALL_NAMESPACE} => misexpansion hits:0`,
    ])
  })

  test('a legitimate secret containing a dollar sign is still accepted', async () => {
    // The load-bearing half of the bare-$VAR rule, and the reason it is
    // anchored to the whole value and to an all-caps identifier. A rule that
    // refused anything containing a `$`, or anything merely starting with one,
    // would pass every positive test above while locking a user out of the
    // memory only their passphrase can open. That is the more expensive of the
    // two errors: a service key can be reissued, a passphrase cannot.
    const D = '$'
    const legit = [
      `${D}Xk9!vQ2m-Zr4tW`, // password-manager output that happens to start with $
      `${D}OPENRECALL_PASSPHRASE and more`, // the reference is not the whole value
      `${D}secret`, // lowercase: not the all-caps shape a launcher config uses
      `${D}MixedCaseName`,
      `pa${D}${D}word`,
      `correct${D}horse${D}battery`,
      D,
      `${D}4DOLLARS`, // an identifier cannot start with a digit
      `${D} SPACED`,
      `two ${D}WORDS`,
    ]
    const outcomes: string[] = []
    for (const passphrase of legit) {
      const r = await preflight(
        envFor({ OPENRECALL_NAMESPACE: 'user:pf-dollar', OPENRECALL_PASSPHRASE: passphrase }),
      )
      outcomes.push(`${passphrase} => ${r.ready ? 'ready' : markerOf(r.diagnostic)}`)
    }
    expect(outcomes).toEqual(legit.map(p => `${p} => ready`))
  })

  test('a service key containing a dollar sign is still accepted', async () => {
    const D = '$'
    const legit = [`${D}Xk9!vQ2m-Zr4tW`, `${D}live-key`, `sk${D}${D}live`, `${D}4KEYS`]
    const outcomes: string[] = []
    for (const apiKey of legit) {
      const r = await preflight(
        envFor({ OPENRECALL_NAMESPACE: 'user:pf-dollar-key', OPENRECALL_API_KEY: apiKey }),
      )
      outcomes.push(`${apiKey} => ${r.ready ? 'ready' : markerOf(r.diagnostic)}`)
    }
    expect(outcomes).toEqual(legit.map(k => `${k} => ready`))
  })

  test('an unexpanded passphrase FILE reference is named as such, not as a bad path', async () => {
    // The realistic mistake once a host references the file: the variable was
    // never exported, so the host passes its own literal through. Refusing via
    // the unreadable-file branch is safe but tells the operator their path is
    // wrong when what is wrong is that they never set the variable, and the
    // path in the message is the template text they would then go looking for.
    const r = await preflight({
      OPENRECALL_URL: url,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal is the fixture.
      OPENRECALL_PASSPHRASE_FILE: '${OPENRECALL_PASSPHRASE_FILE}',
    })
    expect(r.ready).toBe(false)
    expect(markerOf(r.ready ? '' : r.diagnostic)).toBe('misexpansion')

    // Control: a real path that simply is not there still reads as a path
    // problem, so this distinguishes the two rather than calling every failure
    // a misexpansion.
    const real = await preflight({
      OPENRECALL_URL: url,
      OPENRECALL_PASSPHRASE_FILE: '/nope/passphrase',
    })
    expect(markerOf(real.ready ? '' : real.diagnostic)).toBe('passphrase-file')
  })

  test('the passphrase can come from a file, so it need not sit in the environment', async () => {
    // A host that launches this server spreads its own environment into every
    // stdio child it runs, so a passphrase exported for one server is readable
    // by all of them. A path is not: it is useless without read access to the
    // file, and a file can be locked down where an environment cannot.
    const dir = mkdtempSync(join(tmpdir(), 'openrecall-pf-'))
    const file = join(dir, 'passphrase')
    writeFileSync(file, `${PASSPHRASE}\n`, { mode: 0o600 })
    try {
      const ns = 'user:pf-from-file'
      await new OpenRecallClient({ url, passphrase: PASSPHRASE }).push(ns, { 'a.md': 'stored' })

      const r = await preflight({
        OPENRECALL_URL: url,
        OPENRECALL_NAMESPACE: ns,
        OPENRECALL_PASSPHRASE_FILE: file,
      })
      expect(r.ready).toBe(true)

      // The proof is that it decrypts what the value-supplied passphrase wrote,
      // not merely that startup was allowed to proceed.
      if (r.ready) expect(await r.client.entry(ns, 'a.md')).toBe('stored')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a passphrase file that is missing or empty is refused, naming the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openrecall-pf-'))
    const empty = join(dir, 'empty')
    writeFileSync(empty, '   \n')
    try {
      const gone = await preflight({
        OPENRECALL_URL: url,
        OPENRECALL_PASSPHRASE_FILE: join(dir, 'nope'),
      })
      expect(gone.ready).toBe(false)
      const goneText = gone.ready ? '' : gone.diagnostic
      expect(markerOf(goneText)).toBe('passphrase-file')
      expect(goneText).toContain('nope')

      const blank = await preflight({ OPENRECALL_URL: url, OPENRECALL_PASSPHRASE_FILE: empty })
      expect(blank.ready).toBe(false)
      const blankText = blank.ready ? '' : blank.diagnostic
      expect(markerOf(blankText)).toBe('passphrase-file')

      // The two are different faults needing different moves: one is a path or
      // a permission, the other is a file nobody wrote into. A diagnostic that
      // cannot tell them apart sends the operator to check the wrong thing, and
      // without this the read failure could quietly render as "empty".
      expect(goneText).toMatch(/could not be read/i)
      expect(blankText).toMatch(/is empty/i)
      expect(goneText).not.toMatch(/is empty/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the file wins over the variable, so a stale export cannot shadow it', async () => {
    // If both are set the file is the deliberate one: someone who moved the
    // secret out of the environment should not be silently overridden by a
    // leftover export of the old value.
    const dir = mkdtempSync(join(tmpdir(), 'openrecall-pf-'))
    const file = join(dir, 'passphrase')
    writeFileSync(file, PASSPHRASE)
    try {
      const ns = 'user:pf-precedence'
      await new OpenRecallClient({ url, passphrase: PASSPHRASE }).push(ns, { 'a.md': 'stored' })
      const r = await preflight({
        OPENRECALL_URL: url,
        OPENRECALL_NAMESPACE: ns,
        OPENRECALL_PASSPHRASE: 'the stale export',
        OPENRECALL_PASSPHRASE_FILE: file,
      })
      expect(r.ready).toBe(true)
      if (r.ready) expect(await r.client.entry(ns, 'a.md')).toBe('stored')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the passphrase read from a file never appears in a diagnostic', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openrecall-pf-'))
    const file = join(dir, 'passphrase')
    const SECRET = 'zzz-file-passphrase-must-not-appear-zzz'
    writeFileSync(file, SECRET)
    try {
      // A namespace written under a different key, so the read refuses.
      const ns = 'user:pf-leak'
      await new OpenRecallClient({ url, passphrase: PASSPHRASE }).push(ns, { 'a.md': 'stored' })
      const r = await preflight({
        OPENRECALL_URL: url,
        OPENRECALL_NAMESPACE: ns,
        OPENRECALL_PASSPHRASE_FILE: file,
      })
      expect(r.ready).toBe(false)
      const d = r.ready ? '' : r.diagnostic
      // Positive control: the refusal is the one we meant to trigger, so the
      // absence claim below is over text that was actually produced.
      expect(markerOf(d)).toBe('undecryptable')
      expect(d).not.toContain(SECRET)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a missing passphrase is refused as missing, not as misexpansion', async () => {
    const r = await preflight(envFor({ OPENRECALL_PASSPHRASE: '   ' }))
    expect(r.ready).toBe(false)
    expect(markerOf(r.ready ? '' : r.diagnostic)).toBe('missing-passphrase')
  })

  test('an unreachable URL is refused as transport, not as a refusal', async () => {
    const dead = Bun.serve({ port: 0, fetch: () => new Response('') })
    const deadUrl = `http://localhost:${dead.port}`
    dead.stop(true)
    const r = await preflight(envFor({ OPENRECALL_URL: deadUrl }))
    expect(r.ready).toBe(false)
    expect(markerOf(r.ready ? '' : r.diagnostic)).toBe('unreachable')
  })

  test('a 401 is refused as a rejected key and never as an empty namespace', async () => {
    const s = stub(401, { error: { code: 'unauthorized' } })
    try {
      const r = await preflight(envFor({ OPENRECALL_URL: s.url, OPENRECALL_API_KEY: 'nope' }))
      expect(r.ready).toBe(false)
      expect(markerOf(r.ready ? '' : r.diagnostic)).toBe('rejected-key')
      expect(s.hits.length).toBeGreaterThan(0)
    } finally {
      s.stop()
    }
  })

  test('a 403 is refused as an unauthorized namespace', async () => {
    const s = stub(403, { error: { code: 'forbidden' } })
    try {
      const r = await preflight(
        envFor({ OPENRECALL_URL: s.url, OPENRECALL_NAMESPACE: 'user:someone-else' }),
      )
      expect(r.ready).toBe(false)
      expect(markerOf(r.ready ? '' : r.diagnostic)).toBe('unauthorized-namespace')
    } finally {
      s.stop()
    }
  })

  test('a wrong passphrase is refused, and the namespace stays readable', async () => {
    const ns = 'user:pf-mixed'
    const good = new OpenRecallClient({ url, passphrase: PASSPHRASE })
    await good.push(ns, { 'note.md': 'the original plaintext' })

    const r = await preflight(envFor({ OPENRECALL_NAMESPACE: ns, OPENRECALL_PASSPHRASE: WRONG }))
    expect(r.ready).toBe(false)
    expect(markerOf(r.ready ? '' : r.diagnostic)).toBe('undecryptable')

    // The half that matters. A preflight that refused AND wrote would pass the
    // assertion above and still produce the mixed-key namespace R25 describes.
    const back = await new OpenRecallClient({ url, passphrase: PASSPHRASE }).pull(ns)
    expect(back.entries).toEqual({ 'note.md': 'the original plaintext' })
  })

  test('a wrong passphrase against an EMPTY namespace is ready, and that is correct', async () => {
    // Nothing exists to authenticate against, so no check can tell a wrong
    // passphrase from a first-run one. Starting is the right answer.
    const r = await preflight(
      envFor({ OPENRECALL_NAMESPACE: 'user:pf-empty-wrong', OPENRECALL_PASSPHRASE: WRONG }),
    )
    expect(r.ready).toBe(true)
  })

  test('a namespace whose listed entries cannot be served is refused, not called ready', async () => {
    // The false-pass this guard exists for. The server lists an entry in the
    // hashes view and serves no body for it (getData skips a manifest key whose
    // blob is gone, and drops its checksum with it), so `pull` decrypts nothing
    // and throws nothing. A preflight that only watched for a throw declared a
    // deliberately WRONG passphrase ready.
    const s = routeStub(req =>
      new URL(req.url).search.includes('view=hashes')
        ? json(200, {
            version: 3,
            entryChecksums: { 'note.md': 'deadbeef' },
            supports: ['entry-view'],
          })
        : json(503, { error: { code: 'entry_unreadable', message: 'blob gone' } }),
    )
    try {
      const r = await preflight(envFor({ OPENRECALL_URL: s.url, OPENRECALL_PASSPHRASE: WRONG }))
      expect(r.ready).toBe(false)
      expect(markerOf(r.ready ? '' : r.diagnostic)).toBe('unservable')
    } finally {
      s.stop()
    }
  })

  test('the proof reads one entry, not the whole namespace', async () => {
    // The whole point of the bounded read. A test that only asserts `ready`
    // cannot tell a single-entry probe from a full pull, so this counts what
    // crossed the wire: a regression back to `client.pull` fetches the bodies
    // of every entry and this goes red.
    const ns = 'user:pf-bounded'
    const entries: Record<string, string> = {}
    for (let i = 0; i < 4; i++) entries[`e${i}.md`] = `body ${i}`
    await new OpenRecallClient({ url, passphrase: PASSPHRASE }).push(ns, entries)

    const seen: string[] = []
    const s = routeStub(req => {
      const u = new URL(req.url)
      seen.push(u.search)
      return fetch(`${url}${u.pathname}${u.search}`)
    })
    try {
      const r = await preflight(envFor({ OPENRECALL_URL: s.url, OPENRECALL_NAMESPACE: ns }))
      expect(r.ready).toBe(true)
      // One bodyless hashes view, which both lists the namespace for the proof
      // and carries the precondition advertisement. Never the full read.
      expect(seen.filter(q => q.includes('view=hashes')).length).toBe(1)
      expect(seen.filter(q => q.includes('view=entry')).length).toBeGreaterThan(0)
      expect(seen.filter(q => q === '' || !q.includes('view='))).toEqual([])
      // Control: it stopped at the first entry that decrypted rather than
      // walking the namespace, which is the whole saving.
      expect(seen.filter(q => q.includes('view=entry')).length).toBe(1)
    } finally {
      s.stop()
    }
  })

  test('a namespace of unreadable entries is given up on, not walked to the end', async () => {
    // The cap, which the early-break test cannot reach: when the first key
    // decrypts the probe stops anyway, so removing PROBE_LIMIT changes nothing
    // there. It only bites when entries keep failing, which is exactly the case
    // where an unbounded probe would put the whole namespace back on the
    // startup path it was removed from.
    const listed: Record<string, string> = {}
    for (let i = 0; i < 20; i++) listed[`k${String(i).padStart(2, '0')}.md`] = 'sha256:aa'
    let entryReads = 0
    const s = routeStub(req => {
      const u = new URL(req.url)
      if (u.search.includes('view=hashes')) {
        return json(200, { version: 3, entryChecksums: listed, supports: ['entry-view'] })
      }
      entryReads += 1
      return json(503, { error: { code: 'entry_unreadable', message: 'blob gone' } })
    })
    try {
      const r = await preflight(envFor({ OPENRECALL_URL: s.url }))
      expect(r.ready).toBe(false)
      expect(markerOf(r.ready ? '' : r.diagnostic)).toBe('unservable')
      // The load-bearing half: bounded, not twenty.
      expect(entryReads).toBe(5)
    } finally {
      s.stop()
    }
  })

  test('drift found before the first readable entry is reported, and does not refuse', async () => {
    // Probing stops at the first entry that decrypts, so drift after it is not
    // seen at all. Drift BEFORE it is free to report, and is: the passphrase is
    // proven, so refusing would take memory away over a fault it is innocent
    // of, but passing in silence would hide a namespace losing entries.
    const s = routeStub(req => {
      const u = new URL(req.url)
      if (u.search.includes('view=hashes')) {
        return json(200, {
          version: 3,
          entryChecksums: { 'a.md': 'sha256:aa', 'b.md': 'sha256:bb' },
          supports: ['entry-view'],
        })
      }
      if (u.search.includes('key=a.md')) {
        return json(503, { error: { code: 'entry_unreadable', message: 'blob gone' } })
      }
      return fetch(`${url}${u.pathname}${u.search}`)
    })
    try {
      const real = new OpenRecallClient({ url, passphrase: PASSPHRASE })
      await real.push('user:pf-drift-first', { 'b.md': 'readable' })
      const r = await preflight(
        envFor({ OPENRECALL_URL: s.url, OPENRECALL_NAMESPACE: 'user:pf-drift-first' }),
      )
      expect(r.ready).toBe(true)
      expect(r.ready ? r.warnings.some(w => w.includes('a.md')) : false).toBe(true)
    } finally {
      s.stop()
    }
  })

  test('a server that answers nothing is refused as no answer, not as unreachable', async () => {
    // A hung server is a different fault from a refused one and from a server
    // that is not there: the connection was accepted, so the URL and the route
    // are fine and only the wait failed. Saying "cannot reach" would send an
    // operator to check DNS and firewalls for a server that answered them.
    const s = Bun.serve({ port: 0, idleTimeout: 0, fetch: () => new Promise(() => {}) })
    try {
      const r = await preflight(
        envFor({ OPENRECALL_URL: `http://localhost:${s.port}`, OPENRECALL_TIMEOUT_MS: '250' }),
      )
      expect(r.ready).toBe(false)
      expect(markerOf(r.ready ? '' : r.diagnostic)).toBe('no-answer')
    } finally {
      s.stop(true)
    }
  })

  test('an unexpanded API key does not claim it would corrupt the namespace', async () => {
    // A template service key gets a 401 and stores nothing. Telling an operator
    // it would write memory under an unreproducible key is the passphrase's
    // stake, and borrowing it here invites them to go looking at the wrong
    // value while their real problem is one line away.
    // Built rather than written literally so the file carries no template-curly
    // string for the linter to object to.
    const UNEXPANDED_PREFIX = `${'$'}{VAR}`
    const s = stub(200, { version: 1, entryChecksums: {}, supports: [] })
    try {
      const key = await preflight(
        envFor({ OPENRECALL_URL: s.url, OPENRECALL_API_KEY: `${UNEXPANDED_PREFIX}KEY` }),
      )
      const pass = await preflight(
        envFor({ OPENRECALL_URL: s.url, OPENRECALL_PASSPHRASE: `${UNEXPANDED_PREFIX}PASS` }),
      )
      expect(key.ready).toBe(false)
      expect(pass.ready).toBe(false)
      if (key.ready || pass.ready) return
      expect(markerOf(key.diagnostic)).toBe('misexpansion')
      expect(key.diagnostic).not.toContain('nobody can reproduce')
      // Control: the passphrase's stake is unchanged, so this asserts a real
      // difference rather than the sentence having been dropped everywhere.
      expect(pass.diagnostic).toContain('nobody can reproduce')
    } finally {
      s.stop()
    }
  })

  test('an unrecognized OPENRECALL_SCAN is refused, and the three real modes are not', async () => {
    // The value used to be cast straight to ScanMode, so `blcok` built a client
    // whose scanner was in no mode at all and quietly stopped blocking live
    // credentials. Nothing downstream would ever have said so.
    const bad = await preflight(
      envFor({ OPENRECALL_NAMESPACE: 'user:pf-scan', OPENRECALL_SCAN: 'blcok' }),
    )
    expect(bad.ready).toBe(false)
    expect(markerOf(bad.ready ? '' : bad.diagnostic)).toBe('invalid-scan-mode')

    // Negative control beside it: a guard that refused every value would pass
    // the assertion above on its own.
    const accepted: string[] = []
    for (const mode of ['block', 'warn', 'off', undefined]) {
      const r = await preflight(
        envFor({ OPENRECALL_NAMESPACE: 'user:pf-scan', OPENRECALL_SCAN: mode }),
      )
      accepted.push(`${mode}:${r.ready}`)
    }
    expect(accepted).toEqual(['block:true', 'warn:true', 'off:true', 'undefined:true'])
  })

  test('the validated scan mode is the one the client actually runs in', async () => {
    // Validation is worthless if it stops the value reaching the client, and a
    // default-vs-configured mix-up is invisible from the outside. `off` is the
    // mode only an explicit setting can produce, so this fails if the wiring is
    // dropped. AKIA... is the aws-access-key-id rule's shape.
    const leak = { 'k.md': 'AKIAIOSFODNN7EXAMPLE is the key' }
    const blocking = await preflight(envFor({ OPENRECALL_NAMESPACE: 'user:pf-scan-block' }))
    if (!blocking.ready) throw new Error(blocking.diagnostic)
    await expect(blocking.client.push('user:pf-scan-block', leak)).rejects.toThrow()

    const off = await preflight(
      envFor({ OPENRECALL_NAMESPACE: 'user:pf-scan-off', OPENRECALL_SCAN: 'off' }),
    )
    if (!off.ready) throw new Error(off.diagnostic)
    await off.client.push('user:pf-scan-off', leak)
  })

  test('a server that does not enforce the write precondition warns but still starts', async () => {
    // An older server is a supported deployment, so this can never refuse. It
    // is worth saying out loud though: that server accepts a save that
    // overwrites a newer entry without a word, and `preconditionEnforced` had
    // no caller anywhere, so nobody was ever told.
    const s = routeStub(() => json(200, { version: 0, entryChecksums: {}, supports: [] }))
    try {
      const old = await preflight(envFor({ OPENRECALL_URL: s.url }))
      expect(old.ready).toBe(true)
      expect(old.ready ? old.warnings.map(w => w.includes('write precondition')) : []).toEqual([
        true,
      ])
    } finally {
      s.stop()
    }
    // The other state, so this cannot pass by warning unconditionally: the real
    // server advertises the precondition and must draw no warning at all.
    const current = await preflight(envFor({ OPENRECALL_NAMESPACE: 'user:pf-empty' }))
    expect(current.ready ? current.warnings : ['not ready']).toEqual([])
  })

  test('a hostile entry key cannot forge lines or escapes in the diagnostic', async () => {
    // The undecryptable diagnostic names the entry that failed, which is useful
    // and is also text the server chose. Diagnostics land in a launcher's log,
    // where a newline plus an ANSI escape is a forged log line.
    const nasty = 'a.md\n\u001b[31m[openrecall mcp] ready'
    const s = routeStub(req =>
      new URL(req.url).search.includes('view=hashes')
        ? json(200, {
            version: 1,
            entryChecksums: { [nasty]: 'deadbeef' },
            supports: ['entry-view'],
          })
        : json(200, { version: 1, key: nasty, entry: 'AAAAAAAAAAAAAAAAAAAA' }),
    )
    try {
      const r = await preflight(envFor({ OPENRECALL_URL: s.url }))
      expect(markerOf(r.ready ? '' : r.diagnostic)).toBe('undecryptable')
      const d = r.ready ? '' : r.diagnostic
      // Positive control first: the key really is in there, so the two absence
      // assertions below are over text that was actually interpolated.
      expect(d).toContain('a.md')
      expect(d).not.toContain('\n')
      expect(d).not.toContain('\u001b')
    } finally {
      s.stop()
    }
  })

  test('a malformed read body is refused as a read failure, never as a wrong passphrase', async () => {
    // A truncated body, a socket dropped mid-transfer and a wrong key all
    // arrived here as one bare Error, so all three told the operator to change
    // OPENRECALL_PASSPHRASE. Following that advice after a transient failure is
    // exactly how the mixed-key namespace this file prevents gets created.
    // `content` missing makes `pull` throw a TypeError, which is not a
    // OpenRecallDecryptError and must not be reported as one.
    const s = routeStub(req =>
      new URL(req.url).search.includes('view=hashes')
        ? json(200, {
            version: 1,
            entryChecksums: { 'note.md': 'deadbeef' },
            supports: ['entry-view'],
          })
        : json(200, { version: 1 }),
    )
    try {
      const r = await preflight(envFor({ OPENRECALL_URL: s.url }))
      expect(r.ready).toBe(false)
      expect(markerOf(r.ready ? '' : r.diagnostic)).toBe('read-failed')
      // The specific harm, spelled out: this diagnostic must not send the
      // operator to their passphrase.
      expect(r.ready ? '' : r.diagnostic).not.toContain('cannot decrypt')
    } finally {
      s.stop()
    }
  })
})

/**
 * Launch the real CLI and read stderr until the ready line appears. Returns the
 * live child, so the caller can assert on stdout and then kill it.
 */
async function launchUntilReady(env: Record<string, string>, timeoutMs = 20000) {
  const run = Bun.spawn(['bun', 'run', 'bin/openrecall.ts', 'mcp'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, ...env },
    // Kept open on purpose: this is the MCP protocol channel, and a closed
    // stdin would end the transport the test is trying to watch come up.
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const reader = run.stderr.getReader()
  const dec = new TextDecoder()
  let err = ''
  const untilReady = (async () => {
    while (!err.includes('[openrecall mcp] ready')) {
      const { value, done } = await reader.read()
      if (done) return
      err += dec.decode(value, { stream: true })
    }
  })()
  await Promise.race([
    untilReady,
    Bun.sleep(timeoutMs).then(() => {
      run.kill()
      throw new Error(`no ready line in ${timeoutMs}ms; stderr so far: ${err}`)
    }),
  ])
  return { run, err }
}

describe('mcp stdio launch', () => {
  test('a valid configuration reaches ready with nothing on stdout', async () => {
    // The success half of this file. Every other case here stops inside
    // preflight, so tool registration and the transport connect were never
    // executed by any test at all.
    const canary = Bun.spawn(['bun', '-e', 'console.log("canary")'], { stdout: 'pipe' })
    expect(await new Response(canary.stdout).text()).toContain('canary')

    const { run, err } = await launchUntilReady({
      OPENRECALL_URL: url,
      OPENRECALL_NAMESPACE: 'user:pf-launch',
      OPENRECALL_PASSPHRASE: PASSPHRASE,
    })
    expect(err).toContain('[openrecall mcp] ready')
    // Against the current server there is nothing to warn about, so the
    // warning line must be absent here as well as present in the test below.
    expect(err).not.toContain('write precondition')
    run.kill()
    // Read after the kill: the stream ends, and everything the child ever wrote
    // to stdout up to and past the transport connect is in it.
    expect(await new Response(run.stdout).text()).toBe('')
    await run.exited
  }, 30000)

  test('a startup warning reaches stderr, and does not stop the server coming up', async () => {
    const s = routeStub(() => json(200, { version: 0, entryChecksums: {}, supports: [] }))
    try {
      const { run, err } = await launchUntilReady({
        OPENRECALL_URL: s.url,
        OPENRECALL_NAMESPACE: 'user:pf-launch-old',
        OPENRECALL_PASSPHRASE: PASSPHRASE,
      })
      expect(err).toContain('does not enforce the write precondition')
      expect(err).toContain('[openrecall mcp] ready')
      run.kill()
      expect(await new Response(run.stdout).text()).toBe('')
      await run.exited
    } finally {
      s.stop()
    }
  }, 30000)

  test('a wrong passphrase exits non-zero with nothing on stdout', async () => {
    const ns = 'user:pf-stdio'
    await new OpenRecallClient({ url, passphrase: PASSPHRASE }).push(ns, { 'x.md': 'body' })

    // Prove the capture can see stdout at all. Without this an empty capture
    // and a broken capture are indistinguishable.
    const canary = Bun.spawn(['bun', '-e', 'console.log("canary")'], { stdout: 'pipe' })
    expect(await new Response(canary.stdout).text()).toContain('canary')

    // Spawned asynchronously on purpose: the child talks to the Bun.serve above,
    // which runs on THIS event loop, so a synchronous spawn deadlocks.
    const run = Bun.spawn(['bun', 'run', 'bin/openrecall.ts', 'mcp'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env,
        OPENRECALL_URL: url,
        OPENRECALL_NAMESPACE: ns,
        OPENRECALL_PASSPHRASE: WRONG,
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, errText, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ])
    expect(out).toBe('')
    expect(markerOf(errText)).toBe('undecryptable')
    expect(code).toBe(1)
  })
})

describe('startup configuration and probe branches', () => {
  test('a malformed OPENRECALL_TIMEOUT_MS is refused by name, not blamed on the network', async () => {
    for (const bad of ['-5', 'abc', '0', 'Infinity', '1e20', '99999999999']) {
      const r = await preflight(envFor({ OPENRECALL_TIMEOUT_MS: bad }))
      expect(`${bad}: ready=${r.ready}`).toBe(`${bad}: ready=false`)
      const text = r.ready ? '' : r.diagnostic
      expect(text).toContain('OPENRECALL_TIMEOUT_MS')
      expect(text).not.toContain('cannot reach')
    }
    // Control: a sane value starts.
    const ok = await preflight(
      envFor({ OPENRECALL_NAMESPACE: 'user:pf-timeout-ok', OPENRECALL_TIMEOUT_MS: '5000' }),
    )
    expect(ok.ready).toBe(true)
  })

  test('the setup card placeholder is refused as template text, not used as the passphrase', async () => {
    for (const placeholder of ['<paste your passphrase here>', '<your passphrase>']) {
      const r = await preflight(envFor({ OPENRECALL_PASSPHRASE: placeholder }))
      expect(r.ready).toBe(false)
      expect(markerOf(r.ready ? '' : r.diagnostic)).toBe('misexpansion')
    }
    // Control: an angle bracket inside a real passphrase is not a placeholder.
    const ok = await preflight(
      envFor({ OPENRECALL_PASSPHRASE: 'a<b>c d', OPENRECALL_NAMESPACE: 'user:pf-angle' }),
    )
    expect(ok.ready).toBe(true)
  })

  test('a server that does not advertise entry-view is probed with the full read and still starts', async () => {
    const ns = 'user:pf-old-server'
    await new OpenRecallClient({ url, passphrase: PASSPHRASE }).push(ns, { 'a.md': 'hi' })
    const seen: string[] = []
    const s = routeStub(req => {
      const u = new URL(req.url)
      seen.push(u.search)
      if (u.search.includes('view=hashes')) {
        // What an older server would say: no capabilities.
        return json(200, { version: 1, entryChecksums: { 'a.md': 'sha256:aa' }, supports: [] })
      }
      return fetch(`${url}${u.pathname}${u.search}`)
    })
    try {
      const r = await preflight(envFor({ OPENRECALL_URL: s.url, OPENRECALL_NAMESPACE: ns }))
      expect(r.ready).toBe(true)
      expect(seen.filter(q => q.includes('view=entry')).length).toBe(0)
      expect(seen.some(q => q === '')).toBe(true)
      // And it says the precondition is not enforced, since it advertised nothing.
      expect(r.ready ? r.warnings.some(w => w.includes('write precondition')) : false).toBe(true)
    } finally {
      s.stop()
    }
  })

  test('an entry read that never answers is a no-answer refusal, an unmapped status is a server refusal', async () => {
    const listed = { 'a.md': 'sha256:aa' }
    const hang = routeStub(req => {
      if (new URL(req.url).search.includes('view=hashes')) {
        return json(200, { version: 1, entryChecksums: listed, supports: ['entry-view'] })
      }
      return new Promise<Response>(() => {})
    })
    const boom = routeStub(req => {
      if (new URL(req.url).search.includes('view=hashes')) {
        return json(200, { version: 1, entryChecksums: listed, supports: ['entry-view'] })
      }
      return json(500, { error: { code: 'internal', message: 'boom' } })
    })
    try {
      const slow = await preflight(
        envFor({ OPENRECALL_URL: hang.url, OPENRECALL_TIMEOUT_MS: '250' }),
      )
      expect(markerOf(slow.ready ? '' : slow.diagnostic)).toBe('no-answer')
      const bad = await preflight(envFor({ OPENRECALL_URL: boom.url }))
      expect(markerOf(bad.ready ? '' : bad.diagnostic)).toBe('server-refused')
    } finally {
      hang.stop()
      boom.stop()
    }
  })

  test('entry_not_found for a listed key is drift: it starts with a warning only when another entry decrypts', async () => {
    const ns = 'user:pf-notfound'
    await new OpenRecallClient({ url, passphrase: PASSPHRASE }).push(ns, { 'b.md': 'readable' })
    const s = routeStub(req => {
      const u = new URL(req.url)
      if (u.search.includes('view=hashes')) {
        return json(200, {
          version: 2,
          entryChecksums: { 'a.md': 'sha256:aa', 'b.md': 'sha256:bb' },
          supports: ['entry-view'],
        })
      }
      if (u.search.includes('key=a.md')) {
        return json(404, { error: { code: 'entry_not_found', message: 'gone' } })
      }
      return fetch(`${url}${u.pathname}${u.search}`)
    })
    try {
      const r = await preflight(envFor({ OPENRECALL_URL: s.url, OPENRECALL_NAMESPACE: ns }))
      expect(r.ready).toBe(true)
      expect(r.ready ? r.warnings.some(w => w.includes('a.md')) : false).toBe(true)
    } finally {
      s.stop()
    }
  })
})
