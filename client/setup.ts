/**
 * Setup card: the block a first-time user pastes into an agent's MCP config.
 *
 * This lives in openrecall rather than in the onboarding console for one reason:
 * the passphrase. The console knows the user's service key and could happily
 * render a card server-side, but then the passphrase would either be generated
 * on the server or travel back to it, and the whole point of this project is
 * that neither ever happens. So the card is produced by a pure function here,
 * the console calls it client-side, and the CLI calls the same function for
 * self-hosters. The render function takes no passphrase at all: there is no
 * parameter to accidentally fill in and no value to serialize, which is the
 * mechanism, not a convention.
 *
 * Two other rules the card carries:
 *   - The namespace is pinned under the owner's own subtree, because the
 *     server grants a non-local owner exactly `user:<owner>` and its children
 *     (see authorizeNamespace in src/auth.ts). The built-in `user:me` default
 *     is unauthorized for every hosted user, so a card that omitted the
 *     namespace would fail on the first save.
 *   - The service URL must be https, since the key travels in a header. Plain
 *     http is allowed only against a loopback host, where there is no network
 *     to listen on and a self-hoster is just running the server locally.
 *
 * No module-level dependencies on purpose: this file reaches nothing that can
 * open a socket, which is what makes "the passphrase never leaves the process"
 * a structural property rather than a promise.
 */

/** The agent configs this card is written for. Both take the same MCP block. */
export type SetupTarget = 'openclaude' | 'zero'

export type SetupCardInput = {
  /** The owner id the service key resolves to. Pins the namespace. */
  owner: string
  /** Service URL. https, or http against loopback. */
  url: string
  /** The service key issued by the console. Public-ish: it identifies, it does not decrypt. */
  apiKey: string
  /** Example repository name for the per-codebase namespace convention. */
  repo?: string
}

/**
 * 32 characters: a-z without l and o, digits 2-9. Ambiguous glyphs are out
 * because people retype this off a screen. 32 is a power of two, so a random
 * byte maps to an index with no modulo bias and no rejection loop.
 */
export const PASSPHRASE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

/** 26 characters over a 32-character alphabet is 26 * 5 = 130 bits. */
export const PASSPHRASE_LENGTH = 26

/**
 * Generate a passphrase from platform randomness. Local only, and the caller
 * is the only thing that ever sees the return value.
 */
export function generateRetypablePassphrase(): string {
  const bytes = new Uint8Array(PASSPHRASE_LENGTH)
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += PASSPHRASE_ALPHABET[b % PASSPHRASE_ALPHABET.length]
  return out
}

/**
 * The namespace-grammar rule this module reimplements rather than reuses.
 *
 * The real rules live server-side and stay the authority: validateNamespace in
 * src/namespace.ts (the `^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9._/-]{1,128}$`
 * grammar plus a hard reject of `..` and `//`), and authorizeNamespace in
 * src/auth.ts:128-133, which compares the owner as a WHOLE path segment
 * terminated by end-of-string or `/`. This file reaches neither, because it
 * reaches nothing at all: the zero-dependency rule above is what makes "the
 * passphrase never leaves the process" structural. So the check below is a
 * deliberate duplicate, and this comment is the pointer that keeps it
 * traceable rather than letting it drift silently.
 *
 * Narrowed to a single path segment: the server's character set minus `/`,
 * which cannot appear here because a `/` in the owner moves the very segment
 * authorizeNamespace matches on (`alice/../bob` renders `user:alice/../bob`,
 * which the auth rule grants to alice while storage reads it as somewhere
 * else). The first character is alphanumeric, the shape validateEntryKey uses,
 * so `.` and `-` cannot lead. 63 is the cap because `<owner>/<repo>` has to fit
 * the server's 128-character budget after the scope.
 *
 * Fail-closed by allowlist, since the space of bad names is open-ended, and
 * refused rather than sanitized: a rewritten owner is a namespace the user did
 * not ask for, and it would fail at the first save with nothing to read.
 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

function assertName(kind: 'owner' | 'repo', value: string): string {
  if (typeof value === 'string' && NAME_RE.test(value) && !value.includes('..')) return value
  throw new Error(
    `setup: ${JSON.stringify(value)} is not a usable ${kind}. A ${kind} is 1 to 63 characters of ` +
      `letters, digits, '.', '-' or '_', starting with a letter or a digit. The server refuses ` +
      `anything else, so the card refuses it here rather than at your first save.`,
  )
}

/** The owner's whole-memory namespace. */
export function ownerNamespace(owner: string): string {
  return `user:${assertName('owner', owner)}`
}

/**
 * One memory set per codebase, beneath the owner's subtree. One namespace for
 * everything mixes every project into a single recall corpus, which is the
 * fastest way to make recall useless for the developer this is built for.
 *
 * The form is `user:<owner>/<repo>`, the same one skills/openrecall-memory/SKILL.md
 * gives the model. These two surfaces once disagreed (the card said
 * `user:<owner>/repo/<repo>`), which put the same repository's memory in two
 * subtrees and made recall come back empty with no error anywhere. The test in
 * tests/setup-card.test.ts reads the form out of the guide rather than
 * restating it, so they cannot drift apart again.
 */
export function repoNamespace(owner: string, repo: string): string {
  return `user:${assertName('owner', owner)}/${assertName('repo', repo)}`
}

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost') return true
  if (hostname === '[::1]') return true
  return LOOPBACK_V4.test(hostname)
}

/**
 * Return the URL unchanged if it is safe to put in a card, throw otherwise.
 * Fail-closed: anything that is not a parseable https URL, or plain http to a
 * loopback host, is refused rather than reasoned about.
 */
export function assertServiceUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`setup: ${url || '(empty)'} is not a URL. Use an https URL.`)
  }
  // No credentials in the URL. The service key already has its own env var in
  // the block, and the block is a file the user pastes around and copies
  // between machines, so a second copy of a credential riding in the URL is
  // just spread with nothing reading it from there. Refused, not stripped, for
  // the same reason the owner is: a quietly rewritten URL is not the one the
  // caller asked for. Checked before the protocol rules, so the loopback
  // exemption (which is about there being no network to listen on) does not
  // excuse it.
  if (parsed.username !== '' || parsed.password !== '')
    throw new Error(
      `setup: the service URL must not carry a username or password. Put the service key in ` +
        `OPENRECALL_API_KEY in the block, not in OPENRECALL_URL.`,
    )
  if (parsed.protocol === 'https:') return url
  if (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)) return url
  throw new Error(
    `setup: ${url} is refused. The service URL must be https (plain http is allowed only for a loopback host).`,
  )
}

/**
 * Render the pasted block plus the notes a first-time user needs. No
 * passphrase parameter, by design: the block carries a placeholder and the
 * caller shows the generated value separately, in the one place it exists.
 */
export function renderSetupCard(target: SetupTarget, input: SetupCardInput): string {
  const url = assertServiceUrl(input.url)
  const owner = ownerNamespace(input.owner)
  const perRepo = repoNamespace(input.owner, input.repo ?? 'my-repo')
  const env = [
    ['OPENRECALL_URL', url],
    ['OPENRECALL_API_KEY', input.apiKey],
    ['OPENRECALL_PASSPHRASE', '<paste your passphrase here>'],
    ['OPENRECALL_NAMESPACE', owner],
    ['OPENRECALL_SCAN', 'block'],
  ]
    .map(
      ([k, v], i, all) =>
        `        ${JSON.stringify(k)}: ${JSON.stringify(v)}${i === all.length - 1 ? '' : ','}`,
    )
    .join('\n')

  return `openrecall setup for ${target}

Paste this into your MCP config:

{
  "mcpServers": {
    "openrecall": {
      "command": "bunx",
      "args": ["-y", "@twigpine/openrecall", "mcp"],
      "env": {
${env}
      }
    }
  }
}

Namespace. ${owner} is your whole memory, and it is the only subtree your key
can reach. For one memory set per codebase, set OPENRECALL_NAMESPACE to
${perRepo} in that repository's config. Anything outside
${owner} is refused by the server.

Passphrase. It is generated on your machine, is never sent to the service, and
cannot be recovered. Put it in OPENRECALL_PASSPHRASE above and back it up now. If
you lose it, everything stored under this account stays encrypted forever, to
you and to us alike.
`
}
