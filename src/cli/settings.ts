/**
 * Client-side settings shared by the CLI and the MCP server.
 *
 * One config file (`~/.openrecall/config.json`, mode 0600) holds the
 * passphrase, server URL, API key and default namespace, so every agent on the
 * machine registers the SAME secret-free MCP command and shares one memory:
 *
 *   npx -y @twigpine/openrecall mcp
 *
 * Environment variables override the file (useful for CI and per-agent
 * overrides). `url: "local"` (the default) serves memory from an encrypted
 * store on this machine with no server at all.
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ScanMode } from '../../client/secretscan.ts'

export const LOCAL_URL = 'local'
export const DEFAULT_NAMESPACE = 'user:me'
const SCAN_MODES: readonly ScanMode[] = ['block', 'warn', 'off']

/** What `~/.openrecall/config.json` may contain. */
export type ConfigFile = {
  url?: string
  apiKey?: string
  passphrase?: string
  namespace?: string
  scan?: ScanMode
}

export type Settings = {
  /** ~/.openrecall, or OPENRECALL_HOME */
  home: string
  configPath: string
  /** `local` or an http(s) base URL */
  url: string
  apiKey?: string
  passphrase?: string
  namespace: string
  scan: ScanMode
  /** Where local mode keeps ciphertext (OPENRECALL_DATA_DIR, default <home>/data). */
  dataDir: string
}

type Env = Record<string, string | undefined>

/** Env vars that override fields of the config file. */
export const OVERRIDE_VARS = [
  'OPENRECALL_URL',
  'OPENRECALL_API_KEY',
  'OPENRECALL_PASSPHRASE',
  'OPENRECALL_PASSPHRASE_FILE',
  'OPENRECALL_NAMESPACE',
  'OPENRECALL_SCAN',
] as const

function clean(v: string | undefined): string | undefined {
  const t = v?.trim()
  return t ? t : undefined
}

/**
 * OPENRECALL_PASSPHRASE_FILE could not be used. A class of its own so the MCP
 * startup check can refuse with this message verbatim instead of treating it
 * as an ordinary settings error.
 */
export class PassphraseFileError extends Error {}

function oneLine(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 120)}...` : flat
}

/**
 * The passphrase from the file OPENRECALL_PASSPHRASE_FILE names, or undefined
 * when the variable is unset.
 *
 * When both the file and OPENRECALL_PASSPHRASE are set the file wins. The
 * reason is the host, not us: an agent that launches this server spreads its
 * own environment into every stdio child it runs, so a passphrase exported for
 * openrecall is readable by every other MCP server the user has configured. A
 * path is safe to spread that way; the value never is, and a file can carry
 * permissions an environment cannot. Whoever moved the secret out of the
 * environment should not then be overridden by a stale export of the old one.
 *
 * An unreadable or empty file is an error, never a fallback to the other
 * sources: a silent fallback is how a namespace ends up written under a second
 * key.
 */
function passphraseFromFile(env: Env): string | undefined {
  const path = clean(env.OPENRECALL_PASSPHRASE_FILE)
  if (!path) return undefined
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (err) {
    throw new PassphraseFileError(
      `OPENRECALL_PASSPHRASE_FILE points at ${oneLine(path)}, which could not be read: ${oneLine((err as Error).message)}. ` +
        'Check the path and that the launching user can read it. ' +
        'Refusing to start rather than falling back to OPENRECALL_PASSPHRASE, because a silent fallback is how a namespace ends up written under a second key.',
    )
  }
  // Trailing newlines are what a file written by `echo` or an editor carries,
  // and a passphrase that differs by one byte decrypts nothing.
  const trimmed = contents.trim()
  if (!trimmed) {
    throw new PassphraseFileError(
      `OPENRECALL_PASSPHRASE_FILE points at ${oneLine(path)}, which is empty. ` +
        'Write the passphrase into that file, or unset the variable to use OPENRECALL_PASSPHRASE instead.',
    )
  }
  return trimmed
}

export function homeDir(env: Env = process.env): string {
  return resolve(clean(env.OPENRECALL_HOME) ?? join(homedir(), '.openrecall'))
}

export function readConfigFile(path: string): ConfigFile {
  if (!existsSync(path)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`)
  }
  return parsed as ConfigFile
}

export function validateUrl(url: string): string {
  if (url === LOCAL_URL) return url
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error(`invalid url "${url}" — use "local" or an http(s) URL`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`invalid url "${url}" — use "local" or an http(s) URL`)
  }
  return url.replace(/\/$/, '')
}

export function validateScan(scan: string): ScanMode {
  if (!SCAN_MODES.includes(scan as ScanMode)) {
    throw new Error(`invalid scan mode "${scan}" — use block, warn, or off`)
  }
  return scan as ScanMode
}

/** Resolve settings: env > config file > defaults. */
export function resolveSettings(env: Env = process.env): Settings {
  const home = homeDir(env)
  const configPath = join(home, 'config.json')
  const file = readConfigFile(configPath)

  const pick = (envName: (typeof OVERRIDE_VARS)[number], fileValue: string | undefined) =>
    clean(env[envName]) ?? clean(fileValue)

  return {
    home,
    configPath,
    url: validateUrl(pick('OPENRECALL_URL', file.url) ?? LOCAL_URL),
    apiKey: pick('OPENRECALL_API_KEY', file.apiKey),
    passphrase: passphraseFromFile(env) ?? pick('OPENRECALL_PASSPHRASE', file.passphrase),
    namespace: pick('OPENRECALL_NAMESPACE', file.namespace) ?? DEFAULT_NAMESPACE,
    scan: validateScan(pick('OPENRECALL_SCAN', file.scan) ?? 'block'),
    dataDir: resolve(clean(env.OPENRECALL_DATA_DIR) ?? join(home, 'data')),
  }
}

/**
 * Names of the OPENRECALL_* variables currently overriding the config file —
 * names only, never values, so `openrecall status` can print them safely.
 */
export function envOverrides(env: Env = process.env): string[] {
  return OVERRIDE_VARS.filter(name => clean(env[name]) !== undefined)
}

/** A fresh 256-bit passphrase, base64url (43 chars). */
export function generatePassphrase(): string {
  return randomBytes(32).toString('base64url')
}

/** Write the config file owner-only (dir 0700, file 0600). */
export function writeConfigFile(home: string, cfg: ConfigFile): string {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const path = join(home, 'config.json')
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600) // mode is ignored when the file already existed
  return path
}

/** True when the config file is readable by group/other (POSIX only). */
export function configTooOpen(path: string): boolean {
  if (process.platform === 'win32' || !existsSync(path)) return false
  return (statSync(path).mode & 0o077) !== 0
}
