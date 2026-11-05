/**
 * Per-process session state for the memory tools.
 *
 * One MCP server process serves one agent session, so what the tools need to
 * know about "who is calling" and "what has happened so far in this process"
 * lives here rather than in any store: which agent this is (for the `agent:`
 * stamp on every save), a random id that ties the notes written in one
 * session together (`session:`), the project namespaces `memory_project` has
 * opened (the routing check in `memory_save` reads it), and the access stamps
 * recall and get have collected and not yet flushed to the sidecar (see
 * `./accessed.ts`).
 *
 * The agent label is `name/version` from the MCP client's `initialize`
 * request, read through a getter because the server object that holds it is
 * built after the tools are. The SDK populates it before any tool call, so
 * the first save already carries it. `OPENRECALL_AGENT` in the environment
 * overrides it (a launcher that wraps several agents behind one client name
 * can say which), and `unknown` is the label when neither is available. The
 * label is bounded and stripped of control characters: it is written into a
 * frontmatter scalar, and the client name is text another program chose.
 *
 * The session id is `s` followed by eight Crockford base32 characters (40
 * bits) from `node:crypto`, made once per process. It is an identifier, not a
 * secret, and it never reaches the server in cleartext: it travels only inside
 * the encrypted note body.
 */

import { randomBytes } from 'node:crypto'

export type AgentInfo = { name: string; version: string }

export type SessionOptions = {
  /** Reads the MCP client's `initialize` info; undefined until a client has connected. */
  agent?: () => AgentInfo | undefined
  /** The process environment, for `OPENRECALL_AGENT`. */
  env?: Record<string, string | undefined>
}

export type Session = {
  /** `name/version` of the connected agent, or the env override, else `unknown`. */
  agentLabel(): string
  /** `s` + 8 Crockford base32 characters, fixed for the life of the process. */
  readonly sessionId: string
  /** Project namespaces `memory_project` opened in this process. */
  readonly openedProjects: Set<string>
  /** namespace -> (key -> YYYY-MM-DD): accesses not yet flushed to the sidecar. */
  readonly pendingAccess: Map<string, Map<string, string>>
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const SESSION_ID_CHARS = 8
const MAX_LABEL = 80
export const UNKNOWN_AGENT = 'unknown'

/** A fresh session id: `s` plus eight Crockford base32 characters. */
export function newSessionId(): string {
  const bytes = randomBytes(SESSION_ID_CHARS)
  let out = 's'
  for (let i = 0; i < SESSION_ID_CHARS; i++) out += CROCKFORD[(bytes[i] as number) % 32]
  return out
}

/**
 * One line of printable text, at most `MAX_LABEL` characters: control
 * characters and line breaks removed, whitespace runs folded to one space,
 * trimmed. Empty after that means "nothing usable".
 */
function cleanLabel(raw: string): string {
  let out = ''
  for (const ch of raw) {
    const c = ch.codePointAt(0) as number
    if (c < 0x20 || c === 0x7f) continue
    out += ch
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL)
}

/** The `name/version` label for an agent, or '' when nothing usable is known. */
export function agentLabelOf(info: AgentInfo | undefined): string {
  if (!info) return ''
  const name = cleanLabel(String(info.name ?? ''))
  if (!name) return ''
  const version = cleanLabel(String(info.version ?? ''))
  return (version ? `${name}/${version}` : name).slice(0, MAX_LABEL)
}

export function makeSession(options: SessionOptions = {}): Session {
  const override = cleanLabel(options.env?.OPENRECALL_AGENT ?? '')
  const getter = options.agent
  return {
    agentLabel(): string {
      if (override) return override
      let info: AgentInfo | undefined
      try {
        info = getter?.()
      } catch {
        info = undefined
      }
      return agentLabelOf(info) || UNKNOWN_AGENT
    },
    sessionId: newSessionId(),
    openedProjects: new Set<string>(),
    pendingAccess: new Map<string, Map<string, string>>(),
  }
}
