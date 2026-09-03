/**
 * S3-compatible BlobStore adapter (Tigris, Cloudflare R2, AWS S3, minio).
 *
 * Uses Bun's built-in S3 client — no SDK dependency. This is the recommended
 * hosted backend: pair a PRIVATE bucket with the crypto-blind server and the
 * data at rest is ciphertext in a bucket nobody can list publicly.
 */

import type { BlobStore } from './blobstore.ts'

type S3Settings = {
  bucket: string
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
}

export class S3BlobStore implements BlobStore {
  readonly erasure = 'erases' as const

  private readonly client: Bun.S3Client
  private readonly bucket: string

  constructor(s: S3Settings) {
    if (!s.bucket) throw new Error('STORE=s3 requires S3_BUCKET')
    if (!s.accessKeyId || !s.secretAccessKey) {
      throw new Error('STORE=s3 requires S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY')
    }
    this.bucket = s.bucket
    this.client = new Bun.S3Client({
      accessKeyId: s.accessKeyId,
      secretAccessKey: s.secretAccessKey,
      bucket: s.bucket,
      region: s.region || 'auto',
      endpoint: s.endpoint || undefined,
    })
  }

  async get(path: string): Promise<Uint8Array | null> {
    const file = this.client.file(path)
    try {
      const buf = await file.bytes()
      return new Uint8Array(buf)
    } catch (err) {
      // Bun throws on a missing object; treat "not found" as null.
      const msg = (err as Error).message ?? ''
      if (/not.?found|NoSuchKey|404/i.test(msg)) return null
      // exists() is cheap and unambiguous for the genuinely-missing case.
      if (!(await file.exists().catch(() => true))) return null
      throw err
    }
  }

  async put(path: string, bytes: Uint8Array): Promise<void> {
    await this.client.write(path, bytes, { type: 'application/octet-stream' })
  }

  async delete(path: string): Promise<void> {
    await this.client.delete(path)
  }

  describe(): string {
    return `s3:${this.bucket}`
  }
}
