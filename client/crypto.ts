/**
 * Client-side end-to-end encryption for openrecall.
 *
 * This is the whole point of the product: memory is encrypted HERE, on the
 * client, before it is ever sent to the server. The server stores and serves
 * only ciphertext and can never read your memory.
 *
 * Crypto choices (native node:crypto — zero dependencies, runs in Bun/Node):
 *   - Key derivation: scrypt(passphrase, salt = sha256("openrecall:" + namespace)).
 *       The namespace is the salt so derivation is deterministic and stateless
 *       (no salt file to lose), while still being distinct per namespace.
 *   - Cipher: AES-256-GCM with the entry key as AEAD additional data, so a
 *       ciphertext blob is cryptographically bound to its entry key and cannot
 *       be moved/replayed under a different key.
 *   - Nonce: DETERMINISTIC (synthetic-IV style) — HMAC-SHA256(key, entryKey ||
 *       0x00 || plaintext) truncated to 12 bytes. Same plaintext+key ⇒ same
 *       ciphertext, which is what lets the server do delta sync by hash without
 *       seeing plaintext. The only thing this leaks is whether two entries are
 *       byte-identical, which is acceptable for memory content.
 *
 * Blob layout (then base64 for the wire):
 *   [ 0x01 version ][ 12-byte nonce ][ 16-byte GCM tag ][ ciphertext ]
 *
 * Upgrade path: bump the version byte to migrate to XChaCha20-Poly1305 +
 * Argon2id (libsodium) without breaking old blobs — the version selects the
 * decryptor.
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, scryptSync } from 'node:crypto'

const VERSION = 0x01
const NONCE_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32
const SCRYPT_N = 1 << 15 // 32768 — strong, ~tens of ms
const SCRYPT_PARAMS = { N: SCRYPT_N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

/** Derive the 32-byte namespace key from a passphrase. Deterministic. */
export function deriveKey(passphrase: string, namespace: string): Buffer {
  const salt = createHash('sha256').update(`openrecall:${namespace}`).digest()
  return scryptSync(passphrase, salt, KEY_LEN, SCRYPT_PARAMS)
}

function deterministicNonce(key: Buffer, entryKey: string, plaintext: Buffer): Buffer {
  return createHmac('sha256', key)
    .update(entryKey)
    .update(Buffer.from([0]))
    .update(plaintext)
    .digest()
    .subarray(0, NONCE_LEN)
}

/** Encrypt a plaintext memory entry → base64 ciphertext blob. */
export function encryptEntry(key: Buffer, entryKey: string, plaintext: string): string {
  const pt = Buffer.from(plaintext, 'utf8')
  const nonce = deterministicNonce(key, entryKey, pt)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(entryKey, 'utf8'))
  const ct = Buffer.concat([cipher.update(pt), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from([VERSION]), nonce, tag, ct]).toString('base64')
}

/** Decrypt a base64 ciphertext blob → plaintext. Throws on tamper/wrong key. */
export function decryptEntry(key: Buffer, entryKey: string, b64: string): string {
  return decryptEntryBytes(key, entryKey, Buffer.from(b64, 'base64'))
}

/**
 * Decrypt raw ciphertext bytes → plaintext. The bulk entries view and the
 * on-disk mirror hold bytes, not base64, and re-encoding them only to decode
 * them again would cost more than the cipher does.
 */
export function decryptEntryBytes(key: Buffer, entryKey: string, bytes: Uint8Array): string {
  const blob = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (blob.length < 1 + NONCE_LEN + TAG_LEN) throw new Error('ciphertext too short')
  const version = blob[0]
  if (version !== VERSION) throw new Error(`unsupported ciphertext version ${version}`)
  const nonce = blob.subarray(1, 1 + NONCE_LEN)
  const tag = blob.subarray(1 + NONCE_LEN, 1 + NONCE_LEN + TAG_LEN)
  const ct = blob.subarray(1 + NONCE_LEN + TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(Buffer.from(entryKey, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

/** sha256:<hex> of the base64-decoded ciphertext — matches the server's hash. */
export function ciphertextHash(b64: string): string {
  return ciphertextHashBytes(Buffer.from(b64, 'base64'))
}

/** sha256:<hex> of raw ciphertext bytes — the same digest, for bodies not in base64. */
export function ciphertextHashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}
