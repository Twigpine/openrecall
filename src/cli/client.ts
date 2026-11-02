/**
 * Build an OpenRecallClient from resolved settings — remote (HTTP) or local
 * (in-process, no server). Shared by the CLI and the MCP server.
 */

import { type Finding, OpenRecallClient } from '../../client/index.ts'
import { LOCAL_ORIGIN, localFetch } from './local.ts'
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

export async function makeClient(
  s: Settings,
  opts?: { onScanWarning?: (findings: Finding[]) => void },
): Promise<OpenRecallClient> {
  if (!s.passphrase) throw new MissingPassphraseError(s.configPath)
  const local = s.url === LOCAL_URL
  return new OpenRecallClient({
    url: local ? LOCAL_ORIGIN : s.url,
    apiKey: local ? undefined : s.apiKey,
    passphrase: s.passphrase,
    scanMode: s.scan,
    onScanWarning: opts?.onScanWarning,
    fetch: local ? await localFetch(s.dataDir) : undefined,
  })
}

/** Human-readable location of the memory store, for status lines. */
export function describeTarget(s: Settings): string {
  return s.url === LOCAL_URL ? `local (${s.dataDir})` : s.url
}
