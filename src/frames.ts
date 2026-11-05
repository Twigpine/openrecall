/**
 * The wire format of the bulk entries view (`POST /api/memory/:ns?view=entries`).
 *
 * The full read ships ciphertext as base64 inside JSON, and at 5,000 entries
 * the encode and the parse cost several times what the cipher does: 10.6 MB of
 * JSON for 7.2 MB of ciphertext, serialized and parsed on every recall. This
 * format carries the bytes raw, so a reader copies them straight into the
 * decryptor, and it carries one small JSON record per entry so the server
 * still never has to understand anything but its own manifest.
 *
 * Layout, every integer a little-endian u32 byte length:
 *
 *   "ORE1"                                  4-byte magic
 *   len, header JSON                        {namespace, version, lastModified, erasure, count}
 *   count x:
 *     len, meta JSON                        {key, hash, size, updatedAt, status}
 *     len, ciphertext bytes                 empty unless status is "ok"
 *
 * `status` is per entry, so one key the caller mistyped or one blob the store
 * has lost does not fail a read of two thousand others: `not_found` (the
 * manifest has no such key), `unreadable` (it has the key and the store has no
 * body: drift, which the full view silently skips and this view names), and
 * `invalid_key` (the key failed validation and was never looked up). Only an
 * `ok` entry carries bytes, and a client checks that `sha256(bytes)` equals
 * `hash` before it decrypts anything, so a mangled frame is a protocol error
 * and never a decryption failure.
 *
 * This file exists twice, byte for byte: src/frames.ts is the server's copy
 * and client/frames.ts the client's. The boundary tests forbid either side
 * importing the other (tests/recall-regression.test.ts), so the codec cannot
 * be shared, and tests/frames-cross-runtime.test.ts pins that the two files
 * are identical and that what one encodes the other decodes, under Bun and
 * under Node. It imports nothing and touches no global the server's import
 * boundary does not vouch for.
 */

/** The first four bytes of every frames body. */
export const FRAMES_MAGIC = 'ORE1'

/** Response header the server sets so a client can tell this body from JSON. */
export const FRAMES_HEADER = 'x-openrecall-frames'

export type FrameStatus = 'ok' | 'not_found' | 'unreadable' | 'invalid_key'

export type FramesHeader = {
  namespace: string
  version: number
  lastModified: string
  erasure: string
  /** How many entry frames follow. */
  count: number
}

export type FrameMeta = {
  key: string
  /** sha256:<hex> of the ciphertext, or null when the manifest has no row. */
  hash: string | null
  /** Ciphertext byte length per the manifest; 0 when there is no row. */
  size: number
  /** ISO 8601 per the manifest, or null when there is no row. */
  updatedAt: string | null
  status: FrameStatus
}

export type Frame = { meta: FrameMeta; bytes: Uint8Array }

/** A body that is not a well-formed frames stream. Never a decryption failure. */
export class FrameFormatError extends Error {
  constructor(detail: string) {
    super(`malformed entries frames: ${detail}`)
    this.name = 'FrameFormatError'
  }
}

const STATUSES = new Set<string>(['ok', 'not_found', 'unreadable', 'invalid_key'])
const MAGIC_BYTES = new TextEncoder().encode(FRAMES_MAGIC)

function writeU32(out: Uint8Array, at: number, value: number): void {
  out[at] = value & 0xff
  out[at + 1] = (value >>> 8) & 0xff
  out[at + 2] = (value >>> 16) & 0xff
  out[at + 3] = (value >>> 24) & 0xff
}

function readU32(buf: Uint8Array, at: number): number {
  return (
    ((buf[at] as number) |
      ((buf[at + 1] as number) << 8) |
      ((buf[at + 2] as number) << 16) |
      ((buf[at + 3] as number) << 24)) >>>
    0
  )
}

/**
 * Encode a header and its frames. The JSON records are written with their
 * fields in a fixed order, whatever order the caller's objects hold them in,
 * so the same content always encodes to the same bytes.
 */
export function encodeFrames(header: FramesHeader, frames: Frame[]): Uint8Array {
  const enc = new TextEncoder()
  const headerJson = enc.encode(
    JSON.stringify({
      namespace: header.namespace,
      version: header.version,
      lastModified: header.lastModified,
      erasure: header.erasure,
      count: frames.length,
    }),
  )
  const metas = frames.map(f =>
    enc.encode(
      JSON.stringify({
        key: f.meta.key,
        hash: f.meta.hash,
        size: f.meta.size,
        updatedAt: f.meta.updatedAt,
        status: f.meta.status,
      }),
    ),
  )
  let total = MAGIC_BYTES.length + 4 + headerJson.length
  for (let i = 0; i < frames.length; i++) {
    total += 4 + (metas[i] as Uint8Array).length + 4 + (frames[i] as Frame).bytes.length
  }
  const out = new Uint8Array(total)
  let at = 0
  out.set(MAGIC_BYTES, at)
  at += MAGIC_BYTES.length
  writeU32(out, at, headerJson.length)
  at += 4
  out.set(headerJson, at)
  at += headerJson.length
  for (let i = 0; i < frames.length; i++) {
    const meta = metas[i] as Uint8Array
    const bytes = (frames[i] as Frame).bytes
    writeU32(out, at, meta.length)
    at += 4
    out.set(meta, at)
    at += meta.length
    writeU32(out, at, bytes.length)
    at += 4
    out.set(bytes, at)
    at += bytes.length
  }
  return out
}

/**
 * Decode a frames body. Every length is checked against what is actually
 * there before it is read, a short body is a `FrameFormatError` rather than a
 * silently shorter result, and every JSON record is rebuilt field by field
 * from checked types, so nothing a server put in a record reaches the caller
 * as anything but a string, a number or null.
 */
export function decodeFrames(buf: Uint8Array): { header: FramesHeader; frames: Frame[] } {
  const dec = new TextDecoder()
  let at = 0
  const take = (what: string): Uint8Array => {
    if (at + 4 > buf.length) throw new FrameFormatError(`truncated before the length of ${what}`)
    const len = readU32(buf, at)
    at += 4
    if (at + len > buf.length) throw new FrameFormatError(`truncated inside ${what}`)
    const slice = buf.subarray(at, at + len)
    at += len
    return slice
  }
  const json = (bytes: Uint8Array, what: string): Record<string, unknown> => {
    let parsed: unknown
    try {
      parsed = JSON.parse(dec.decode(bytes))
    } catch {
      throw new FrameFormatError(`${what} is not JSON`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new FrameFormatError(`${what} is not an object`)
    }
    return parsed as Record<string, unknown>
  }
  const str = (v: unknown, what: string): string => {
    if (typeof v !== 'string') throw new FrameFormatError(`${what} is not a string`)
    return v
  }
  const strOrNull = (v: unknown, what: string): string | null => (v === null ? null : str(v, what))
  const count = (v: unknown, what: string): number => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
      throw new FrameFormatError(`${what} is not a non-negative integer`)
    }
    return v
  }

  if (buf.length < MAGIC_BYTES.length) throw new FrameFormatError('shorter than the magic')
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (buf[i] !== MAGIC_BYTES[i]) throw new FrameFormatError('bad magic')
  }
  at = MAGIC_BYTES.length

  const h = json(take('the header'), 'the header')
  const header: FramesHeader = {
    namespace: str(h.namespace, 'header.namespace'),
    version: count(h.version, 'header.version'),
    lastModified: str(h.lastModified, 'header.lastModified'),
    erasure: str(h.erasure, 'header.erasure'),
    count: count(h.count, 'header.count'),
  }

  const frames: Frame[] = []
  for (let i = 0; i < header.count; i++) {
    const m = json(take(`frame ${i} meta`), `frame ${i} meta`)
    const status = str(m.status, `frame ${i} status`)
    if (!STATUSES.has(status)) throw new FrameFormatError(`frame ${i} has status "${status}"`)
    const meta: FrameMeta = {
      key: str(m.key, `frame ${i} key`),
      hash: strOrNull(m.hash, `frame ${i} hash`),
      size: count(m.size, `frame ${i} size`),
      updatedAt: strOrNull(m.updatedAt, `frame ${i} updatedAt`),
      status: status as FrameStatus,
    }
    const bytes = take(`frame ${i} bytes`)
    if (meta.status !== 'ok' && bytes.length !== 0) {
      throw new FrameFormatError(`frame ${i} is ${meta.status} but carries bytes`)
    }
    frames.push({ meta, bytes })
  }
  if (at !== buf.length) throw new FrameFormatError(`${buf.length - at} trailing bytes`)
  return { header, frames }
}
