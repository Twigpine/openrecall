/**
 * The client's half of the write precondition.
 *
 * The server refuses a write whose base disagrees with the manifest, but that
 * is worth nothing until a client sends one. The subtlety is which read fills
 * the base: `push` performs its own hashes call immediately before the PUT, so
 * a base taken from there is milliseconds old and guards a window that barely
 * exists. The window that matters is the caller's own turn, so only reads the
 * caller asked for fill the map.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { namespaceSlug } from '../src/namespace.ts'
import { _reset } from '../src/ratelimit.ts'
import { contentPath, getStore, manifestPath } from '../src/store/index.ts'

let server: ReturnType<typeof Bun.serve>
let base: string
let OpenRecallClient: typeof import('../client/index.ts').OpenRecallClient
let OpenRecallHttpError: typeof import('../client/index.ts').OpenRecallHttpError
let OpenRecallDecryptError: typeof import('../client/index.ts').OpenRecallDecryptError
let OpenRecallTimeoutError: typeof import('../client/index.ts').OpenRecallTimeoutError
let DEFAULT_TIMEOUT_MS: number
let MAX_TRACKED_NAMESPACES: number

beforeAll(async () => {
  const { handleRequest } = await import('../src/handler.ts')
  ;({
    OpenRecallClient,
    OpenRecallHttpError,
    OpenRecallDecryptError,
    OpenRecallTimeoutError,
    DEFAULT_TIMEOUT_MS,
    MAX_TRACKED_NAMESPACES,
  } = await import('../client/index.ts'))
  server = Bun.serve({ port: 0, fetch: handleRequest })
  base = `http://localhost:${server.port}`
})
afterAll(() => server?.stop(true))
afterEach(() => _reset())

const client = () => new OpenRecallClient({ url: base, passphrase: 'pw' })

/** A server that answers every request with one canned refusal. */
function denyingServer(status: number, code: string) {
  return Bun.serve({
    port: 0,
    fetch: () =>
      new Response(JSON.stringify({ error: { code, message: 'nope' } }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  })
}

describe('base carriage', () => {
  test('a push from a stale read is refused, and the competing write survives', async () => {
    const ns = 'user:cb-stale'
    const a = client()
    const b = client()
    await a.push(ns, { 'a.md': 'v1' })

    // A reads. This is the read its edit is based on.
    await a.pull(ns)
    // B writes underneath it.
    await b.push(ns, { 'a.md': 'from-b' })

    const err = await a.push(ns, { 'a.md': 'from-a' }).catch(e => e)
    expect(err).toBeInstanceOf(OpenRecallHttpError)
    expect((err as InstanceType<typeof OpenRecallHttpError>).code).toBe('stale_base_version')
    expect((await b.pull(ns)).entries['a.md']).toBe('from-b')
  })

  test('re-reading before the push makes it succeed', async () => {
    const ns = 'user:cb-fresh'
    const a = client()
    const b = client()
    await a.push(ns, { 'a.md': 'v1' })
    await a.pull(ns)
    await b.push(ns, { 'a.md': 'from-b' })

    // Control for the test above: the only difference is this re-read.
    await a.pull(ns)
    await a.push(ns, { 'a.md': 'from-a' })
    expect((await b.pull(ns)).entries['a.md']).toBe('from-a')
  })

  test('a first write into a namespace this client never read still succeeds', async () => {
    const ns = 'user:cb-new'
    await client().push(ns, { 'a.md': 'first' })
    expect((await client().pull(ns)).entries['a.md']).toBe('first')
  })

  test('a delete after a foreign change is refused, and succeeds after a re-read', async () => {
    const ns = 'user:cb-del'
    const a = client()
    const b = client()
    await a.push(ns, { 'a.md': 'v1' })
    await a.pull(ns)
    await b.push(ns, { 'a.md': 'moved' })

    const err = await a.delete(ns, 'a.md').catch(e => e)
    expect(err).toBeInstanceOf(OpenRecallHttpError)
    expect((err as InstanceType<typeof OpenRecallHttpError>).code).toBe('stale_base_version')

    await a.pull(ns)
    await a.delete(ns, 'a.md')
    expect(Object.keys((await b.pull(ns)).entries)).toEqual([])
  })

  test("push's own pre-flight read does not refresh the base it is meant to check", async () => {
    // The whole point. If the internal hashes call filled the map, the base
    // would always be current and the refusal above could never fire.
    const ns = 'user:cb-preflight'
    const a = client()
    const b = client()
    await a.push(ns, { 'a.md': 'v1' })
    await a.pull(ns)
    await b.push(ns, { 'a.md': 'from-b' })
    // A push whose only read of this namespace since is push's own internal one.
    const err = await a.push(ns, { 'a.md': 'from-a' }).catch(e => e)
    expect(err).toBeInstanceOf(OpenRecallHttpError)
  })
})

describe('typed refusals', () => {
  test('each refusal surfaces its status and code', async () => {
    for (const [status, code] of [
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [413, 'namespace_too_large'],
      [429, 'rate_limited'],
    ] as const) {
      const s = denyingServer(status, code)
      const c = new OpenRecallClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
      const err = await c.pull('user:x').catch(e => e)
      s.stop(true)
      expect(err).toBeInstanceOf(OpenRecallHttpError)
      expect((err as InstanceType<typeof OpenRecallHttpError>).status).toBe(status)
      expect((err as InstanceType<typeof OpenRecallHttpError>).code).toBe(code)
    }
  })

  test('a 404 that is not the server saying empty is an error, not an empty namespace', async () => {
    // The denial-rendered-as-success shape: a wrong URL or a proxy 404 must not
    // reach a caller as a successful read of nothing.
    const s = denyingServer(404, 'not_found')
    const c = new OpenRecallClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
    const err = await c.pull('user:x').catch(e => e)
    s.stop(true)
    expect(err).toBeInstanceOf(OpenRecallHttpError)

    // Control: the server's own empty response still reads as an empty namespace.
    const fresh = await client().pull('user:cb-never-written')
    expect(fresh.entries).toEqual({})
  })

  test('a stale-write refusal carries the base this client actually sent', async () => {
    // KTD3 asks the 409 text to name the base sent alongside the current hash.
    // The server's payload only reports what each key holds NOW, so without
    // this the client is the only party that knows what it wrote against and
    // the information is lost at the throw.
    const a = client()
    const b = client()
    const ns = 'user:cb-sentbase'

    await a.push(ns, { 'x.md': 'one' })
    await a.pull(ns)
    const stale = (await a.hashes(ns))['x.md']
    await b.pull(ns)
    await b.push(ns, { 'x.md': 'two' })

    const err = await a.push(ns, { 'x.md': 'three' }).catch(e => e)
    expect(err).toBeInstanceOf(OpenRecallHttpError)
    expect(err.status).toBe(409)
    expect(err.details?.sentBase).toEqual({ 'x.md': stale })
  })

  test('a no-op push reads once and reports that read version', async () => {
    // push already reads the namespace to compute the delta, and that read
    // carries the version. Asking again was a second round trip on the most
    // common write an agent makes (re-saving a fact that has not changed), and
    // the second read had its own 404 rule that returned version 0 for any
    // 404, turning a denial into a successful no-op write.
    let hits = 0
    const s = Bun.serve({
      port: 0,
      fetch: () => {
        hits += 1
        return new Response(JSON.stringify({ version: 7, entryChecksums: {}, supports: [] }), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    const c = new OpenRecallClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
    const r = await c.push('user:x', {})
    s.stop(true)
    expect(hits).toBe(1)
    expect(r.version).toBe(7)
  })

  test('a pull of an empty namespace enumerates it, so a create asserts absence', async () => {
    // A pull is normally not authoritative, because getData silently skips an
    // entry whose blob is missing and a drifted key must not be asserted
    // absent. The server's own `empty` answer is the one exception: it means no
    // manifest exists at all, so there is nothing to drift and the namespace is
    // genuinely empty. Without this, a create after pulling an empty namespace
    // sends no base and silently overwrites whatever landed in between.
    const ns = 'user:cb-empty-enum'
    const a = client()
    const b = client()
    expect(await a.pull(ns)).toMatchObject({ entries: {} })

    await b.push(ns, { 'k.md': 'from b' })
    const err = await a.push(ns, { 'k.md': 'from a' }).catch(e => e)
    expect(err).toBeInstanceOf(OpenRecallHttpError)
    expect(err.status).toBe(409)

    // Control: b's write survived, so the refusal protected it rather than
    // failing for some unrelated reason.
    expect((await b.pull(ns)).entries['k.md']).toBe('from b')
  })

  test('the same rule holds on the hashes path, which has its own guard', async () => {
    // pull and the hashes view each decide what a 404 means, so each needs
    // covering; a fix applied to one is not a fix applied to both.
    const s = denyingServer(404, 'not_found')
    const c = new OpenRecallClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
    const err = await c.hashes('user:x').catch(e => e)
    s.stop(true)
    expect(err).toBeInstanceOf(OpenRecallHttpError)

    // Control: a namespace the real server has never seen still reads as empty.
    expect(await client().hashes('user:cb-hashes-empty')).toEqual({})
  })
})

describe('precondition advertisement', () => {
  test('a server that does not advertise it is reported as not enforcing', async () => {
    const s = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ version: 1, entryChecksums: {}, erasure: 'erases' }), {
          headers: { 'content-type': 'application/json' },
        }),
    })
    const c = new OpenRecallClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
    expect((await c.hashesAndSupports('user:x')).supports).not.toContain('base-precondition')
    s.stop(true)

    // Control: the real server does advertise it.
    expect((await client().hashesAndSupports('user:cb-adv')).supports).toContain(
      'base-precondition',
    )
  })
})

// ─── The observed-map rework ────────────────────────────────────────────
//
// The map used to conflate three states into one: never read, read-and-present,
// read-and-absent. Presence of the map meant "read" and a missing key meant
// "absent". Each test below pins one consequence of splitting that apart into
// a key->hash map plus whether the source enumerated the namespace.

/**
 * The real server as an older release presents itself: the hashes view with
 * no capabilities and no timestamps, and no bulk view. Everything else is
 * passed through, so the full view is the real full view.
 */
function legacyProxy(upstream: string) {
  const searches: string[] = []
  const s = Bun.serve({
    port: 0,
    fetch: async req => {
      const u = new URL(req.url)
      searches.push(u.search)
      if (req.method === 'POST') return new Response(null, { status: 405 })
      const res = await fetch(`${upstream}${u.pathname}${u.search}`, {
        method: req.method,
        headers: req.headers,
        body: req.method === 'GET' || req.method === 'DELETE' ? undefined : await req.text(),
      })
      if (u.searchParams.get('view') !== 'hashes' || !res.ok) return res
      const {
        supports: _s,
        entryUpdatedAt: _t,
        ...rest
      } = (await res.json()) as Record<string, unknown>
      return Response.json({ ...rest, supports: [] })
    },
  })
  return { url: `http://localhost:${s.port}`, searches, stop: () => s.stop(true) }
}

/** A server that answers every request with one canned body, verbatim. */
function rawServer(status: number, body: string, contentType = 'application/json') {
  return Bun.serve({
    port: 0,
    fetch: () => new Response(body, { status, headers: { 'content-type': contentType } }),
  })
}

describe('observed knowledge', () => {
  test('a key whose blob is missing is not locked out of every future write', async () => {
    // getData skips an entry whose blob has gone (manifest/blob drift) and does
    // not populate entryChecksums for it either, so a pull cannot learn the key
    // exists at all. Treating pull as authoritative made the client assert the
    // key absent, and the server refused that base forever.
    const ns = 'user:cb-drift'
    const a = client()
    await a.push(ns, { 'a.md': 'v1' })

    const slug = namespaceSlug(ns)
    const raw = await getStore().get(manifestPath(slug))
    const manifest = JSON.parse(new TextDecoder().decode(raw as Uint8Array)) as {
      entries: Record<string, { hash: string }>
    }
    await getStore().delete(contentPath(slug, manifest.entries['a.md'].hash))

    // Confirm the drift actually landed: a plant that did not apply would make
    // the rest of this test prove nothing.
    expect((await a.pull(ns)).entries).toEqual({})

    await a.push(ns, { 'a.md': 'v2' })
    expect((await a.pull(ns)).entries['a.md']).toBe('v2')
  })

  test('a hashes read enumerates, so a key it did not name is asserted absent', async () => {
    // Deliberate, and flagged in review as possibly over-broad: hashes returns
    // no content, but its checksums ARE the manifest's and the base IS a
    // ciphertext hash, so for this purpose the read is exact.
    const ns = 'user:cb-enum-hashes'
    const a = client()
    const b = client()
    expect(await a.hashes(ns)).toEqual({})
    await b.push(ns, { 'x.md': 'from-b' })

    const err = await a.push(ns, { 'x.md': 'from-a' }).catch(e => e)
    expect(err).toBeInstanceOf(OpenRecallHttpError)
    expect((err as InstanceType<typeof OpenRecallHttpError>).code).toBe('stale_base_version')
    expect((await b.pull(ns)).entries['x.md']).toBe('from-b')
  })

  test('a full-view pull does not enumerate, so a key it did not return is left unasserted', async () => {
    // The negative half of the rule above, and the reason the drift test can
    // pass: a pull through the full view carries positive knowledge only,
    // because getData drops an entry whose blob is missing and the client
    // cannot tell that from a key that was never there. The full view is what
    // a server advertising neither entry view gets, so that server is stood
    // up here: the real one, behind a proxy that strips what it advertises.
    const ns = 'user:cb-enum-pull'
    const legacy = legacyProxy(base)
    try {
      const a = new OpenRecallClient({ url: legacy.url, passphrase: 'pw' })
      const b = client()
      await a.push(ns, { 'seed.md': 'seed' })
      expect(Object.keys((await a.pull(ns)).entries)).toEqual(['seed.md'])
      expect(legacy.searches).toContain('')

      await b.pull(ns)
      await b.push(ns, { 'x.md': 'from-b' })

      // a never saw x.md, and cannot honestly claim it does not exist, so the
      // write is unconditional rather than refused.
      await a.push(ns, { 'x.md': 'from-a' })
      expect((await b.pull(ns)).entries['x.md']).toBe('from-a')
    } finally {
      legacy.stop()
    }
  })

  test('an incremental pull enumerates, so a key it did not return is asserted absent', async () => {
    // The counterpart against the real server, which advertises the entry
    // views: the pull starts from the hashes view, which lists the manifest
    // entire, so a key missing from it provably does not exist and the next
    // write may say so. The drift case that made the full view honest-only is
    // covered in tests/client-sync.test.ts: a drifted key is still in the
    // hashes view with its manifest hash, so it is never asserted absent.
    const ns = 'user:cb-enum-incremental'
    const a = client()
    const b = client()
    await a.push(ns, { 'seed.md': 'seed' })
    expect(Object.keys((await a.pull(ns)).entries)).toEqual(['seed.md'])

    await b.pull(ns)
    await b.push(ns, { 'x.md': 'from-b' })

    const err = await a.push(ns, { 'x.md': 'from-a' }).catch(e => e)
    expect(err).toBeInstanceOf(OpenRecallHttpError)
    expect((err as InstanceType<typeof OpenRecallHttpError>).code).toBe('stale_base_version')
    expect((await b.pull(ns)).entries['x.md']).toBe('from-b')
  })

  test('a write into a never-read namespace arms the precondition for the next one', async () => {
    // The whole feature failing: record used to no-op when no map existed, so a
    // write-only client never got a base and its second push clobbered whatever
    // had landed in between.
    const ns = 'user:cb-writeonly'
    const a = client()
    const b = client()
    await a.push(ns, { 'k.md': 'one' })

    await b.pull(ns)
    await b.push(ns, { 'k.md': 'from-b' })

    const err = await a.push(ns, { 'k.md': 'two' }).catch(e => e)
    expect(err).toBeInstanceOf(OpenRecallHttpError)
    expect((err as InstanceType<typeof OpenRecallHttpError>).code).toBe('stale_base_version')
    expect((await b.pull(ns)).entries['k.md']).toBe('from-b')
  })

  test('a key this client created is armed even though the read never saw it', async () => {
    // Isolates the written fold from the map-creation branch above: a map
    // already exists here (the pull made one), so only folding the written hash
    // in can arm the second push.
    const ns = 'user:cb-created'
    const a = client()
    const b = client()
    expect((await a.pull(ns)).entries).toEqual({})
    await a.push(ns, { 'k.md': 'mine' })

    await b.pull(ns)
    await b.push(ns, { 'k.md': 'from-b' })

    const err = await a.push(ns, { 'k.md': 'mine-again' }).catch(e => e)
    expect(err).toBeInstanceOf(OpenRecallHttpError)
    expect((err as InstanceType<typeof OpenRecallHttpError>).code).toBe('stale_base_version')
    expect((await b.pull(ns)).entries['k.md']).toBe('from-b')
  })

  test('a deleted key is dropped from the map, so recreating it is unconditional', async () => {
    // The other fold in record. Left in the map, the stale hash becomes the base
    // for the recreate and the server refuses a write nothing is racing.
    const ns = 'user:cb-recreate'
    const a = client()
    await a.push(ns, { 'k.md': 'one' })
    await a.pull(ns)
    await a.delete(ns, 'k.md')

    await a.push(ns, { 'k.md': 'again' })
    expect((await a.pull(ns)).entries['k.md']).toBe('again')
  })

  test('a delete of a key observed absent asserts that absence', async () => {
    // DELETE's base rides the query string and the server spells it only as
    // sha256:<hex>, so this one has to route through PUT to carry a JSON null.
    const ns = 'user:cb-del-absent'
    const a = client()
    const b = client()
    expect(await a.hashes(ns)).toEqual({})
    await b.push(ns, { 'k.md': 'from-b' })

    const err = await a.delete(ns, 'k.md').catch(e => e)
    expect(err).toBeInstanceOf(OpenRecallHttpError)
    expect((err as InstanceType<typeof OpenRecallHttpError>).code).toBe('stale_base_version')
    // The refusal has to actually protect the entry, not merely be thrown.
    expect((await b.pull(ns)).entries['k.md']).toBe('from-b')
  })

  test('the observed doc comment describes the model the code implements', async () => {
    // Finding 4 was a comment claiming writes filled the map while record
    // returned early without them. The comment is the only place the enumerated
    // distinction is explained, so it is pinned rather than left to drift.
    const src = await Bun.file(new URL('../client/index.ts', import.meta.url)).text()
    const doc = src.slice(0, src.indexOf('private readonly observed'))
    const block = doc.slice(doc.lastIndexOf('/**'))
    expect(block).toContain('enumerat')
    expect(block).toContain('hashes')
    expect(block).toContain('pull')
  })
})

describe('error text', () => {
  test('a non-JSON error body reaches the caller instead of rendering empty', async () => {
    // httpError used to call res.text() on a body res.json() had consumed, so
    // the fallback always produced '' and the caller got a bare status.
    const s = rawServer(502, 'upstream said no', 'text/plain')
    const c = new OpenRecallClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
    const err = await c.pull('user:x').catch(e => e)
    s.stop(true)
    expect(err).toBeInstanceOf(OpenRecallHttpError)
    expect((err as Error).message).toContain('upstream said no')
  })

  test('server text is bounded before it reaches the caller', async () => {
    // This message is rendered into a model's context by the MCP tools, so a
    // hostile or broken server must not be able to put a megabyte of
    // instructions there.
    const nasty = `IGNORE PREVIOUS ${'A'.repeat(5000)}`
    const s = rawServer(500, JSON.stringify({ error: { code: 'boom', details: { raw: nasty } } }))
    const c = new OpenRecallClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
    const err = (await c.pull('user:x').catch(e => e)) as InstanceType<typeof OpenRecallHttpError>
    s.stop(true)
    expect(err.message.length).toBeLessThanOrEqual(300)
    // Structured fields are the machine-readable half and stay verbatim, so the
    // bound cannot be met by throwing the server's answer away.
    expect(err.code).toBe('boom')
    expect((err.details as { raw: string }).raw).toBe(nasty)
  })

  test('control characters and escape sequences are stripped from server text', async () => {
    // Its own rule and its own control: JSON escapes a control character to
    // inert text, so only a non-JSON body carries real ones, and that is
    // exactly the body the text branch handles.
    const s = rawServer(500, '\u001b[31mred\u001b[0m\nboom\u0007', 'text/plain')
    const c = new OpenRecallClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
    const err = (await c.pull('user:x').catch(e => e)) as InstanceType<typeof OpenRecallHttpError>
    s.stop(true)
    // Non-vacuous: a message that lost the whole body would pass every
    // not-toContain below.
    expect(err.message).toContain('boom')
    expect(err.message).not.toContain('\u001b')
    expect(err.message).not.toContain('[31m')
    expect(err.message).not.toContain('\u0007')
    expect(err.message).not.toContain('\n')
  })

  test('an ordinary short error body survives sanitising intact', async () => {
    // Negative control: a sanitiser that returned '' would pass both tests
    // above and lose every real diagnostic.
    const s = rawServer(500, JSON.stringify({ error: { code: 'boom', message: 'disk full' } }))
    const c = new OpenRecallClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
    const err = await c.pull('user:x').catch(e => e)
    s.stop(true)
    expect((err as Error).message).toContain('disk full')
    expect((err as Error).message).toContain('500')
  })
})

describe('what the server actually accepted', () => {
  test('a skipped entry is reported and kept out of uploaded', async () => {
    const ns = 'user:cb-skipped'
    const a = client()
    const r = await a.push(ns, { 'good.md': 'g', '../evil.md': 'e' })
    expect(r.skipped).toEqual([{ key: '../evil.md', reason: 'invalid_key' }])
    expect(r.uploaded).toEqual(['good.md'])
  })

  test('a skipped entry does not poison the base for the next write', async () => {
    // Recording a hash for content the server never stored makes the next write
    // for that same key send a base for something that does not exist, and the
    // server refuses it. Re-pushing the key is the only path that consults it:
    // baseFor only covers the keys a write touches, so pushing some OTHER key
    // afterwards would look fine while the refused one stayed locked out.
    const ns = 'user:cb-skipped-base'
    const a = client()
    await a.push(ns, { 'good.md': 'g', '../evil.md': 'e' })

    const again = await a.push(ns, { '../evil.md': 'e2' })
    expect(again.skipped).toEqual([{ key: '../evil.md', reason: 'invalid_key' }])
    // And the namespace is still writable for the key that did land.
    await a.push(ns, { 'good.md': 'g2' })
    expect((await a.pull(ns)).entries['good.md']).toBe('g2')
  })
})

describe('typed decrypt failure', () => {
  test('a wrong passphrase is a decrypt error naming the entry, not a transport error', async () => {
    const ns = 'user:cb-decrypt'
    await client().push(ns, { 'a.md': 'secret' })
    const wrong = new OpenRecallClient({ url: base, passphrase: 'not-the-passphrase' })

    const err = await wrong.pull(ns).catch(e => e)
    expect(err).toBeInstanceOf(OpenRecallDecryptError)
    expect((err as InstanceType<typeof OpenRecallDecryptError>).entryKey).toBe('a.md')
    expect((err as Error).message).toContain('a.md')
  })

  test('a transport failure is not reported as a decrypt error', async () => {
    // Negative control: the distinction is the point, so a class that captured
    // every failure would be worth nothing.
    const s = denyingServer(500, 'internal')
    const c = new OpenRecallClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
    const err = await c.pull('user:x').catch(e => e)
    s.stop(true)
    expect(err).not.toBeInstanceOf(OpenRecallDecryptError)
    expect(err).toBeInstanceOf(OpenRecallHttpError)
  })
})

// ─── Bounded waits ──────────────────────────────────────────────────────
//
// A server that completes the TCP handshake and then never answers used to
// hang the caller forever, on every one of the five fetch call sites. The MCP
// server feels it worst: its startup preflight blocks on two of them before it
// serves anything, so the subprocess sits there with no output and no exit,
// which is worse than any refusal it could have printed.

/**
 * A server that answers GET with a valid hashes view and stalls on everything
 * else, so a stall can be aimed at the PUT/DELETE half of a flow whose earlier
 * GET has to succeed for the call to reach it.
 */
function stallingServer(stall: (req: Request) => boolean) {
  return Bun.serve({
    port: 0,
    // Bun.serve otherwise closes an idle request after 10s, which would end the
    // wait for the client and leave the test unable to tell a client-side
    // timeout from a server-side one.
    idleTimeout: 0,
    fetch: req =>
      stall(req)
        ? new Promise<Response>(() => {})
        : new Response(
            JSON.stringify({
              version: 1,
              entryChecksums: { 'a.md': 'sha256:aa' },
              supports: ['entry-view', 'entries-view'],
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
  })
}

describe('bounded waits', () => {
  test('every call site gives up on a server that never answers, and none fires against a working one', async () => {
    const all = stallingServer(() => true)
    const writes = stallingServer(req => req.method !== 'GET')
    const stalled = (port: number | undefined) =>
      new OpenRecallClient({ url: `http://localhost:${port}`, passphrase: 'pw', timeoutMs: 500 })

    const timedOut = async (label: string, run: () => Promise<unknown>) => {
      const t0 = Date.now()
      const err = await run().catch(e => e)
      return { label, err, elapsed: Date.now() - t0 }
    }

    const c1 = stalled(all.port)
    const c2 = stalled(all.port)
    const c3 = stalled(writes.port)
    const c4 = stalled(writes.port)
    const c5 = stalled(writes.port)
    const c6 = stalled(all.port)
    const c7 = stalled(writes.port)
    // c4 has to enumerate first, or its delete takes the DELETE path (c5's)
    // rather than the assert-absence PUT.
    await c4.hashes('user:tmo')

    const results = [
      await timedOut('hashes', () => c1.hashes('user:tmo')),
      await timedOut('pull', () => c2.pull('user:tmo')),
      await timedOut('push', () => c3.push('user:tmo', { 'a.md': 'x' })),
      await timedOut('delete-via-put', () => c4.delete('user:tmo', 'gone.md')),
      await timedOut('delete', () => c5.delete('user:tmo', 'a.md')),
      await timedOut('entries', () => c6.entries('user:tmo', ['a.md'])),
      // The POST half of a pull: the hashes view answers, the bulk read stalls.
      await timedOut('pull-entries', () => c7.pull('user:tmo')),
    ]
    all.stop(true)
    writes.stop(true)

    for (const { label, err, elapsed } of results) {
      expect(`${label}: ${(err as Error)?.name}`).toBe(`${label}: OpenRecallTimeoutError`)
      expect(err).toBeInstanceOf(OpenRecallTimeoutError)
      expect((err as InstanceType<typeof OpenRecallTimeoutError>).timeoutMs).toBe(500)
      expect((err as InstanceType<typeof OpenRecallTimeoutError>).namespace).toBe('user:tmo')
      // Bounded wall clock, not "eventually": a client that hung until bun's
      // own test timeout killed it would otherwise look the same.
      expect(`${label}: ${elapsed < 5000}`).toBe(`${label}: true`)
    }

    // Positive control, same knob against a server that does answer. Without
    // it, a client that refused every request would pass everything above.
    const ok = new OpenRecallClient({ url: base, passphrase: 'pw', timeoutMs: 500 })
    const ns = 'user:cb-tmo-control'
    await ok.push(ns, { 'a.md': 'v1' })
    expect((await ok.pull(ns)).entries['a.md']).toBe('v1')
    expect(Object.keys(await ok.hashes(ns))).toEqual(['a.md'])
    await ok.delete(ns, 'a.md')
    expect(await ok.hashes(ns)).toEqual({})
  }, 15000)

  test('a server that sends a status and then stalls mid-body times out too', async () => {
    // The abort covers the body, not only the headers, so this is a separate
    // path from the test above: the fetch has already resolved and the wait
    // is inside the body read. Without it being mapped there, a stalled
    // transfer surfaces as a bare DOMException from a JSON parse instead of
    // the typed timeout, which is the one thing the class exists to prevent.
    const s = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start: c => c.enqueue(new TextEncoder().encode('{"version":1,"content":')),
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    })
    const c = new OpenRecallClient({
      url: `http://localhost:${s.port}`,
      passphrase: 'pw',
      timeoutMs: 500,
    })
    const t0 = Date.now()
    const err = await c.pull('user:tmo-body').catch(e => e)
    s.stop(true)
    expect((err as Error)?.name).toBe('OpenRecallTimeoutError')
    expect(err).toBeInstanceOf(OpenRecallTimeoutError)
    expect(Date.now() - t0).toBeLessThan(5000)
  }, 15000)

  test('a client that was given no timeout still has a bounded one', () => {
    const c = client() as unknown as { timeoutMs: number }
    expect(c.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(Number.isFinite(DEFAULT_TIMEOUT_MS)).toBe(true)
    // Large enough that a slow-but-working transfer of a full namespace
    // survives it; see the comment on the constant.
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000)
  })
})

// ─── Bounded per-namespace caches ───────────────────────────────────────
//
// Both maps key on a namespace string that every MCP tool takes as a
// model-supplied argument, in a process that lives as long as the agent
// session, so an unbounded map is a model-driven leak. keyCache additionally
// holds derived key material, which is worth keeping resident only while it is
// being used.

describe('bounded per-namespace caches', () => {
  test('the observed map evicts the oldest namespace and leaves a recent one armed', async () => {
    const a = client()
    const b = client()
    const evicted = 'user:cb-lru-evicted'
    const kept = 'user:cb-lru-kept'

    // Enumerated-empty: a later write may assert the key absent.
    expect(await a.hashes(evicted)).toEqual({})
    for (let i = 0; i < MAX_TRACKED_NAMESPACES; i++) await a.hashes(`user:cb-lru-f${i}`)
    expect(await a.hashes(kept)).toEqual({})

    // The evicted namespace: a lost entry costs the guarantee, not
    // correctness. The write goes unconditional, exactly as a first write
    // into a never-read namespace already does.
    await b.push(evicted, { 'k.md': 'from-b' })
    await a.push(evicted, { 'k.md': 'from-a' })
    expect((await b.pull(evicted)).entries['k.md']).toBe('from-a')

    // The still-resident one is untouched: a cache that evicted on every
    // insert would pass the half above and lose this.
    await b.push(kept, { 'k.md': 'from-b' })
    const err = await a.push(kept, { 'k.md': 'from-a' }).catch(e => e)
    expect(err).toBeInstanceOf(OpenRecallHttpError)
    expect((err as InstanceType<typeof OpenRecallHttpError>).code).toBe('stale_base_version')
    expect((await b.pull(kept)).entries['k.md']).toBe('from-b')
  }, 30000)

  test('the key cache is bounded, and eviction only costs a re-derivation', () => {
    const c = client() as unknown as {
      keyCache: Map<string, Buffer>
      key(namespace: string): Buffer
    }
    const evicted = 'user:cb-key-evicted'
    const kept = 'user:cb-key-kept'

    const first = c.key(evicted)
    for (let i = 0; i < MAX_TRACKED_NAMESPACES; i++) c.key(`user:cb-key-f${i}`)
    const keptFirst = c.key(kept)

    expect(c.keyCache.size).toBeLessThanOrEqual(MAX_TRACKED_NAMESPACES)
    // Still resident across a later insert: the same Buffer instance comes
    // back, so nothing was re-derived. The later insert is the load-bearing
    // half. Reading `kept` straight back would survive even a cache that
    // evicts on every insert, since nothing would have displaced it yet.
    c.key('user:cb-key-after')
    expect(c.key(kept)).toBe(keptFirst)
    // Evicted: a fresh instance, carrying the same key, so the only cost is
    // the derivation.
    const again = c.key(evicted)
    expect(again).not.toBe(first)
    expect(again.equals(first)).toBe(true)
  }, 30000)
})

// ─── The bounded single-entry read ──────────────────────────────────────
//
// `entry` exists so a caller that needs to prove one thing about a namespace
// does not have to ship the whole thing. What it records is the interesting
// half: one entry is positive knowledge about exactly one key and says nothing
// whatever about any other, so folding it in as if it were a namespace read
// would arm the write precondition with a claim this client cannot support.

/** A proxy that records the query string of everything the client asks for. */
function recordingProxy(upstream: string) {
  const searches: string[] = []
  const s = Bun.serve({
    port: 0,
    fetch: req => {
      const u = new URL(req.url)
      searches.push(u.search)
      return fetch(`${upstream}${u.pathname}${u.search}`, {
        method: req.method,
        headers: req.headers,
        body: req.method === 'GET' || req.method === 'DELETE' ? undefined : req.body,
        duplex: 'half',
        // biome-ignore lint/suspicious/noExplicitAny: duplex is not in the DOM types bun uses
      } as any)
    },
  })
  return { url: `http://localhost:${s.port}`, searches, stop: () => s.stop(true) }
}

describe('single-entry read', () => {
  test('one entry comes back decrypted, and only that entry is asked for', async () => {
    const ns = 'user:cb-entry-one'
    await client().push(ns, { 'a.md': 'alpha', 'b.md': 'beta' })
    const p = recordingProxy(base)
    try {
      const c = new OpenRecallClient({ url: p.url, passphrase: 'pw' })
      expect(await c.entry(ns, 'a.md')).toBe('alpha')
      // The boundedness control. Asserting the plaintext alone cannot tell this
      // from a full pull that threw away the rest, so the wire is what proves
      // it: exactly one request, carrying the entry view and the key.
      expect(p.searches).toEqual(['?view=entry&key=a.md'])
    } finally {
      p.stop()
    }
  })

  test('a wrong passphrase is a decrypt error naming the entry', async () => {
    const ns = 'user:cb-entry-wrong'
    await client().push(ns, { 'a.md': 'alpha' })
    const wrong = new OpenRecallClient({ url: base, passphrase: 'not-the-passphrase' })
    const err = await wrong.entry(ns, 'a.md').catch(e => e)
    expect(err).toBeInstanceOf(OpenRecallDecryptError)
    expect((err as InstanceType<typeof OpenRecallDecryptError>).entryKey).toBe('a.md')
  })

  test('every refusal reaches the caller as a typed HTTP error, never as an empty read', async () => {
    // A denial rendered as success is the defect this repo keeps finding, and
    // this method is the shape most prone to it: "no such entry" has an
    // obvious wrong answer, the empty string.
    const ns = 'user:cb-entry-refusals'
    const c = client()
    await c.push(ns, { 'a.md': 'alpha' })

    const nsGone = await c.entry('user:cb-entry-nothing', 'a.md').catch(e => e)
    const keyGone = await c.entry(ns, 'nope.md').catch(e => e)

    // Drift: the manifest keeps the key, the store loses the body.
    const drifted = 'user:cb-entry-drift'
    await c.push(drifted, { 'gone.md': 'body' })
    const hash = (await c.hashes(drifted))['gone.md'] as string
    await getStore().delete(contentPath(namespaceSlug(drifted), hash))
    const unreadable = await c.entry(drifted, 'gone.md').catch(e => e)

    expect(
      [nsGone, keyGone, unreadable].map(
        e => `${(e as Error).name}:${(e as InstanceType<typeof OpenRecallHttpError>).code}`,
      ),
    ).toEqual([
      'OpenRecallHttpError:empty',
      'OpenRecallHttpError:entry_not_found',
      'OpenRecallHttpError:entry_unreadable',
    ])
  })

  test('a 200 with no entry in it is a read failure, not a decrypt failure', async () => {
    // The distinction the MCP preflight is built on: only a real decrypt
    // failure may be blamed on the passphrase. A server that answers the entry
    // view with some other 200 body must not look like a wrong key.
    const s = rawServer(200, JSON.stringify({ version: 1, content: { entries: {} } }))
    const c = new OpenRecallClient({ url: `http://localhost:${s.port}`, passphrase: 'pw' })
    const err = await c.entry('user:cb-entry-shape', 'a.md').catch(e => e)
    s.stop(true)
    expect(err).not.toBeInstanceOf(OpenRecallDecryptError)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('a.md')
  })

  test('the read arms the precondition for the key it read', async () => {
    const ns = 'user:cb-entry-arms'
    const a = client()
    const b = client()
    await b.push(ns, { 'a.md': 'v1' })
    expect(await a.entry(ns, 'a.md')).toBe('v1')
    await b.push(ns, { 'a.md': 'v2' })

    const err = await a.push(ns, { 'a.md': 'from-a' }).catch(e => e)
    expect(err).toBeInstanceOf(OpenRecallHttpError)
    expect((err as InstanceType<typeof OpenRecallHttpError>).code).toBe('stale_base_version')
    expect((await b.pull(ns)).entries['a.md']).toBe('v2')
  })

  test('it claims nothing about the keys it did not read', async () => {
    // The half that decides whether the record is honest. A hashes read
    // enumerates, so a key missing from it is provably absent and a write may
    // assert that. One entry enumerates nothing, so a write to some other key
    // must go through unconditionally rather than assert an absence this
    // client never observed.
    const ns = 'user:cb-entry-unenumerated'
    const a = client()
    const b = client()
    await b.push(ns, { 'a.md': 'v1' })
    await a.entry(ns, 'a.md')
    // b creates a key a has never heard of, in a's turn.
    await b.push(ns, { 'other.md': 'from-b' })

    await a.push(ns, { 'other.md': 'from-a' })
    expect((await b.pull(ns)).entries['other.md']).toBe('from-a')
  })

  test('it adds to what this client knows instead of replacing it', async () => {
    // A record that overwrote the map would drop the enumeration a hashes read
    // had just established, silently disarming the precondition for every
    // other key. Two-state: the same flow without the entry read must refuse,
    // and with it must still refuse.
    const ns = 'user:cb-entry-additive'
    const a = client()
    const b = client()
    await b.push(ns, { 'a.md': 'v1', 'b.md': 'v1' })
    await a.hashes(ns)
    await a.entry(ns, 'a.md')
    await b.push(ns, { 'b.md': 'from-b' })

    const err = await a.push(ns, { 'b.md': 'from-a' }).catch(e => e)
    expect((err as InstanceType<typeof OpenRecallHttpError>)?.code).toBe('stale_base_version')
    expect((await b.pull(ns)).entries['b.md']).toBe('from-b')
  })
})
