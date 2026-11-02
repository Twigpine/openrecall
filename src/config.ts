/**
 * Server configuration, read once from the environment.
 *
 * Nothing here gives the server the ability to read memory contents — the
 * server is crypto-blind by design. These settings only control storage,
 * auth, and abuse limits.
 *
 * Parsing is strict on purpose. A typo in `STORE` used to fall through to the
 * filesystem driver, so a hosted process with `STORE=s4` would happily write
 * ciphertext to its ephemeral container disk and lose it on the next deploy.
 * Bad numbers were silently replaced by defaults or accepted as negatives.
 * Both are configuration errors, so they fail at startup with the variable
 * name instead of becoming a production surprise.
 */

export type StoreDriver = 'fs' | 's3'

/** Thrown for an environment value the server cannot safely interpret. */
export class ConfigError extends Error {
  override name = 'ConfigError'
}

type Env = Record<string, string | undefined>

const STORE_DRIVERS: readonly StoreDriver[] = ['fs', 's3']

function read(env: Env, name: string): string | undefined {
  const raw = env[name]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

function envInt(
  env: Env,
  name: string,
  fallback: number,
  bounds: { min: number; max?: number } = { min: 0 },
): number {
  const raw = read(env, name)
  if (raw === undefined) return fallback
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < bounds.min || n > max) {
    const range = bounds.max === undefined ? `>= ${bounds.min}` : `between ${bounds.min} and ${max}`
    throw new ConfigError(`${name} must be an integer ${range}, got ${JSON.stringify(raw)}`)
  }
  return n
}

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on'])
const FALSE_VALUES = new Set(['false', '0', 'no', 'off'])

function envBool(env: Env, name: string, fallback: boolean): boolean {
  const raw = read(env, name)?.toLowerCase()
  if (raw === undefined) return fallback
  if (TRUE_VALUES.has(raw)) return true
  if (FALSE_VALUES.has(raw)) return false
  // Never guess for something that switches authentication on or off.
  throw new ConfigError(`${name} must be true or false, got ${JSON.stringify(env[name])}`)
}

export type Config = {
  readonly port: number
  readonly store: StoreDriver
  readonly dataDir: string
  readonly s3: {
    readonly bucket: string
    readonly endpoint: string
    readonly region: string
    readonly accessKeyId: string
    readonly secretAccessKey: string
  }
  readonly auth: {
    readonly allowUnauthenticated: boolean
    readonly supabaseUrl: string
    readonly supabaseSecretKey: string
    /** "owner:key" comma-separated pairs for self-host without Supabase. */
    readonly staticApiKeys: string
  }
  readonly limits: {
    readonly maxEntryBytes: number
    readonly maxEntriesPerNamespace: number
    readonly maxBodyBytes: number
    readonly maxNamespaceBytes: number
    readonly maxNamespacesPerOwner: number
    readonly maxOwnerBytes: number
  }
  readonly rateLimit: {
    readonly perMinute: number
    readonly burst: number
  }
}

/** Parse and validate a whole server configuration from `env`. */
export function parseConfig(env: Env = process.env): Config {
  const rawStore = (read(env, 'STORE') ?? 'fs').toLowerCase()
  if (!STORE_DRIVERS.includes(rawStore as StoreDriver)) {
    throw new ConfigError(
      `STORE must be one of ${STORE_DRIVERS.join(', ')}, got ${JSON.stringify(env.STORE)}`,
    )
  }
  const store = rawStore as StoreDriver

  const s3 = {
    bucket: read(env, 'S3_BUCKET') ?? '',
    endpoint: (read(env, 'S3_ENDPOINT') ?? '').replace(/\/$/, ''),
    region: read(env, 'S3_REGION') ?? 'auto',
    accessKeyId: read(env, 'S3_ACCESS_KEY_ID') ?? '',
    secretAccessKey: read(env, 'S3_SECRET_ACCESS_KEY') ?? '',
  }
  if (store === 's3') {
    const required = [
      ['S3_BUCKET', s3.bucket],
      ['S3_ACCESS_KEY_ID', s3.accessKeyId],
      ['S3_SECRET_ACCESS_KEY', s3.secretAccessKey],
    ] as const
    for (const [name, value] of required) {
      if (!value) throw new ConfigError(`STORE=s3 requires ${name}`)
    }
  }

  return {
    port: envInt(env, 'PORT', 8080, { min: 0, max: 65_535 }),

    store,
    dataDir: read(env, 'DATA_DIR') ?? './data',
    s3,

    auth: {
      allowUnauthenticated: envBool(env, 'ALLOW_UNAUTHENTICATED', false),
      supabaseUrl: (read(env, 'OPENRECALL_SUPABASE_URL') ?? '').replace(/\/$/, ''),
      supabaseSecretKey: read(env, 'OPENRECALL_SUPABASE_SECRET_KEY') ?? '',
      staticApiKeys: read(env, 'STATIC_API_KEYS') ?? '',
    },

    limits: {
      maxEntryBytes: envInt(env, 'MAX_ENTRY_BYTES', 250_000),
      maxEntriesPerNamespace: envInt(env, 'MAX_ENTRIES_PER_NAMESPACE', 2_000),
      // Gateway/body cap for a whole PUT payload.
      maxBodyBytes: envInt(env, 'MAX_BODY_BYTES', 8_000_000),
      // Total ciphertext bytes allowed in a single namespace.
      maxNamespaceBytes: envInt(env, 'MAX_NAMESPACE_BYTES', 10_000_000),
      // Per-account (owner) aggregate caps. Not enforced for the self-host
      // `local` owner. Conservative beta defaults; easy to raise.
      maxNamespacesPerOwner: envInt(env, 'MAX_NAMESPACES_PER_OWNER', 50),
      maxOwnerBytes: envInt(env, 'MAX_OWNER_BYTES', 50_000_000),
    },

    // Per-owner request rate limit (token bucket, in-memory — single machine).
    // 0 disables it; burst 0 denies every request.
    rateLimit: {
      perMinute: envInt(env, 'RATE_LIMIT_PER_MINUTE', 120),
      burst: envInt(env, 'RATE_LIMIT_BURST', 240),
    },
  }
}

export const config: Config = parseConfig(process.env)
