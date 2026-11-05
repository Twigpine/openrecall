/**
 * Build an OpenRecallClient from resolved settings — remote (HTTP) or local
 * (in-process, no server). Shared by the CLI and the MCP server.
 */

import { type Finding, OpenRecallClient } from '../../client/index.ts'
import { LOCAL_ORIGIN, localFetch } from './local.ts'
import { cacheDir, FsMirror } from './mirror.ts'
import { LOCAL_URL, type Settings } from './settings.ts'

export class MissingPassphraseError extends Error {
  constructor(configPath: string) {
    super(
      `no passphrase configured. Run \`openrecall init\` to create ${configPath} ` +
        '(or set OPENRECALL_PASSPHRASE). The passphrase is your zero-knowledge key ' +
        'and never leaves this machine.',
    )
  }
}

/**
 * Both modes get the in-memory plaintext cache, so a recall decrypts only what
 * changed since the last one. Only remote mode gets the on-disk mirror: local
 * mode's data directory already is a ciphertext store on this machine, read
 * in-process, and a copy of it next door would cost writes and buy nothing.
 * The client never reads that directory itself; it goes through the handler
 * like any other caller. `OPENRECALL_CACHE=off` (or `"cache": false` in the
 * config file) turns both off.
 */
export async function makeClient(
  s: Settings,
  opts?: { onScanWarning?: (findings: Finding[]) => void; timeoutMs?: number },
): Promise<OpenRecallClient> {
  if (!s.passphrase) throw new MissingPassphraseError(s.configPath)
  const local = s.url === LOCAL_URL
  return new OpenRecallClient({
    url: local ? LOCAL_ORIGIN : s.url,
    apiKey: local ? undefined : s.apiKey,
    passphrase: s.passphrase,
    scanMode: s.scan,
    onScanWarning: opts?.onScanWarning,
    ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    fetch: local ? await localFetch(s.dataDir) : undefined,
    cache: s.cache,
    mirror: !local && s.cache ? new FsMirror(cacheDir(s.home)) : undefined,
  })
}

/** Human-readable location of the memory store, for status lines. */
export function describeTarget(s: Settings): string {
  return s.url === LOCAL_URL ? `local (${s.dataDir})` : s.url
}
