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

export type Source = 'env' | 'config' | 'default'

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
  sources: Record<'url' | 'apiKey' | 'passphrase' | 'namespace' | 'scan', Source>
}

type Env = Record<string, string | undefined>

function clean(v: string | undefined): string | undefined {
  const t = v?.trim()
  return t ? t : undefined
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

  const pick = (envName: string, fileValue: string | undefined, fallback?: string) => {
    const e = clean(env[envName])
    if (e !== undefined) return { value: e, source: 'env' as const }
    const f = clean(fileValue)
    if (f !== undefined) return { value: f, source: 'config' as const }
    return { value: fallback, source: 'default' as const }
  }

  const url = pick('OPENRECALL_URL', file.url, LOCAL_URL)
  const apiKey = pick('OPENRECALL_API_KEY', file.apiKey)
  const passphrase = pick('OPENRECALL_PASSPHRASE', file.passphrase)
  const namespace = pick('OPENRECALL_NAMESPACE', file.namespace, DEFAULT_NAMESPACE)
  const scan = pick('OPENRECALL_SCAN', file.scan, 'block')

  return {
    home,
    configPath,
    url: validateUrl(url.value as string),
    apiKey: apiKey.value,
    passphrase: passphrase.value,
    namespace: namespace.value as string,
    scan: validateScan(scan.value as string),
    dataDir: resolve(clean(env.OPENRECALL_DATA_DIR) ?? join(home, 'data')),
    sources: {
      url: url.source,
      apiKey: apiKey.source,
      passphrase: passphrase.source,
      namespace: namespace.source,
      scan: scan.source,
    },
  }
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
