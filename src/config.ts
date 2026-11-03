/**
 * Server configuration, read once from the environment.
 *
 * Nothing here gives the server the ability to read memory contents — the
 * server is crypto-blind by design. These settings only control storage,
 * auth, and abuse limits.
 */

export type StoreDriver = 'fs' | 's3' | 'node'

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  return raw.trim().toLowerCase() === 'true'
}

/**
 * Read the node-storage acknowledgement from the environment.
 *
 * Exported so the refusal message and the reader cannot drift: a test sets the
 * exact value the message tells an operator to set and asserts this accepts it.
 * The first version of that message said `=1` while this accepts only `true`,
 * so following it exactly changed nothing.
 */
export function readNodeAcknowledgement(): boolean {
  return envBool('GITLAWB_NODE_ACKNOWLEDGE', false)
}

export const config = {
  port: envInt('PORT', 8080),

  store: (process.env.STORE ?? 'fs').trim().toLowerCase() as StoreDriver,
  dataDir: (process.env.DATA_DIR ?? './data').trim(),

  s3: {
    bucket: (process.env.S3_BUCKET ?? '').trim(),
    endpoint: (process.env.S3_ENDPOINT ?? '').trim().replace(/\/$/, ''),
    region: (process.env.S3_REGION ?? 'auto').trim(),
    accessKeyId: (process.env.S3_ACCESS_KEY_ID ?? '').trim(),
    secretAccessKey: (process.env.S3_SECRET_ACCESS_KEY ?? '').trim(),
  },

  // gitlawb node driver. The store secret derives every node-visible name and
  // the at-rest wrapping key, so losing it orphans node-stored namespaces and
  // disclosing it exposes manifest metadata; it is injected at runtime, kept
  // apart from the signing identity, and rotated only by re-path-and-re-wrap
  // migration. It is never a passphrase: entry blobs stay client-encrypted.
  node: {
    url: (process.env.GITLAWB_NODE_URL ?? '').trim().replace(/\/$/, ''),
    secret: (process.env.GITLAWB_NODE_STORE_SECRET ?? '').trim(),
    identityPath: (process.env.GITLAWB_NODE_IDENTITY_PATH ?? '').trim(),
    acknowledged: readNodeAcknowledgement(),
  },

  auth: {
    allowUnauthenticated: envBool('ALLOW_UNAUTHENTICATED', false),
    supabaseUrl: (process.env.OPENRECALL_SUPABASE_URL ?? '').trim().replace(/\/$/, ''),
    supabaseSecretKey: (process.env.OPENRECALL_SUPABASE_SECRET_KEY ?? '').trim(),
    // "owner:key" comma-separated pairs for self-host without Supabase.
    staticApiKeys: (process.env.STATIC_API_KEYS ?? '').trim(),
  },

  limits: {
    maxEntryBytes: envInt('MAX_ENTRY_BYTES', 250_000),
    maxEntriesPerNamespace: envInt('MAX_ENTRIES_PER_NAMESPACE', 2_000),
    // Gateway/body cap for a whole PUT payload.
    maxBodyBytes: envInt('MAX_BODY_BYTES', 8_000_000),
    // Total ciphertext bytes allowed in a single namespace.
    maxNamespaceBytes: envInt('MAX_NAMESPACE_BYTES', 10_000_000),
    // Per-account (owner) aggregate caps. Not enforced for the self-host
    // `local` owner. Conservative beta defaults; easy to raise.
    maxNamespacesPerOwner: envInt('MAX_NAMESPACES_PER_OWNER', 50),
    maxOwnerBytes: envInt('MAX_OWNER_BYTES', 50_000_000),
  },

  // Per-owner request rate limit (token bucket, in-memory — single machine).
  rateLimit: {
    perMinute: envInt('RATE_LIMIT_PER_MINUTE', 120),
    burst: envInt('RATE_LIMIT_BURST', 240),
  },
} as const

export type Config = typeof config
