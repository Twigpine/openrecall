/**
 * Config is parsed once at startup and then drives storage, auth and every
 * limit. A value it cannot interpret must fail there, by name, rather than be
 * silently replaced by a default: `STORE=s4` used to fall back to the
 * filesystem driver, and a hosted process would lose its ciphertext on the
 * next restart. These tests pin the strict parser and the frozen singleton.
 */

import { describe, expect, test } from 'bun:test'
import { ConfigError, config, parseConfig } from '../src/config.ts'

describe('parseConfig defaults', () => {
  test('an empty environment is a self-host filesystem server', () => {
    const c = parseConfig({})
    expect(c.port).toBe(8080)
    expect(c.store).toBe('fs')
    expect(c.dataDir).toBe('./data')
    expect(c.s3.region).toBe('auto')
    expect(c.auth.allowUnauthenticated).toBe(false)
    expect(c.limits.maxEntryBytes).toBe(250_000)
    expect(c.limits.maxBodyBytes).toBe(8_000_000)
    expect(c.rateLimit).toEqual({ perMinute: 120, burst: 240 })
  })

  test('values are trimmed and normalized, empty means default', () => {
    const c = parseConfig({
      STORE: '  S3 ',
      S3_BUCKET: ' openrecall ',
      S3_ENDPOINT: 'https://fly.storage.tigris.dev/',
      S3_ACCESS_KEY_ID: ' key ',
      S3_SECRET_ACCESS_KEY: ' secret ',
      DATA_DIR: ' /srv/openrecall ',
      PORT: ' 9090 ',
    })
    expect(c.store).toBe('s3')
    expect(c.s3.bucket).toBe('openrecall')
    expect(c.s3.endpoint).toBe('https://fly.storage.tigris.dev')
    expect(c.dataDir).toBe('/srv/openrecall')
    expect(c.port).toBe(9090)

    expect(parseConfig({ STORE: '', PORT: '   ' }).store).toBe('fs')
  })
})

describe('parseConfig rejects what it cannot interpret', () => {
  test('an unknown storage driver is a startup error, never a silent fs fallback', () => {
    expect(() => parseConfig({ STORE: 's4' })).toThrow(ConfigError)
    expect(() => parseConfig({ STORE: 's4' })).toThrow(/STORE must be one of fs, s3/)
  })

  test('STORE=s3 names every missing credential', () => {
    const base: Record<string, string | undefined> = {
      STORE: 's3',
      S3_BUCKET: 'b',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
    }
    expect(parseConfig(base).store).toBe('s3')
    for (const missing of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
      const env = { ...base }
      delete env[missing]
      expect(() => parseConfig(env)).toThrow(`STORE=s3 requires ${missing}`)
    }
  })

  test('a limit must be a non-negative safe integer', () => {
    for (const bad of ['abc', '1.5', '-1', '1e999', '10000000000000000']) {
      expect(() => parseConfig({ MAX_ENTRY_BYTES: bad })).toThrow(/MAX_ENTRY_BYTES/)
    }
  })

  test('port must fit a TCP port', () => {
    expect(parseConfig({ PORT: '0' }).port).toBe(0)
    expect(() => parseConfig({ PORT: '65536' })).toThrow(/PORT/)
    expect(() => parseConfig({ PORT: '-1' })).toThrow(/PORT/)
  })

  test('0 still disables the rate limit', () => {
    const c = parseConfig({ RATE_LIMIT_PER_MINUTE: '0', RATE_LIMIT_BURST: '0' })
    expect(c.rateLimit).toEqual({ perMinute: 0, burst: 0 })
  })

  test('booleans accept the usual spellings and reject guesses', () => {
    for (const v of ['true', '1', 'yes', 'on', 'TRUE']) {
      expect(parseConfig({ ALLOW_UNAUTHENTICATED: v }).auth.allowUnauthenticated).toBe(true)
    }
    for (const v of ['false', '0', 'no', 'off']) {
      expect(parseConfig({ ALLOW_UNAUTHENTICATED: v }).auth.allowUnauthenticated).toBe(false)
    }
    // This switch guards authentication: never guess what "yep" meant.
    expect(() => parseConfig({ ALLOW_UNAUTHENTICATED: 'yep' })).toThrow(
      /ALLOW_UNAUTHENTICATED must be true or false/,
    )
  })
})

describe('the frozen config', () => {
  test('is the one built from the process environment', () => {
    // tests/setup.ts (preload) sets these before any src module loads.
    expect(config.store).toBe('fs')
    expect(config.auth.allowUnauthenticated).toBe(true)
    expect(config.limits.maxEntriesPerNamespace).toBe(5)
  })
})
