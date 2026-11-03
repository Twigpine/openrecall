/**
 * Startup preflight for the stdio MCP server.
 *
 * Why this exists: the manifest is cleartext, so a wrong or unexpanded
 * passphrase still lists keys and still saves. That first save leaves a
 * namespace written under two different keys, after which every later pull
 * fails GCM authentication for the CORRECT passphrase too. The damage is done
 * by the first tool call, so the configuration has to be checked before any
 * tool is served, and the process has to exit rather than degrade.
 *
 * It uses the reads the client already has: an authenticated hashes view of the
 * pinned namespace, then a pull when that view reports entries. No new server
 * endpoint, so this works against any deployed openrecall.
 *
 * A refusal has to name what is wrong, and naming the wrong thing has a cost
 * here that it does not have elsewhere: an operator told to change their
 * passphrase after a transient read failure is one save away from the mixed-key
 * namespace this whole file exists to prevent. So a decryption failure is
 * claimed only when the client says decryption is what failed, and a read that
 * decrypted nothing at all is reported as the server-side drift it is rather
 * than as proof of anything.
 *
 * Startup lives here rather than at server.ts's module top level so it can be
 * driven from a test without spawning a process.
 *
 * Nothing here writes to stdout. stdout is the MCP protocol channel and a
 * single stray byte on it corrupts the stream; the caller writes the returned
 * diagnostic to stderr.
 */

import type { Erasure } from '../../client/index.ts'
import {
  flattenServerText,
  type OpenRecallClient,
  OpenRecallDecryptError,
  OpenRecallHttpError,
  OpenRecallTimeoutError,
} from '../../client/index.ts'
import { describeTarget, makeClient } from '../cli/client.ts'
import { PassphraseFileError, resolveSettings } from '../cli/settings.ts'

export type PreflightResult =
  | { ready: true; client: OpenRecallClient; url: string; namespace: string; warnings: string[] }
  | { ready: false; diagnostic: string; unconfigured?: true }

type Env = Record<string, string | undefined>

function read(env: Env, name: string): string | undefined {
  const v = env[name]
  return v?.trim() ? v.trim() : undefined
}

/**
 * How many entries the passphrase proof may read before giving up.
 *
 * One would let a single drifted entry condemn a namespace whose others are
 * fine; unbounded would put the whole namespace back on the startup path, which
 * is what this proof exists to avoid. Five keeps the worst case at five small
 * reads, and a namespace whose first five entries are all unreadable is broken
 * enough that refusing to start is the honest answer.
 */
const PROBE_LIMIT = 5

/**
 * An unexpanded variable reference, in either spelling a launcher can leave
 * behind.
 *
 * openclaude substitutes an unset variable reference with its own literal text
 * and registers the server anyway, reporting only a warning, so openrecall
 * receives a non-empty passphrase that is really a template. Matching only the
 * one canonical spelling would miss every config that named the variable
 * something else. This is the only thing standing between the openclaude
 * integration and a mixed-key namespace, and that integration cannot delegate
 * the refusal upstream.
 *
 * The two rules are deliberately not symmetric, because the two spellings
 * carry different false-positive risk and a false positive here is not cheap:
 * a service key can be reissued, but a refused passphrase is the one thing
 * nobody can reissue, and the memory it opens is unreadable without it.
 *
 * BRACED matches anywhere in the value. `${` is not something `openrecall setup`
 * can generate, it is not a shape a password manager emits, and an operator who
 * genuinely wants those two characters can still choose a passphrase that
 * separates them.
 *
 * BARE is anchored to the WHOLE value and to an all-caps identifier, so it
 * means "this value is a variable reference" rather than "this value contains a
 * dollar sign". A single `$` is perfectly ordinary inside a high-entropy
 * secret, including as its first character, so anything looser would lock a
 * user out of their own memory. Refused: `$OPENRECALL_PASSPHRASE`, `$HOME`,
 * `$API_KEY_2`. Accepted: `$Xk9!vQ2m`, `pa$$word`, `$OPENRECALL_PASSPHRASE more`,
 * a lone `$`, `$4DOLLARS` (an identifier cannot start with a digit).
 *
 * What BARE knowingly does not catch, since an undocumented limit reads as
 * coverage: a lowercase or mixed-case bare reference such as `$secret` or
 * `$MyPass`. Shell and POSIX convention reserves upper case for environment
 * variables and launcher configs follow it, while `$secret` is a far more
 * plausible passphrase than an env var name, so the caps requirement is where
 * the two error costs cross over. `$` followed by a positional parameter or a
 * substitution such as `$(cmd)` is not caught either, and neither is a
 * partially expanded value.
 *
 * The residual false positive, a passphrase that really is `$` plus all caps
 * and nothing else, is recoverable: preflight gates only `openrecall mcp`, so the
 * CLI can still pull that namespace and push it again under a new passphrase.
 */
const UNEXPANDED_BRACED = /\$\{[^}]*\}/
const UNEXPANDED_BARE = /^\$[A-Z_][A-Z0-9_]*$/
// A whole-value `<...>` is a fill-in-the-blank, such as the setup card's own
// `<paste your passphrase here>`. Left unrefused it would pass every check and
// key the namespace to text that is printed in the documentation.
const PLACEHOLDER = /^<[^<>]*>$/

function isUnexpanded(value: string): boolean {
  return UNEXPANDED_BRACED.test(value) || UNEXPANDED_BARE.test(value) || PLACEHOLDER.test(value)
}

/**
 * What starting on template text would cost, per variable, said in the
 * refusal. The namespace is not secret-bearing and nothing is corrupted by an
 * unexpanded one, but it is checked here anyway: without it the operator gets a
 * 400 from the startup read, which reads as a server fault rather than a config
 * one, and the round trip carries their own config text into someone else's
 * logs first. It costs nothing in the other direction, because no legal
 * namespace can trip either rule (namespace.ts NAMESPACE_RE has no `$` in it).
 *
 * OPENRECALL_URL is deliberately left out. Template text there fails as a
 * transport error that quotes the URL it could not reach, which already names
 * the defect, and a URL is the one value here that can legitimately carry a
 * `$`.
 */
const MISEXPANSION_CHECKED = [
  'OPENRECALL_PASSPHRASE',
  'OPENRECALL_API_KEY',
  'OPENRECALL_NAMESPACE',
] as const

/**
 * OPENRECALL_PASSPHRASE_FILE shares the refusal but is checked on its own,
 * before the settings are resolved, because resolving them reads the file.
 */
const MISEXPANSION_STAKE: Record<
  (typeof MISEXPANSION_CHECKED)[number] | 'OPENRECALL_PASSPHRASE_FILE',
  string
> = {
  OPENRECALL_PASSPHRASE: 'Starting like this would write memory under a key nobody can reproduce.',
  OPENRECALL_PASSPHRASE_FILE:
    'Without it there is no passphrase to read, and the path in a file error would be the template text rather than anything to go and look at.',
  OPENRECALL_API_KEY:
    'Starting like this would send template text as the service key, which the server rejects.',
  OPENRECALL_NAMESPACE:
    'Starting like this would send that literal to the server as a namespace, and every read and write would fail against a name that does not exist.',
}

/**
 * Flatten server-chosen text before it goes into a diagnostic. An entry key
 * comes from the server, diagnostics go to a launcher's log, and a newline plus
 * an ANSI escape in one is a forged log line: this file's own ready line is
 * easy to imitate. Kept short too, since a key can be long and the operator
 * needs the sentence around it.
 */
function oneLine(text: string): string {
  return flattenServerText(text, 120)
}

/**
 * Check the configuration against the pinned namespace, returning either a
 * ready client or the one diagnostic that explains what to change.
 */
export async function preflight(env: Env = process.env): Promise<PreflightResult> {
  // Env over config file over defaults, the same resolution the CLI uses. A bad
  // URL or scan mode throws here. A scan mode that is cast rather than checked
  // builds a client whose secret scanner is in no recognized mode, silently
  // weakening the guard that keeps a live credential from being encrypted and
  // stored. Refusing is the only safe answer, so the settings error is the
  // diagnostic.
  //
  // The passphrase file's path is checked for template text first: resolving the
  // settings reads that file, and an unexpanded path would otherwise surface as
  // "could not be read" about text that is not a path at all.
  const fileVar = read(env, 'OPENRECALL_PASSPHRASE_FILE')
  if (fileVar && isUnexpanded(fileVar)) {
    return refuseMisexpanded('OPENRECALL_PASSPHRASE_FILE')
  }
  let settings: ReturnType<typeof resolveSettings>
  try {
    settings = resolveSettings(env)
  } catch (err) {
    if (err instanceof PassphraseFileError) return refuse(err.message)
    const message = (err as Error).message
    const badScan = /^invalid scan mode "([^"]*)"/.exec(message)
    if (badScan) {
      return refuse(
        `OPENRECALL_SCAN (or "scan" in the config file) is set to "${oneLine(badScan[1] ?? '')}", which is not a scan mode. ` +
          'Set it to one of block, warn, off, or leave it unset for block. ' +
          'Starting with an unrecognized mode would leave the secret scanner in no mode at all, so a live credential could be encrypted and stored without a word.',
      )
    }
    return refuse(message)
  }
  const url = describeTarget(settings)
  const namespace = settings.namespace
  const passphrase = settings.passphrase

  // Misexpansion, before anything is sent anywhere. Checked on the resolved
  // values, so a template that came from the config file is caught as well as
  // one from the launcher's environment.
  const resolved = {
    OPENRECALL_PASSPHRASE: passphrase,
    OPENRECALL_API_KEY: settings.apiKey,
    OPENRECALL_NAMESPACE: namespace,
  } as const
  for (const name of MISEXPANSION_CHECKED) {
    const value = resolved[name]
    if (value && isUnexpanded(value)) {
      return refuseMisexpanded(name)
    }
  }

  // Missing passphrase. Not a corruption risk (nothing can be read or
  // written without it), so the server still starts and its tools return the
  // fix; see server.ts.
  if (!passphrase) {
    return {
      ready: false,
      unconfigured: true,
      diagnostic:
        `OPENRECALL_PASSPHRASE (or OPENRECALL_PASSPHRASE_FILE) is not set and ${settings.configPath} holds none. Run \`openrecall init\` to create it. ` +
        'The passphrase is your zero-knowledge key, it never reaches the server, and without it nothing can be read or written.',
    }
  }

  // A hung server would otherwise block startup for the client default, which
  // is sized for a full 10 MB pull rather than for the small reads this makes.
  const rawTimeout = read(env, 'OPENRECALL_TIMEOUT_MS')
  let timeoutMs: number | undefined
  if (rawTimeout !== undefined) {
    // AbortSignal.timeout throws on a negative or enormous value, and that throw
    // would otherwise be reported as an unreachable server.
    timeoutMs = /^[0-9]+$/.test(rawTimeout) ? Number(rawTimeout) : Number.NaN
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 ** 31 - 1) {
      return refuse(
        `OPENRECALL_TIMEOUT_MS is "${oneLine(rawTimeout)}", which is not a number of milliseconds. ` +
          'Set it to a whole number between 1 and 2147483647, or leave it unset for the default.',
      )
    }
  }
  const client = await makeClient(settings, { timeoutMs })

  // One authenticated read of the pinned namespace separates a
  // transport failure from a refusal, and a rejected key from a namespace this
  // key does not own. They are debugged in completely different places.
  // Built once: an unmapped status can surface from either read, and two
  // copies of the same sentence are two chances for them to drift apart.
  const refuseHttp = (err: OpenRecallHttpError) =>
    refuse(
      `the openrecall server at ${url} refused the startup read of "${namespace}" with HTTP ${err.status} (${err.code}). ${err.message}`,
    )

  // A server that accepted the connection and then said nothing is neither
  // refusing nor absent. Reporting it as unreachable sends an operator to check
  // DNS and firewalls for a server that answered them.
  const refuseNoAnswer = (err: OpenRecallTimeoutError) =>
    refuse(
      `the openrecall server at ${url} accepted the connection but did not answer the startup ${err.operation} for "${namespace}" within ${err.timeoutMs}ms. ` +
        'The URL and the route are reachable, so this is the server or the link being slow or stuck rather than misconfiguration. ' +
        'Check the server, and raise OPENRECALL_TIMEOUT_MS if the link is simply slow.',
    )

  // Conditions that are worth telling the operator about but must not stop a
  // supported deployment from serving memory. The caller writes them to stderr.
  const warnings: string[] = []

  let checksums: Record<string, string>
  let supports: string[]
  try {
    ;({ checksums, supports } = await client.hashesAndSupports(namespace, { observe: false }))
  } catch (err) {
    if (err instanceof OpenRecallTimeoutError) return refuseNoAnswer(err)
    if (!(err instanceof OpenRecallHttpError)) {
      return refuse(
        `cannot reach the openrecall server at ${url}: ${(err as Error).message}. ` +
          'This is a transport failure, not a refusal: the server never answered. ' +
          'Check OPENRECALL_URL, name resolution, and whether the server is running.',
      )
    }
    if (err.status === 401) {
      return refuse(
        `the openrecall server at ${url} rejected the service key (HTTP 401). ` +
          'Change OPENRECALL_API_KEY. Your passphrase is not involved here, this is the account key, not the encryption key.',
      )
    }
    if (err.status === 403) {
      // Echoing the namespace is right on stderr, where an operator is reading
      // their own configuration. tools.ts withholds it on a 403 for the
      // opposite reason: that text goes into a model's context.
      return refuse(
        `the openrecall server at ${url} refused namespace "${namespace}" for this service key (HTTP 403). ` +
          'Point OPENRECALL_NAMESPACE at a namespace this key owns, or use the key that owns this one.',
      )
    }
    return refuseHttp(err)
  }

  // A non-blocking scan against a store that cannot erase. On fs and s3 a
  // credential the scanner merely warned about can be deleted afterwards. On a
  // retaining store (the node driver) it stays in repository history and in any
  // pin already taken, so `warn` and `off` promise a cleanup this deployment
  // cannot perform. Refused at startup rather than left to the first write,
  // because the operator is configuring the server now rather than after a
  // secret has already landed somewhere permanent.
  //
  // No extra request: this is what the hashes view above already reported, so
  // the bounded read count this startup path is pinned to stays unchanged.
  const erasure: Erasure | null = client.storeErasure()
  if (erasure === 'retains' && settings.scan !== 'block') {
    return refuse(
      `OPENRECALL_SCAN is "${settings.scan}", but the store behind ${url} cannot erase what it stores: ` +
        'a delete removes an entry from the namespace and leaves its prior ciphertext in repository ' +
        'history, and in any pin or anchor already taken. A secret this scanner only warned about ' +
        'could therefore never be removed. Set OPENRECALL_SCAN=block, or point this server at a store that erases.',
    )
  }

  // Undecryptable namespace. This can only run once the read above reports
  // entries: against an empty namespace nothing exists to authenticate, so a
  // wrong passphrase is indistinguishable from a first-run one and starting is
  // the correct answer. Nothing is lost by it, because the first save is what
  // fixes the key for that namespace.
  const listed = Object.keys(checksums).sort()
  if (listed.length > 0) {
    // Reading one entry proves the passphrase, so the proof is a probe rather
    // than a download. `pull` fetched every body to learn one thing, and a
    // namespace caps at 10 MB, which every agent session paid before its first
    // tool call.
    //
    // Which key: sorted order, stopping at the first that decrypts, and at most
    // PROBE_LIMIT of them. Sorted because startup must not pass on one launch
    // and fail on the next against the same server, which is what picking at
    // random would do. More than one because a single drifted entry must not
    // condemn a namespace whose other entries are fine. Capped because the cost
    // has to stay bounded, and a namespace whose first several entries are all
    // unreadable is broken enough to stop for.
    //
    // What this gives up against the old full read: drift AFTER the first
    // readable entry is never looked at, so the warning below reports only what
    // the probe walked past. That is the price of not downloading everything.
    const unreadable: string[] = []
    let proven = false
    for (const key of listed.slice(0, PROBE_LIMIT)) {
      try {
        // An older server ignores view=entry and answers with the whole
        // namespace, which the client cannot read as one entry. It does not
        // advertise `entry-view`, so prove the passphrase with the full read
        // instead of refusing to start against a server that works.
        if (supports.includes('entry-view')) await client.entry(namespace, key)
        else await client.pull(namespace)
        proven = true
        break
      } catch (err) {
        if (err instanceof OpenRecallTimeoutError) return refuseNoAnswer(err)
        if (err instanceof OpenRecallDecryptError) {
          // The one failure the passphrase is entitled to be blamed for.
          return refuse(
            `OPENRECALL_PASSPHRASE cannot decrypt the existing entries in namespace "${namespace}" (entry "${oneLine(err.entryKey)}": ${oneLine(err.reason)}). ` +
              'Set the passphrase this namespace was created with. ' +
              'Refusing to start, because saving under a second key would leave the namespace unreadable by the correct passphrase as well.',
          )
        }
        if (err instanceof OpenRecallHttpError) {
          // The manifest names it and the store cannot produce it, or the
          // server no longer has it at all. Neither says anything about the
          // passphrase, so try the next key rather than concluding.
          if (err.code === 'entry_unreadable' || err.code === 'entry_not_found') {
            unreadable.push(key)
            continue
          }
          return refuseHttp(err)
        }
        // Everything else that can break this read must not be blamed on the
        // passphrase: acting on that advice after a transient failure is what
        // creates the mixed-key namespace.
        return refuse(
          `the startup read of namespace "${namespace}" from ${url} failed before anything could be decrypted: ${oneLine((err as Error).message)}. ` +
            'This is a transport or response failure, not a passphrase problem, so do not change OPENRECALL_PASSPHRASE on the strength of it. ' +
            'Retry, and check the server and the network between you and it.',
        )
      }
    }

    if (!proven) {
      return refuse(
        `the openrecall server at ${url} lists ${listed.length} entr${listed.length === 1 ? 'y' : 'ies'} in namespace "${namespace}" but served none of the ${unreadable.length} it was asked for, ` +
          'so nothing was decrypted and the passphrase could not be checked. ' +
          'This is server-side drift, not a passphrase problem: the manifest names entries whose stored bodies are gone. ' +
          'Restore the namespace from a backup, or point OPENRECALL_NAMESPACE somewhere else. ' +
          'Refusing to start, because a save into this namespace could not be verified against anything.',
      )
    }

    if (unreadable.length > 0) {
      warnings.push(
        `the openrecall server at ${url} could not serve ${unreadable.map(oneLine).join(', ')} in namespace "${namespace}", though the manifest names ${listed.length === 1 ? 'it' : 'them'}. ` +
          'Those entries are missing from memory until the namespace is restored, and any others past the first readable one were not checked.',
      )
    }
  }

  // Whether this deployment enforces the write precondition. Never fatal: a
  // server too old to advertise it is supported, and memory works. But it
  // accepts a save that overwrites a newer entry without saying so, and an
  // operator who thinks the guarantee is in force should hear otherwise once at
  // startup rather than after losing a write. Read off the first hashes read,
  // so it costs no request.
  if (!supports.includes('base-precondition')) {
    warnings.push(
      `the openrecall server at ${url} does not enforce the write precondition, so a save that overwrites a newer version of an entry is accepted silently. ` +
        'Memory works; upgrade the server to get the stale-write guarantee back.',
    )
  }

  return { ready: true, client, url, namespace, warnings }
}

function refuseMisexpanded(name: keyof typeof MISEXPANSION_STAKE): PreflightResult {
  return refuse(
    `${name} still holds an unexpanded variable reference, so this server was launched with template text instead of a value. ` +
      'Set the variable in the environment that launches the MCP server, or put the value itself in the config. ' +
      MISEXPANSION_STAKE[name],
  )
}

function refuse(diagnostic: string): PreflightResult {
  return { ready: false, diagnostic }
}
