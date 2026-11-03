import { describe, expect, test } from 'bun:test'
import {
  InvalidNameError,
  namespaceSlug,
  validateEntryKey,
  validateNamespace,
} from '../src/namespace.ts'

describe('namespace validation', () => {
  test('accepts valid namespaces', () => {
    for (const ns of ['user:alice', 'repo:twigpine/openrecall', 'agent:intern', 'user:9f3a-bc']) {
      expect(validateNamespace(ns)).toBe(ns)
    }
  })

  test('rejects traversal and junk', () => {
    for (const ns of ['../etc', 'user:../x', 'nope', 'user:a//b', 'USER:alice', '']) {
      expect(() => validateNamespace(ns)).toThrow(InvalidNameError)
    }
  })
})

describe('entry-key validation (path traversal)', () => {
  test('accepts memdir-style keys', () => {
    for (const k of ['MEMORY.md', 'feedback/testing.md', 'a/b/c.md']) {
      expect(validateEntryKey(k)).toBe(k)
    }
  })

  test('rejects traversal, absolute, backslash, NUL', () => {
    for (const k of [
      '../secret',
      '/etc/passwd',
      'a/../b',
      'a\\b',
      'a\0b',
      '/leading',
      'trailing/',
    ]) {
      expect(() => validateEntryKey(k)).toThrow(InvalidNameError)
    }
  })
})

describe('namespaceSlug (injective storage key)', () => {
  // The bug: `user:a/b` (owner "a") and `user:a__b` (owner "a__b") are distinct
  // valid namespaces. If they slug to the same value they share storage —
  // cross-tenant manifest corruption + metadata leak. They must differ.
  test('does not collide on the :/ vs __ ambiguity', () => {
    expect(namespaceSlug('user:a/b')).not.toBe(namespaceSlug('user:a__b'))
  })

  // A sha256 slug is case-sensitive, so case-variant namespaces stay distinct
  // even on a case-insensitive filesystem (the slug differs before it ever
  // reaches the fs). This guards the STORE=fs default on macOS/Windows.
  test('keeps case-variant namespaces distinct', () => {
    expect(namespaceSlug('user:alice/Notes')).not.toBe(namespaceSlug('user:alice/notes'))
  })

  // Property-style guard: a large set of grammar-conforming namespaces must all
  // slug to distinct values. This catches any future regression (e.g. a
  // NAMESPACE_RE change) that reintroduces a collision, which a fixed list
  // would miss.
  test('is injective across many distinct valid namespaces', () => {
    const scopes = ['user', 'repo', 'agent']
    const segs = ['a', 'a/b', 'a__b', 'a_b', 'a.b', 'a-b', 'A', 'alice', 'alice/notes']
    const namespaces: string[] = []
    for (const scope of scopes) {
      for (const seg of segs) namespaces.push(`${scope}:${seg}`)
    }
    // each input is a distinct string (verify the set, then the slugs)
    expect(new Set(namespaces).size).toBe(namespaces.length)
    const slugs = new Set(namespaces.map(namespaceSlug))
    expect(slugs.size).toBe(namespaces.length)
  })

  // Pin the full output alphabet, not just absence of : and /. All-lowercase
  // 64-hex is what makes the slug path-safe AND case-insensitive-fs-safe; a
  // future swap to base64/uppercase-hex would silently drop that guard while
  // every other test still passed.
  test('produces a flat, path-safe 64-char lowercase-hex segment', () => {
    for (const ns of ['user:alice', 'repo:o/n', 'user:a/b/c', 'user:a__b']) {
      expect(namespaceSlug(ns)).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  // Pin a known input→slug so the exact algorithm is locked: swapping sha256
  // for another hash (which would orphan all stored data) fails here loudly,
  // and the literal also re-asserts determinism non-vacuously.
  test('pins the slug to sha256 hex of the namespace', () => {
    expect(namespaceSlug('user:alice')).toBe(
      'dabd1db8d35ab13106274f61f1bf977812cce4f477b15014cf38fb796c50a4c4',
    )
  })
})
