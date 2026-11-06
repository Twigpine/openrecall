/**
 * openrecall memory tools, decoupled from the MCP transport so they can be unit
 * tested directly against an OpenRecallClient. server.ts wraps each result into the
 * MCP content shape; everything substantive lives here.
 *
 * All encryption/decryption happens inside the OpenRecallClient in THIS process,
 * which holds the passphrase. The remote server only ever sees ciphertext, so
 * recall/search must run locally on decrypted entries — which is exactly what
 * these tools do.
 */

import {
  flattenServerText,
  type OpenRecallClient,
  OpenRecallHttpError,
  OpenRecallProtocolError,
  OpenRecallTimeoutError,
  type PullOptions,
  type PullResult,
  type PushResult,
} from '../../client/index.ts'
import { SecretFoundError } from '../../client/secretscan.ts'
import { validateNamespace } from '../namespace.ts'
import {
  ACCESS_FLUSH_THRESHOLD,
  flushAccessed,
  mergeAccessed,
  noteAccess,
  parseAccessed,
  serializeAccessed,
  settleAccess,
  today,
} from './accessed.ts'
import {
  DEFAULT_CAPS,
  DEFAULT_MAX_CHARS,
  type DoctorInput,
  type DoctorMarker,
  type DoctorMarkers,
  type DoctorReport,
  isDue,
  markerKey,
  readMarker,
  renderReport,
  runDoctorAll,
  writeMarker,
} from './doctor.ts'
import {
  type FmValue,
  FrontmatterError,
  inferType,
  type NoteType,
  parseFrontmatter,
  serializeFrontmatter,
  stampForSave,
} from './frontmatter.ts'
import {
  type Candidate,
  findCandidates,
  type GateNote,
  type NoteProfile,
  profileNote,
  renderCandidate,
  renderNeedsDecision,
} from './gate.ts'
import {
  ACCESSED_KEY,
  INDEX_KEY,
  isHiddenKey,
  isSystemKey,
  LEGACY_INDEX_KEY,
  SYSTEM_PREFIX,
  TRASH_PREFIX,
  trashKey,
} from './keys.ts'
import {
  generateIndex,
  type IndexNote,
  indexNoteOf,
  linkTarget,
  MAX_BYTES,
  MAX_LINES,
  MAX_PINNED,
  parseIndex,
} from './memindex.ts'
import {
  type IndexDoc,
  isInactive,
  type NoteMeta,
  noteMeta,
  RecallIndex,
  stripFrontmatterText,
  tokenize,
  tokenizeAll,
} from './relevance.ts'
import { neutralize } from './sanitize.ts'
import { makeSession, type Session } from './session.ts'

export type ToolResult = { text: string; isError?: boolean; timings?: Timings }

/**
 * Where one tool call's time went, in milliseconds, so a slow call is blamed
 * on the stage that was slow rather than on "memory". Every tool reports it on
 * every path out, refusals included; server.ts carries it in the result's
 * `_meta`, which a model never sees, so measuring costs no context.
 */
export type Timings = {
  /** The client call: transport plus, for a pull, the JSON parse. */
  fetch: number
  /** The AES-GCM pass over every entry the call decrypted. */
  decrypt: number
  /** Tokenizing and scoring the corpus (recall), or matching (search). */
  rank: number
  /** Region selection and output budgeting (recall). */
  format: number
  /** Wall time of the whole call. */
  total: number
  /** Entries the call read or scored. */
  entries: number
  /** Response bytes the call fetched. */
  bytes: number
}

type Stage = 'fetch' | 'decrypt' | 'rank' | 'format'

const round = (ms: number) => Math.round(ms * 100) / 100

/** One call's stopwatch. Stages accumulate, so a stage entered twice adds up. */
class Timer {
  private readonly started = performance.now()
  private readonly ms: Record<Stage, number> = { fetch: 0, decrypt: 0, rank: 0, format: 0 }
  entries = 0
  bytes = 0

  async time<T>(stage: Stage, fn: () => T | Promise<T>): Promise<T> {
    const t = performance.now()
    try {
      return await fn()
    } finally {
      this.ms[stage] += performance.now() - t
    }
  }

  /**
   * Credit a pull. The client splits its own time into fetch, parse and
   * decrypt; a client without that breakdown (a test double) is charged
   * entirely to fetch, from the elapsed time the caller measured around it.
   */
  pulled(r: PullResult, elapsedMs: number): void {
    this.entries += Object.keys(r.entries).length
    if (r.timings) {
      this.ms.fetch += r.timings.fetchMs + r.timings.parseMs
      this.ms.decrypt += r.timings.decryptMs
      this.bytes += r.timings.bytes
    } else {
      this.ms.fetch += elapsedMs
    }
  }

  done(): Timings {
    return {
      fetch: round(this.ms.fetch),
      decrypt: round(this.ms.decrypt),
      rank: round(this.ms.rank),
      format: round(this.ms.format),
      total: round(performance.now() - this.started),
      entries: this.entries,
      bytes: this.bytes,
    }
  }
}

/**
 * Hand a tool body a Timer and attach what it measured to the result, on every
 * path out of the body including refusals, so a slow failure is as visible as
 * a slow success. The body's parameters after the timer are the tool's own
 * parameters, so the wrapper changes nothing server.ts binds.
 */
const timed =
  <A extends unknown[]>(body: (timer: Timer, ...args: A) => Promise<ToolResult>) =>
  async (...args: A): Promise<ToolResult> => {
    const timer = new Timer()
    const r = await body(timer, ...args)
    return { ...r, timings: timer.done() }
  }

/**
 * The client surface these tools actually use. Declared structurally, and
 * narrowed to the four methods, so a test double is checked against the real
 * client's signatures by the compiler instead of being waved through with an
 * `as unknown as OpenRecallClient` cast. Two stubs had already drifted under those
 * casts (one returning `skipped` where `PushResult` says `unchanged`, and
 * omitting `namespace`), which is exactly the drift a cast hides. `delete` is
 * not among them: every delete goes through `push` with a deletion, because it
 * carries the regenerated index in the same request.
 */
export type MemoryClient = Pick<OpenRecallClient, 'pull' | 'push' | 'hashes' | 'entry'>

/** Entry order by key. Not the default sort, which compares "key,value" pairs. */
const byKey = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : 1)

/**
 * What text the SERVER chose is allowed to put into a model's context.
 *
 * Everything a refusal renders (the message, the error code, and the entry keys
 * and hashes a 409 names) is read off a response body, so a broken or hostile
 * server writes straight into the conversation unless it passes through here.
 * Newlines and escapes are the sharp part: they let that text forge turns or
 * instructions rather than merely be long.
 *
 * It covers the typed paths as well as the unrecognized-failure path: those
 * are the ones a server can actually steer, since it chooses the status that
 * selects them.
 */
export function bounded(message: string, max = 300): string {
  return flattenServerText(message, max)
}

/**
 * How many keys a refusal may name. A server choosing to answer with thousands
 * of conflicts would otherwise fill a model's context with a single tool
 * result, each entry short and the total unbounded.
 */
const MAX_LISTED = 5

const ok = (text: string): ToolResult => ({ text })
const fail = (text: string): ToolResult => ({ text, isError: true })

/**
 * The subtree a key actually reaches, derived from the configured namespace.
 *
 * `authorizeNamespace` grants an owner `user:<owner>` and its children, so the
 * prefix is the owner root, never the configured namespace itself. The guide
 * and the setup card both ask a developer to run one namespace per codebase,
 * which makes a configured `user:alice/openrecall` the normal case; naming that as
 * the limit would be false and would send the model to retarget inside a
 * subtree narrower than the one it has.
 *
 * A namespace that is not `user:`-scoped has no owner root at all: a non-local
 * key is granted `user:<owner>` and nothing else, and `hasAclGrant` is a closed
 * door, so no `repo:`/`agent:` namespace is reachable. Returning the namespace
 * unchanged there would promise a subtree the server can never grant, so this
 * returns null and the caller says so instead.
 */
function ownerRoot(namespace: string): string | null {
  if (!namespace.startsWith('user:')) return null
  const slash = namespace.indexOf('/')
  return slash === -1 ? namespace : namespace.slice(0, slash)
}

/**
 * Render a server refusal as text a model can act on.
 *
 * One string wrapping the raw JSON body tells a model that something went
 * wrong and nothing about what to do next: a stale write, a wrong API key and a
 * rate limit would all read the same. Each status gets its own text with its
 * own recovery move.
 *
 * The 403 text deliberately does NOT echo the namespace that was refused. A
 * denial is the one moment the caller is provably reaching outside its own
 * subtree, so repeating the target would feed another owner's namespace back
 * into the model's context; it names the prefix this deployment is authorized
 * for instead, or, when this deployment is configured for a namespace no key
 * can be granted at all, says that and hands the problem to the user.
 *
 * Returns null when the error is not a typed HTTP refusal, so the caller keeps
 * its generic message rather than dressing up an unknown failure.
 */
export function denial(
  action: string,
  namespace: string,
  configured: string,
  tail: string,
  e: unknown,
): string | null {
  if (e instanceof OpenRecallTimeoutError) {
    // A write that timed out may still have been applied. Saying only "failed"
    // invites a blind retry, so name the unknown outcome and the safe move.
    if (e.operation === 'push' || e.operation === 'delete') {
      return `${action} got no answer from the server within ${e.timeoutMs}ms, so it is unknown whether the change was applied. Re-read ${namespace} with memory_get before trying again. ${tail}`
    }
    return `${action} got no answer from the server within ${e.timeoutMs}ms. Try once more, and if it repeats tell the user the memory server is not responding. ${tail}`
  }
  if (!(e instanceof OpenRecallHttpError)) return null
  const authorized = ownerRoot(configured)
  if (e.status === 401) {
    // The model cannot edit the server's environment or restart the process,
    // so an instruction to do that is not a move it has. Like the 429 text,
    // this one hands the problem to the user and stops the loop.
    return `${action} refused: the server did not accept this API key (401 unauthorized). Retrying with the same key cannot succeed and no other namespace will help, so stop using the memory tools this session and tell the user the openrecall API key is being rejected and needs replacing. ${tail}`
  }
  if (e.status === 403) {
    if (authorized === null) {
      return `${action} refused: this key can reach only its own user: namespace, and ${configured} is not one, so nothing under it is reachable either (403 forbidden). No retry and no other key here can succeed, so tell the user this openrecall server is configured for ${configured} and has to point at a namespace under the key owner's own user: subtree instead. ${tail}`
    }
    return `${action} refused: this key may only reach ${authorized} and namespaces under it (403 forbidden). Retarget the tool at a namespace under ${authorized}. ${tail}`
  }
  if (e.status === 409) {
    return `${action} refused: the memory changed on the server after this session last read ${namespace}, so the base this write was computed from is out of date (409 stale base). ${conflictLines(e.details)}${sentBaseLine(e.details)} Re-read each conflicting key with memory_get (recall returns clipped regions, not whole entries), reapply this change on top of what is stored now, and save again. ${tail}`
  }
  if (e.status === 429) {
    return `${action} refused: the server is rate limiting this key (429 rate limited). Do not retry now and do not retry in a loop; wait for the limit to reset, and tell the user memory writes are paused. ${tail}`
  }
  if (e.status === 413) {
    return `${action} refused: this write would exceed a storage limit on ${namespace} (413 quota: ${bounded(e.code, 40)}). Delete or shorten stored entries before saving again, or save less content. ${tail}`
  }
  return null
}

/**
 * What this client wrote against, when it sent a base at all.
 *
 * A first write into a namespace this client never read carries no base, so
 * there is nothing to name and this adds nothing rather than inventing one.
 */
function sentBaseLine(details: Record<string, unknown> | undefined): string {
  const raw = details?.sentBase
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return ''
  const all = Object.entries(raw as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'string')
    .sort(byKey)
  const parts = all
    .slice(0, MAX_LISTED)
    .map(([k, v]) => `"${bounded(k, 120)}" at ${bounded(v as string, 80)}`)
  if (parts.length === 0) return ''
  const more = all.length > parts.length ? ` and ${all.length - parts.length} more` : ''
  return ` This write was computed against ${parts.join(', ')}${more}.`
}

/** What the server says each conflicting key holds now, or that it said nothing. */
function conflictLines(details: Record<string, unknown> | undefined): string {
  const raw = details?.conflicts
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'The server did not name the conflicting keys.'
  }
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length === 0) return 'The server did not name the conflicting keys.'
  const sorted = entries.sort(byKey)
  const parts = sorted
    .slice(0, MAX_LISTED)
    .map(
      ([k, v]) =>
        `"${bounded(k, 120)}" now holds ${typeof v === 'string' ? bounded(v, 80) : 'no entry'}`,
    )
  const more = sorted.length > parts.length ? ` and ${sorted.length - parts.length} more` : ''
  return `Changed since this session read it: ${parts.join(', ')}${more}.`
}

/**
 * A key the server refused inside an otherwise-successful push.
 *
 * The server answers 200 for a write it stored nothing of, listing the refused
 * keys in `skipped` (`src/memory.ts`). Reading only `uploaded` therefore renders
 * the denial as "saved", or as "unchanged" once the client filters the key out,
 * and either way the model is told its memory is safe when nothing was written.
 * Each reason gets the move that actually clears it.
 */
function skippedText(key: string, namespace: string, reason: string): string {
  const head = `Saving "${bounded(key, 120)}" to ${namespace} was refused by the server (${bounded(reason, 80)}), and nothing was stored.`
  if (reason === 'entry_too_large') {
    return `${head} Save less content under this key, or split it across several smaller entries and save those.`
  }
  if (reason === 'invalid_key') {
    return `${head} Save it under a different entry key: a plain relative path such as notes/topic.md that starts with a letter or digit and uses only letters, digits, ".", "_", "/", and "-", with no "..", no "//", no leading or trailing "/", and no backslash.`
  }
  // invalid_base64 means this client sent something the server could not read,
  // which no choice of key or content on the model's side fixes.
  return `${head} Retrying the same request cannot succeed, so tell the user memory writes to ${namespace} are failing.`
}

/**
 * A namespace that answers with no entries at a version past zero.
 *
 * The server drops any entry whose stored body is missing from the full read,
 * so a namespace whose blobs are gone reads exactly like one that was never
 * written. Reporting that as "no memory yet" tells a model its memory does not
 * exist, and a model told that will save over it. A namespace that genuinely
 * has nothing is still at version 0, which is how the two are told apart.
 *
 * `list` is deliberately not routed through this: it reads the manifest, so it
 * still names the keys, which is the true answer there.
 */
function unservable(ns: string, version: number): string {
  return (
    `${ns} is not empty, but the server could not serve any of its entries (version ${version}). ` +
    'This is server-side data loss, not an empty namespace, so do not treat it as a fresh start and ' +
    'do not save over it. Tell the user their stored memory is unreadable and needs restoring.'
  )
}

/**
 * Whether a read that came back with no entries at a version past zero is
 * really lost data. A namespace whose last entry was deleted looks the same
 * (version bumped, no entries) and is simply empty, so ask the manifest: only a
 * manifest that still names entries means the bodies are gone. The manifest
 * read is not recorded as the caller's base.
 */
async function lostEntries(
  client: MemoryClient,
  ns: string,
  version: number,
): Promise<string | null> {
  if (version === 0) return null
  const named = Object.keys(await client.hashes(ns, { observe: false }))
  return named.length > 0 ? unservable(ns, version) : null
}

/**
 * The single-entry counterpart of `unservable`: the manifest names this key
 * and the store cannot produce its body. The old pull-based read could not say
 * this; it rendered the key as missing whenever any other blob was readable,
 * which is the one answer that invites a model to save over lost data.
 */
function unreadableEntry(key: string, ns: string): string {
  return (
    `"${key}" in ${ns} is named by the namespace index, but the server could not serve its body. ` +
    'This is server-side data loss, not a missing entry, so do not save over it. ' +
    'Tell the user this entry is unreadable and needs restoring.'
  )
}

/** A refusal already rendered for the model, carried through a nested catch. */
class Rendered extends Error {}

function snippet(content: string, max = 200): string {
  const oneLine = content.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/**
 * Recall's output budgets, in characters.
 *
 * Recall is the one tool whose output size an entry author controls rather than
 * the caller: `memory_get` is bounded by naming one key, `search` by its own
 * 200-char snippet, but recall returns up to `limit` bodies chosen by the
 * ranker. With entries accepted up to 250,000 bytes and `limit` reaching 20,
 * an unbounded formatter lets a crafted namespace push megabytes into the
 * agent's context through a single call. These two numbers are that bound.
 *
 * Measured over a real 301-entry store: paragraphs run 310 chars median and 766
 * at p90, heading sections 838 and 2,258, and both distributions have maxima
 * near 50,000. So the median region fits comfortably in 600 while the tail is
 * cut, which is the intended trade: the tail is where a whole-body dump would
 * have come from, and nothing is lost because every hit that gets clipped says
 * so and names the key `memory_get` returns whole.
 *
 * 4,000 in aggregate is roughly a thousand tokens, small enough that a
 * `limit`-20 recall cannot dominate a context window and large enough that the
 * default `limit` of 5 never reaches it (5 x 600 = 3,000).
 */
const PER_HIT_CHARS = 600
const AGGREGATE_CHARS = 4000

/** Placeholder for a fenced block that will not fit; never half a code block. */
const ELIDED_FENCE = '[code block elided; memory_get returns this entry whole]'

/** Shortest region worth emitting. Below this a hit is omitted, not stubbed. */
const MIN_REGION_CHARS = 80

type Block = { text: string; heading: string; fence: boolean }

/**
 * Split a body into candidate regions: blank-line-separated paragraphs, each
 * tagged with the heading it sits under. A fenced block is one atomic block
 * even when it contains blank lines, so a region boundary can never fall inside
 * a fence, and an unterminated fence runs to the end of the entry rather than
 * silently re-opening the paragraph splitter.
 */
function blocksOf(body: string): Block[] {
  const blocks: Block[] = []
  let heading = ''
  let buf: string[] = []
  let fence = ''
  const flush = (isFence: boolean) => {
    const text = buf.join('\n').trim()
    buf = []
    if (text) blocks.push({ text, heading, fence: isFence })
  }
  for (const line of body.split('\n')) {
    if (fence) {
      buf.push(line)
      if (line.trimStart().startsWith(fence)) {
        flush(true)
        fence = ''
      }
      continue
    }
    const open = /^ {0,3}(```+|~~~+)/.exec(line)
    if (open) {
      flush(false)
      fence = open[1]
      buf.push(line)
      continue
    }
    if (!line.trim()) {
      flush(false)
      continue
    }
    if (/^#{1,6}\s/.test(line)) {
      flush(false)
      heading = line.trim()
      continue
    }
    buf.push(line)
  }
  flush(fence !== '')
  return blocks
}

/**
 * The block carrying the strongest query-term match, earliest on a tie.
 *
 * A term is weighted by how few of this entry's blocks contain it, which is the
 * same rarity idea the ranker applies across entries, applied here within one.
 * That is what keeps a word repeated in every paragraph (the entry's own topic)
 * from outvoting the rare word that actually located the answer.
 *
 * Function words count here, but only as a tiebreak. Which entry answers a query
 * says nothing about its function words, which is why the ranker drops them.
 * Which REGION of an already-chosen entry answers it often turns on exactly
 * those words: "Before you push" and "After you push" are the same section once
 * the stoplist has run, so the query "after I push" got the first one by
 * tie-break and answered the opposite of what was asked.
 *
 * They cannot be scored alongside topical terms, though. Within-entry rarity
 * hands its highest weight to a term confined to one block, which is the usual
 * shape of a function word in an entry about one subject, so scoring them
 * together let a query's "should" outweigh its "retry" and return the paragraph
 * with nothing to do with the question. Hence two keys: the topical terms
 * (`tokenize`, stoplist applied) decide, and the function words (everything else
 * in `tokenizeAll`) only separate blocks the topical terms scored equally.
 */
function pickBlock(blocks: Block[], query: string): Block {
  const all = new Set(tokenizeAll(query))
  const topical = new Set(tokenize(query))
  const sets = blocks.map(b => new Set(tokenizeAll(`${b.heading}\n${b.text}`)))
  const weight = new Map<string, number>()
  for (const t of all) {
    const df = sets.reduce((n, s) => n + (s.has(t) ? 1 : 0), 0)
    if (df > 0) weight.set(t, Math.log(1 + blocks.length / df))
  }
  let best = 0
  let bestScore = -1
  let bestTie = -1
  for (let i = 0; i < blocks.length; i++) {
    let score = 0
    let tie = 0
    for (const [t, w] of weight) {
      if (!sets[i].has(t)) continue
      if (topical.has(t)) score += w
      else tie += w
    }
    if (score > bestScore || (score === bestScore && tie > bestTie)) {
      best = i
      bestScore = score
      bestTie = tie
    }
  }
  // bestScore 0 means nothing in the entry matched at block level, e.g. the hit
  // was scored on its key or description alone. The opening block is the least
  // arbitrary answer then, still clipped to budget.
  return blocks[best]
}

function clip(text: string, cap: number): string {
  if (cap <= 1) return ''
  if (text.length <= cap) return text
  const slice = text.slice(0, cap - 1)
  const space = slice.lastIndexOf(' ')
  return `${(space > cap * 0.6 ? slice.slice(0, space) : slice).trimEnd()}…`
}

/**
 * The part of one entry worth returning for this query: the matching paragraph,
 * prefixed by its heading, clipped to `cap`. When the matching paragraph is
 * oversized the heading is what survives with it, so an entry that cannot be
 * shown in full still reports which section the match came from and the caller
 * knows what to ask `memory_get` for.
 *
 * `partial` is true whenever the returned text is not the entry's whole body,
 * which is what earns the hit its `memory_get` pointer.
 */
function regionFor(
  content: string,
  query: string,
  cap: number,
): { text: string; partial: boolean } {
  // Frontmatter is dropped before the body is split into regions. It is
  // metadata the ranker reads as fields of its own (`name:`, `description:`),
  // and returning it alongside a body would spend the budget on the one part
  // of an entry that never answers the question. It is not unreachable: when
  // the stripped body yields no block at all, the fallback below emits the raw
  // content, frontmatter included, because an entry whose only content is its
  // own description has nothing else to show.
  const body = stripFrontmatterText(content).trim()
  const blocks = blocksOf(body)
  // No block at all means the entry is frontmatter-only, or whitespace, or
  // anything else the splitter finds nothing in. Emitting '' here rendered the
  // hit as a bare key with nothing under it, and with an empty body it was not
  // even marked partial, so the caller got a heading, no text and no pointer to
  // the entry that would have shown what was actually stored. Fall back to the
  // raw content and always claim partial: whatever this is, it is not the
  // entry's body rendered whole. This is the one path on which frontmatter
  // reaches the caller, and it is the right answer here: there is no body it
  // could be competing with for the budget.
  if (blocks.length === 0) return { text: clip(content.trim(), cap), partial: true }
  const block = pickBlock(blocks, query)

  // The heading prefix is decided first because it is what the block's text
  // actually has to fit inside. Deciding elision against `cap` and then clipping
  // to `cap - prefix.length` left a band the width of the prefix in which a
  // fence was judged to fit, then cut mid-block: an opening fence with no
  // closer, which reads downstream as "the rest of this is code".
  let prefix = ''
  if (block.heading) {
    const h = clip(block.heading, Math.floor(cap / 3))
    if (cap - h.length - 1 >= MIN_REGION_CHARS) prefix = `${h}\n`
  }
  const avail = cap - prefix.length
  const text = block.fence && block.text.length > avail ? ELIDED_FENCE : block.text
  const out = prefix + clip(text, avail)
  // Compared against the WHOLE entry, not the frontmatter-stripped body. The
  // ranker weights `description:` at +3 (`relevance.ts`), so an entry can be
  // selected for terms that live only in its frontmatter, which this function
  // then strips before picking a block. Measuring `partial` against the stripped
  // body made that removal invisible: a short single-block entry came back with
  // `partial: false` and no pointer, so the caller got a confident hit whose
  // reason for matching had been deleted from the answer and was unreachable.
  // `content.trim()` subsumes the old check, since with no frontmatter to strip
  // it is exactly `body`.
  return { text: out, partial: out !== content.trim() }
}

/**
 * Longest provenance trailer a hit carries. Every part of it is frontmatter
 * an author wrote, so like the region it is bounded rather than trusted.
 */
const MAX_TRAILER_CHARS = 160

/** `updated` as the calendar day it names, or undefined when it names none. */
function dayOf(updated: string): string | undefined {
  const t = Date.parse(updated)
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}/.test(updated) ? updated.slice(0, 10) : undefined
}

/** Why an inactive note is in the output at all, for the trailer of a hit shown on request. */
function whyInactive(meta: NoteMeta): string {
  if (meta.supersededBy) return `superseded by ${meta.supersededBy}`
  if (meta.status === 'superseded' || meta.status === 'deleted') return meta.status
  return `expired ${meta.expires}`
}

/**
 * The last line of every hit: `[type · agent · updated YYYY-MM-DD]`, each part
 * left out when the note does not say, and nothing at all when none of it is
 * known, so a bare legacy note renders exactly as before. A note without a
 * `type:` stamp shows the type its key implies, which is what the next save
 * would stamp. When the caller asked for inactive notes, a hit that is one
 * says why it is inactive, so a replaced fact is never read as current.
 */
function trailerFor(key: string, meta: NoteMeta | undefined, inactive: boolean): string {
  const parts: string[] = []
  const type = meta?.type ?? inferType(key)
  if (type) parts.push(type)
  if (meta?.agent) parts.push(meta.agent)
  const day = meta?.updated === undefined ? undefined : dayOf(meta.updated)
  if (day) parts.push(`updated ${day}`)
  if (inactive && meta) parts.push(whyInactive(meta))
  return parts.length ? `\n[${clip(parts.join(' · '), MAX_TRAILER_CHARS)}]` : ''
}

export type MemoryTools = ReturnType<typeof makeTools>

/**
 * FNV-1a over a string's UTF-16 code units, as eight hex digits. A cheap,
 * stable digest for the recall index's fingerprint when the client has no
 * ciphertext hash to offer: it only has to tell "this entry changed since the
 * last recall" from "it did not", within one process, and it is paired with
 * the entry's timestamp and length so a collision would need all three.
 */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * Namespaces whose recall index is kept warm. Eight is the most one recall
 * may span; sixteen leaves room for an agent working two projects at once
 * without the index of either being rebuilt on every switch.
 */
const MAX_INDEXED_NAMESPACES = 16

/**
 * How a save answers `needs_decision`, or declares on its first call that the
 * agent has already checked. Absent, the gate runs. The order is the one the
 * zod enum advertises.
 */
export const SAVE_MODES = ['update', 'supersede', 'add', 'noop'] as const
export type SaveMode = (typeof SAVE_MODES)[number]

export type SaveOptions = {
  /** Key of the older entry this one replaces; stamped into the frontmatter. */
  supersedes?: string
  /** Override the routing check, save over a locked note, or save over an unreadable one. */
  force?: boolean
  /**
   * `update`: rewrite the existing `key` (it must exist). `supersede`: save
   * this key and mark `supersedes` replaced, in one write. `add`: save as a
   * distinct fact. `noop`: write nothing and name the best candidate. Any of
   * them skips the gate; `force` does not.
   */
  mode?: SaveMode
}
export type DeleteOptions = {
  /** Delete a locked note. */
  force?: boolean
  /** Erase outright instead of moving the note to the trash; required for a trash key. */
  hard?: boolean
}
export type ListOptions = {
  /** Also list the bookkeeping entries under `sys.openrecall/`. */
  includeSystem?: boolean
}
export type RecallOptions = {
  /** Also rank superseded, deleted and expired notes, which are hidden by default. */
  includeInactive?: boolean
}

/** A namespace of the shape `memory_project` creates: `<shared>/projects/<sha256 hex>`. */
export function isProjectNamespace(ns: string): boolean {
  return /\/projects\/[0-9a-f]{64}$/.test(ns)
}

/** The refusal for a hand-written key under the reserved prefix. */
function reservedKey(key: string, verb: string): string {
  return (
    `Refused to ${verb} "${key}": keys under ${SYSTEM_PREFIX} are bookkeeping the client ` +
    'maintains by itself (the access-date sidecar, and later the trash and the version ' +
    'history) and are never written by hand. Use a key outside that prefix.'
  )
}

/** The second response line of a save whose agent-supplied stamps were replaced. */
function correctedLine(fields: string[]): string {
  const list =
    fields.length === 1
      ? fields[0]
      : `${fields.slice(0, -1).join(', ')} and ${fields[fields.length - 1]}`
  const plural = fields.length > 1
  return `(stamped: ${list} ${plural ? 'are' : 'is'} set by the client; your value${plural ? 's were' : ' was'} replaced)`
}

/**
 * The keys a write carries for its own bookkeeping. A 409 confined to them
 * is another session's bookkeeping landing first, which the tool layer
 * resolves by rebuilding on top of it; a 409 naming anything else is the
 * agent's to resolve.
 */
const BOOKKEEPING_KEYS: readonly string[] = [INDEX_KEY, ACCESSED_KEY, LEGACY_INDEX_KEY]

/** The keys a 409 names, or null when `e` is not a 409 or names none. */
function conflictKeys(e: unknown): string[] | null {
  if (!(e instanceof OpenRecallHttpError) || e.status !== 409) return null
  const raw = e.details?.conflicts
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const keys = Object.keys(raw as Record<string, unknown>)
  return keys.length > 0 ? keys : null
}

function isBookkeepingOnlyConflict(e: unknown): boolean {
  return conflictKeys(e)?.every(k => BOOKKEEPING_KEYS.includes(k)) ?? false
}

const INDEX_NOT_REFRESHED = '(index not refreshed; the next save will)'

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many)

/** What a write to a namespace carries besides the caller's entries, and what to say about it. */
type IndexPlan = {
  /** The index to push, or null when what is stored is already right. */
  text: string | null
  /** True when the stored index should go: nothing left to list and nothing pinned. */
  remove: boolean
  /** The hand-written index to copy aside, on the first regeneration over one. */
  backup: string | null
  /** Response lines about the index. */
  notes: string[]
}

type Bookkept = { result: PushResult; notes: string[] }

/**
 * Why a save or delete of a locked note is refused. Null when the stored
 * note is not locked (or there is none). `locked: true` is the one frontmatter
 * field an agent sets to say "do not change this without a human's say-so";
 * `force: true` is how the agent says it has it.
 */
function lockedRefusal(
  existing: string | null,
  key: string,
  ns: string,
  action: 'save' | 'delete',
): string | null {
  if (existing === null) return null
  if (parseFrontmatter(existing)?.fields.get('locked') !== true) return null
  return action === 'save'
    ? `Refused to save "${key}" in ${ns}: the stored note is locked (locked: true in its frontmatter). Read it with memory_get, and pass force: true if it really should change. Nothing was stored.`
    : `Refused to delete "${key}" from ${ns}: the stored note is locked (locked: true in its frontmatter). Pass force: true if it really should go. "${key}" is still stored.`
}

/**
 * What identifies a pulled entry's content across writes: the server's
 * ciphertext hash when the client carries one, else the timestamp, length
 * and a digest of the plaintext. Both per-namespace caches (the index notes
 * and the gate profiles) are keyed on it, so an unchanged note is parsed
 * once per process and a changed one is re-parsed on the next write.
 */
function fingerprintOf(view: PullResult, key: string, content: string): string {
  const updatedAt = view.updatedAt[key]
  return view.hashes?.[key] ?? `${updatedAt ?? ''}|${content.length}|${fnv1a(content)}`
}

/**
 * A stored note as the gate compares it (`GateNote`: parsed description,
 * title, type, body) together with the fields that say whether it is still
 * active (`NoteMeta`). One frontmatter parse serves both; the gate module
 * parses nothing itself.
 */
function gateNoteOf(key: string, content: string): { note: GateNote; meta: NoteMeta } {
  const fm = parseFrontmatter(content)
  const str = (name: string): string | undefined => {
    const v = fm?.fields.get(name)
    return typeof v === 'string' && v !== '' ? v : undefined
  }
  const note: GateNote = {
    key,
    description: str('description') ?? '',
    body: fm ? fm.body : content,
  }
  const type = str('type') ?? inferType(key)
  if (type !== undefined) note.type = type
  const title = str('name')
  if (title !== undefined) note.title = title
  const updated = str('updated')
  if (updated !== undefined) note.updated = updated
  const agent = str('agent')
  if (agent !== undefined) note.agent = agent
  return { note, meta: fm ? noteMeta(content) : {} }
}

/** `content` with `fields` set in its frontmatter, the rest of it (body, opaque lines) untouched. */
function withFields(content: string, fields: Record<string, FmValue>): string {
  const fm = parseFrontmatter(content) ?? {
    fields: new Map<string, FmValue>(),
    opaque: new Map<string, string[]>(),
    body: content,
  }
  const next = new Map(fm.fields)
  for (const [k, v] of Object.entries(fields)) next.set(k, v)
  return serializeFrontmatter(next, fm.opaque) + fm.body
}

/**
 * The replaced note as it is stored from now on: `status: superseded` and
 * `superseded_by: <new key>` added, everything else as it was. `updated` is
 * not touched: it marks the last change to the note's content, and being
 * replaced is not one.
 */
function markSuperseded(content: string, by: string): string {
  return withFields(content, { status: 'superseded', superseded_by: by })
}

/** A note as it is parked in the trash: `status: deleted` and the `deleted:` stamp added. */
function markDeleted(content: string, now: string): string {
  return withFields(content, { status: 'deleted', deleted: now })
}

/** The one line a `noop` save answers with: the entry to keep, and how to read it. */
function noopText(key: string, ns: string, best: Candidate | undefined): string {
  if (!best)
    return `noop: nothing to do; no entry in ${ns} looks like "${key}" (nothing was written)`
  return (
    `noop: "${key}" was not saved; keeping ${renderCandidate(best, 0).slice(3)}. ` +
    `Read it with memory_get key "${best.key}". Nothing was written.`
  )
}

export type ToolsOptions = {
  /**
   * Where the doctor's run markers live (`<home>/state/doctor.json`, written
   * 0600 under a 0700 directory; it holds no memory content). Left out, the
   * markers are kept in memory only, so every process starts with a run due.
   */
  doctorMarkerPath?: string
  /**
   * Where a one-line warning goes (today: the marker file could not be
   * written). The MCP server sends it to stderr, the CLI to its own; a caller
   * that gives none hears nothing. Never the protocol channel.
   */
  warn?: (line: string) => void
}

/** What the scheduled doctor run (`doctorIfDue`) reports back. */
export type DoctorDue =
  | { ran: false; reason: 'not-due' | 'failed'; error?: string }
  | { ran: true; findings: number; kinds: string[] }

export function makeTools(
  client: MemoryClient,
  defaultNamespace: string,
  session: Session = makeSession(),
  options: ToolsOptions = {},
) {
  const nsOf = (ns?: string) => (ns?.trim() ? ns.trim() : defaultNamespace)

  /**
   * One recall index per namespace, built the first time the namespace is
   * recalled and brought up to date on every recall after that from the
   * fingerprint of each pulled entry, so an unchanged entry is never
   * re-tokenized. Plaintext lives here only as long as the process does, which
   * is the same custody the decrypted pull already has. Least recently
   * recalled is dropped past the cap, as `lruSet` does in the client.
   */
  const indexes = new Map<string, RecallIndex>()
  function indexFor(ns: string): RecallIndex {
    return warm(indexes, ns, () => new RecallIndex())
  }

  /**
   * The index's view of each note (`IndexNote`), parsed once per ciphertext
   * hash and kept per namespace, so regenerating `MEMORY.md` over a
   * 2,000-note namespace parses only the notes that changed since the last
   * write. Same custody and bound as the recall index above.
   */
  const indexNotes = new Map<string, Map<string, { fingerprint: string; note: IndexNote }>>()
  function indexNotesFor(ns: string) {
    return warm(indexNotes, ns, () => new Map<string, { fingerprint: string; note: IndexNote }>())
  }

  /**
   * The save gate's view of each note (`NoteProfile`: tokens, topic terms,
   * and the MinHash signature once one was needed) with the fields that say
   * whether the note is active, parsed and tokenized once per ciphertext hash
   * and kept per namespace like the index notes above, so a gate call over a
   * 2,000-note namespace tokenizes only what changed since the last write.
   */
  type GateEntry = { fingerprint: string; profile: NoteProfile; meta: NoteMeta }
  const gateProfiles = new Map<string, Map<string, GateEntry>>()
  function gateProfilesFor(ns: string) {
    return warm(gateProfiles, ns, () => new Map<string, GateEntry>())
  }

  /**
   * The notes a save into `ns` is compared against: every active, non-hidden
   * note in the pulled view except the target key itself, which is a plain
   * update and never a candidate. Returns the corpus and the profiles the
   * gate should reuse for it; entries for keys no longer stored are dropped.
   */
  function gateCorpus(
    ns: string,
    view: PullResult,
    target: string,
    day: string,
  ): { corpus: GateNote[]; profiles: Map<string, NoteProfile> } {
    const cache = gateProfilesFor(ns)
    const live = new Set<string>()
    const corpus: GateNote[] = []
    const profiles = new Map<string, NoteProfile>()
    for (const [key, content] of Object.entries(view.entries)) {
      if (isHiddenKey(key)) continue
      live.add(key)
      const fingerprint = fingerprintOf(view, key, content)
      let hit = cache.get(key)
      if (!hit || hit.fingerprint !== fingerprint) {
        const { note, meta } = gateNoteOf(key, content)
        hit = { fingerprint, profile: profileNote(note), meta }
        cache.set(key, hit)
      }
      if (key === target || isInactive(hit.meta, day)) continue
      corpus.push(hit.profile.note)
      profiles.set(key, hit.profile)
    }
    for (const key of cache.keys()) if (!live.has(key)) cache.delete(key)
    return { corpus, profiles }
  }

  /** `map[ns]`, created by `make` when absent, moved to most-recent, oldest dropped past the cap. */
  function warm<T>(map: Map<string, T>, ns: string, make: () => T): T {
    const v = map.get(ns) ?? make()
    map.delete(ns)
    map.set(ns, v)
    while (map.size > MAX_INDEXED_NAMESPACES) {
      const oldest = map.keys().next()
      if (oldest.done) break
      map.delete(oldest.value)
    }
    return v
  }

  /**
   * The pulled entries of one namespace as index documents. The fingerprint
   * is the server's ciphertext hash when the client carries one (a later
   * client does), else timestamp, length and a digest of the plaintext. The
   * namespace is stamped on a document only when the caller named namespaces,
   * because the `### key (ns)` header in the output keys off its presence.
   */
  function docsOf(r: PullResult, source: string, labelled: boolean): IndexDoc[] {
    const hashes = r.hashes
    return Object.entries(r.entries).map(([key, content]) => {
      const updatedAt = r.updatedAt[key]
      return {
        id: key,
        key,
        ...(labelled ? { namespace: source } : {}),
        content,
        ...(updatedAt === undefined ? {} : { updatedAt }),
        fingerprint: hashes?.[key] ?? `${updatedAt ?? ''}|${content.length}|${fnv1a(content)}`,
      }
    })
  }

  /**
   * The read `get` used before the single-entry view existed, kept for a
   * server that answers the full namespace to `?view=entry`: everything is
   * decrypted and one key picked out of it.
   */
  /** `client.pull`, with its stage timings and entry count credited to the timer. */
  async function pullTimed(timer: Timer, source: string, opts?: PullOptions): Promise<PullResult> {
    const started = performance.now()
    const r = await client.pull(source, opts)
    timer.pulled(r, performance.now() - started)
    return r
  }

  async function getViaPull(timer: Timer, key: string, ns: string): Promise<ToolResult> {
    const { entries, version } = await pullTimed(timer, ns)
    if (Object.keys(entries).length === 0) {
      const lost = await lostEntries(client, ns, version)
      if (lost) return fail(lost)
      return ok(`(no memory stored in ${ns} yet)`)
    }
    // Own-property check, not `entries[key]`: a key like "__proto__" or
    // "toString" must miss, never resolve to something off the prototype.
    if (!Object.hasOwn(entries, key))
      return ok(`(no entry "${key}" in ${ns}, call memory_list to see the keys that exist)`)
    if (!isHiddenKey(key)) noteAccess(session.pendingAccess, ns, key, today())
    return ok(`### ${key} (${ns})\n${entries[key]}`)
  }

  /**
   * The note stored under `key`, or null when there is none. The two 404s
   * (`empty`, `entry_not_found`) and a key the server will not look up are
   * all "no note": the push that follows reports an invalid key with the
   * right move, so there is nothing to read first. A body the manifest names
   * and the store cannot serve is lost data, and a save over it is refused
   * the way `memory_get` reports it, unless the caller forces.
   *
   * The read does not rebase the write (`observe: false`): the stale-base
   * precondition compares the push against what this session read through
   * recall, get or search, and a read made only to carry the stamps forward
   * must not turn a stale save into a current one. A server that predates
   * the entry view is read through the full pull, as `get` does; that path
   * does record what it saw, so against such a server a save is conditional
   * on the pull it just made rather than on the session's earlier read.
   */
  async function readExisting(ns: string, key: string, force: boolean): Promise<string | null> {
    try {
      return await client.entry(ns, key, { observe: false })
    } catch (e) {
      if (e instanceof OpenRecallHttpError) {
        if (e.status === 404 && (e.code === 'empty' || e.code === 'entry_not_found')) return null
        if (e.status === 400) return null
        if (e.status === 503 && e.code === 'entry_unreadable') {
          if (force) return null
          throw new Rendered(unreadableEntry(key, ns))
        }
      }
      if (e instanceof OpenRecallProtocolError) {
        const { entries } = await client.pull(ns)
        return Object.hasOwn(entries, key) ? (entries[key] as string) : null
      }
      throw e
    }
  }

  /**
   * Where a note of this type belongs, against where it is being saved. A
   * `user` note into a project namespace and a `project` or `reference` note
   * into the shared namespace while a project is open are refused with the
   * namespace that should have been used; `feedback` goes anywhere and gets
   * a reminder when it lands in a project. Untyped notes are not routed, and
   * nothing is routed when no project has been opened in this process, since
   * there is then no project namespace to name.
   */
  function routeCheck(
    type: NoteType | undefined,
    key: string,
    ns: string,
  ): { refusal?: string; note?: string } {
    if (!type) return {}
    const projectShaped = isProjectNamespace(ns)
    if (type === 'user' && projectShaped) {
      return {
        refusal:
          `Refused to save "${key}" in ${ns}: it is a user note (type: user) and that is a project namespace. ` +
          `Standing facts about the user belong in the shared namespace ${defaultNamespace}; save it there, ` +
          'or pass force: true to keep it here. Nothing was stored.',
      }
    }
    if (
      (type === 'project' || type === 'reference') &&
      ns === defaultNamespace &&
      session.openedProjects.size > 0
    ) {
      const opened = [...session.openedProjects].join(', ')
      return {
        refusal:
          `Refused to save "${key}" in ${ns}: it is a ${type} note and that is the shared namespace. ` +
          `Project facts belong in the open project's namespace (${opened}); save it there, ` +
          'or pass force: true to keep it here. Nothing was stored.',
      }
    }
    if (type === 'feedback' && projectShaped) {
      return {
        note:
          '(feedback saved in a project namespace applies to that project only; feedback that ' +
          `applies everywhere belongs in ${defaultNamespace})`,
      }
    }
    return {}
  }

  /**
   * The `MEMORY.md` a write to `ns` should carry: the index regenerated over
   * the pulled namespace with the write applied on top, so the saved key is
   * listed with its new description and the deleted key is gone, in the same
   * request as the write itself.
   *
   * The Pinned lines come from the index as it will stand after the write:
   * the stored one, or the text being saved when the write is the index
   * itself, which is how an agent edits its Pinned section. A hand-maintained
   * index (no marker) is adopted on the way: its prose lines become the first
   * Pinned block, its link lines are re-derived from the notes and those that
   * name a note which no longer exists are counted, and the stored text is
   * copied whole to `LEGACY_INDEX_KEY` once, so nothing an agent wrote there
   * is lost. No index is created for a namespace that holds no notes, and one
   * that has nothing left to list and nothing pinned is removed: an empty
   * projection is bookkeeping, not memory, and a namespace holding only it
   * would otherwise never read as empty again.
   */
  function planIndex(
    ns: string,
    view: PullResult,
    entries: Record<string, string>,
    deletions: string[],
  ): IndexPlan {
    const stored = Object.hasOwn(view.entries, INDEX_KEY)
      ? (view.entries[INDEX_KEY] as string)
      : null
    const after: Record<string, string> = { ...view.entries, ...entries }
    for (const k of deletions) delete after[k]
    const savingIndex = Object.hasOwn(entries, INDEX_KEY)
    const source = savingIndex ? (entries[INDEX_KEY] as string) : stored
    const parsed = parseIndex(source)
    let pinned = parsed.pinned
    let stale = 0
    if (source !== null && !parsed.generated) {
      pinned = [...parsed.pinned, ...parsed.legacyLines].slice(0, MAX_PINNED)
      for (const line of source.split(/\r?\n/)) {
        const target = linkTarget(line)
        if (target !== null && !target.includes('://') && !Object.hasOwn(after, target)) stale++
      }
    }
    const backup =
      stored !== null &&
      !parseIndex(stored).generated &&
      !Object.hasOwn(view.entries, LEGACY_INDEX_KEY)
        ? stored
        : null

    const cache = indexNotesFor(ns)
    const notes: IndexNote[] = []
    const live = new Set<string>()
    for (const key of Object.keys(after)) {
      if (isHiddenKey(key)) continue
      live.add(key)
      const content = after[key] as string
      if (Object.hasOwn(entries, key)) {
        // The write itself: its stored hash is not known until it lands, so it
        // is parsed now and cached from the next pull like any other note.
        notes.push(indexNoteOf(key, content))
        continue
      }
      const fingerprint = fingerprintOf(view, key, content)
      const hit = cache.get(key)
      if (hit && hit.fingerprint === fingerprint) {
        notes.push(hit.note)
        continue
      }
      const note = indexNoteOf(key, content, view.updatedAt[key])
      cache.set(key, { fingerprint, note })
      notes.push(note)
    }
    for (const key of cache.keys()) if (!live.has(key)) cache.delete(key)

    if (notes.length === 0 && pinned.length === 0 && !savingIndex) {
      return { text: null, remove: stored !== null, backup, notes: [] }
    }
    const generated = generateIndex(notes, pinned, new Date())
    const lines: string[] = []
    if (backup !== null) {
      const kept = pinned.length
      lines.push(
        `(MEMORY.md is now generated; ${
          kept
            ? `your ${kept} orientation ${plural(kept, 'line')} ${kept === 1 ? 'was' : 'were'} kept under "## Pinned"; `
            : ''
        }the old index was saved as ${LEGACY_INDEX_KEY})`,
      )
    } else if (savingIndex) {
      lines.push(
        `(MEMORY.md is generated from each note's frontmatter: only its "## Pinned" section ` +
          `(${pinned.length} ${plural(pinned.length, 'line')}) was taken from what you sent; the rest was regenerated)`,
      )
    }
    if (stale > 0) {
      lines.push(
        `(${stale} stale index ${plural(stale, 'line')} dropped: ${stale === 1 ? 'it' : 'they'} pointed at ` +
          `${stale === 1 ? 'a key' : 'keys'} that no longer ${stale === 1 ? 'exists' : 'exist'})`,
      )
    }
    if (generated.nearCap) {
      lines.push(
        `MEMORY.md is at ${generated.lines}/${MAX_LINES} lines (${(generated.bytes / 1000).toFixed(1)}/${MAX_BYTES / 1000} KB): ` +
          'merge or supersede stale entries (memory_doctor lists candidates).',
      )
    }
    return {
      text: savingIndex || generated.text !== stored ? generated.text : null,
      remove: false,
      backup,
      notes: lines,
    }
  }

  /**
   * The index after a push in which the server refused one of the entries it
   * was regenerated for: it names a note that does not exist, and the save's
   * own response says nothing was stored. Put it back the way the notes
   * stand, best effort; a failure here leaves a line the next write corrects.
   */
  async function repairIndex(
    timer: Timer,
    ns: string,
    view: PullResult,
    entries: Record<string, string>,
    deletions: string[],
    refused: string[],
  ): Promise<void> {
    const rest: Record<string, string> = {}
    for (const [k, v] of Object.entries(entries)) if (!refused.includes(k)) rest[k] = v
    const stored = Object.hasOwn(view.entries, INDEX_KEY)
      ? (view.entries[INDEX_KEY] as string)
      : null
    const again = planIndex(ns, view, rest, deletions)
    const text = again.remove ? null : (again.text ?? stored)
    try {
      await timer.time('fetch', () =>
        text === null
          ? client.push(ns, {}, { deletions: [INDEX_KEY] })
          : client.push(ns, { [INDEX_KEY]: text }),
      )
    } catch {
      // Best effort only.
    }
  }

  /**
   * Push `entries` (and `deletions`) to `ns` together with the namespace's
   * bookkeeping, in one request: the regenerated `MEMORY.md` when it would
   * differ from what is stored (and the copy of a hand-written one on the
   * first regeneration), and the pending access stamps as the sidecar when
   * there are any. All of it is derived from one pull of the namespace, which
   * is cheap once the in-process cache is warm (a hashes round trip and the
   * changed bodies) and records a base for the bookkeeping keys only, so the
   * write's own precondition stays whatever this session's earlier reads made
   * it: a stale save is still refused as one.
   *
   * A 409 confined to the bookkeeping keys is another session's bookkeeping
   * landing first: re-pull, rebuild on top of it, retry once. If it conflicts
   * again, the namespace cannot be read whole (a body that will not decrypt,
   * say), or the server refuses the larger write for size, the caller's
   * entries go alone and the response says the index was not refreshed: a
   * note is never held back by index contention. A 409 naming the caller's
   * own key is the caller's to render. A write of the index itself has
   * nothing to go alone with and surfaces its failure.
   *
   * A caller that already pulled the namespace for its own purposes (the
   * save gate) hands the view in as `given`, and the first attempt builds on
   * it instead of pulling again; `null` says that pull already failed, so
   * the entries go alone at once rather than failing the same way twice.
   */
  async function pushWithBookkeeping(
    timer: Timer,
    ns: string,
    entries: Record<string, string>,
    deletions: string[] = [],
    given?: PullResult | null,
  ): Promise<Bookkept> {
    const push = (e: Record<string, string>, d: string[]) =>
      timer.time('fetch', () => client.push(ns, e, d.length ? { deletions: d } : undefined))
    const pending = session.pendingAccess.get(ns)
    const writesIndex = Object.hasOwn(entries, INDEX_KEY)
    const skipIndex = deletions.includes(INDEX_KEY)
    let alone: string | null = null
    let lastConflict: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      let view: PullResult
      if (attempt === 0 && given !== undefined) {
        if (given === null) {
          alone = INDEX_NOT_REFRESHED
          break
        }
        view = given
      } else {
        try {
          view = await pullTimed(timer, ns, { observe: [...BOOKKEEPING_KEYS] })
        } catch (e) {
          if (writesIndex) throw e
          alone = INDEX_NOT_REFRESHED
          break
        }
      }
      const extra: Record<string, string> = {}
      let plan: IndexPlan | null = null
      let dels = deletions
      if (!skipIndex) {
        plan = await timer.time('format', () => planIndex(ns, view, entries, deletions))
        if (plan.text !== null) extra[INDEX_KEY] = plan.text
        if (plan.remove) dels = [...deletions, INDEX_KEY]
        if (plan.backup !== null) extra[LEGACY_INDEX_KEY] = plan.backup
      }
      const stamps = pending?.size ? pending : null
      let snapshot: Map<string, string> | null = null
      if (stamps) {
        snapshot = new Map(stamps)
        const storedSidecar = Object.hasOwn(view.entries, ACCESSED_KEY)
          ? (view.entries[ACCESSED_KEY] as string)
          : null
        const merged = mergeAccessed(parseAccessed(storedSidecar), snapshot)
        if (merged.changed) extra[ACCESSED_KEY] = serializeAccessed(merged.sidecar)
        else settleAccess(stamps, snapshot)
      }
      try {
        const r = await push({ ...entries, ...extra }, dels)
        if (
          stamps &&
          snapshot &&
          Object.hasOwn(extra, ACCESSED_KEY) &&
          !r.skipped?.some(s => s.key === ACCESSED_KEY)
        ) {
          settleAccess(stamps, snapshot)
        }
        const skipped = (r.skipped ?? []).map(s => s.key)
        const refused = skipped.filter(k => Object.hasOwn(entries, k))
        if (plan !== null && plan.text !== null && refused.length > 0) {
          await repairIndex(timer, ns, view, entries, deletions, refused)
        }
        const notes =
          plan === null ? [] : skipped.includes(INDEX_KEY) ? [INDEX_NOT_REFRESHED] : plan.notes
        return { result: r, notes }
      } catch (e) {
        if (isBookkeepingOnlyConflict(e)) {
          lastConflict = e
          continue
        }
        if (e instanceof OpenRecallHttpError && e.status === 413 && Object.keys(extra).length) {
          if (writesIndex) throw e
          alone = `(index not refreshed: the write with it would exceed a storage limit on ${ns} (${bounded(e.code, 40)}))`
          break
        }
        throw e
      }
    }
    if (writesIndex) throw lastConflict
    return { result: await push(entries, deletions), notes: [alone ?? INDEX_NOT_REFRESHED] }
  }

  /**
   * The one flush that is not piggybacked: a namespace that has collected
   * `ACCESS_FLUSH_THRESHOLD` pending keys in a process that has not written
   * to it. Once per process per namespace, and never surfaced.
   */
  const thresholdFlushed = new Set<string>()
  async function flushIfDue(timer: Timer, ns: string): Promise<void> {
    const pending = session.pendingAccess.get(ns)
    if (!pending || pending.size < ACCESS_FLUSH_THRESHOLD || thresholdFlushed.has(ns)) return
    thresholdFlushed.add(ns)
    await timer.time('fetch', () => flushAccessed(client, ns, pending))
  }

  /**
   * The namespace view a save compares against and writes its bookkeeping
   * from, or null when it cannot be read whole (a body that will not decrypt,
   * say). The gate is then skipped and said so, and the push goes alone, the
   * same way the index is skipped when its pull fails.
   */
  async function pullView(timer: Timer, ns: string): Promise<PullResult | null> {
    try {
      return await pullTimed(timer, ns, { observe: [...BOOKKEEPING_KEYS] })
    } catch {
      return null
    }
  }

  /** The stored note under `key` out of a pulled view, or from an entry read when there is none. */
  async function storedNote(
    timer: Timer,
    ns: string,
    key: string,
    view: PullResult | null,
  ): Promise<string | null> {
    if (view) return Object.hasOwn(view.entries, key) ? (view.entries[key] as string) : null
    return timer.time('fetch', () => readExisting(ns, key, true))
  }

  const GATE_SKIPPED = '(duplicate check skipped: the namespace could not be read whole)'

  const tools = {
    /**
     * Persist one durable memory entry (encrypted before upload).
     *
     * Read, stamp, route, gate, push. The stored note under `key` is read
     * first (one bounded entry read, not a pull) so the stamp can keep its
     * `id` and `created`, refuse a locked note, and tell a stale
     * agent-supplied stamp from one carried over from `memory_get`. The stamp
     * lives inside the encrypted body, so the server sees nothing new.
     *
     * The gate: with no `mode`, the stamped note is compared against every
     * active note in the namespace (the same pulled view the bookkeeping is
     * built from, profiles cached per ciphertext hash) and a likely twin,
     * duplicate, contradiction or same-topic note refuses the save with
     * `needs_decision` and up to five candidates; nothing is written. The
     * agent answers by resaving with `mode`: `update` rewrites the existing
     * key, `supersede` writes this note and marks `supersedes` replaced in
     * the same request, `add` saves as a distinct fact, `noop` writes nothing.
     * A `mode` on a first call is honoured as "already checked". Saving over
     * the same key is an update and that key is never its own candidate;
     * `force` covers locks and routing only, never the gate.
     *
     * The push carries the regenerated `MEMORY.md` in the same request
     * (`pushWithBookkeeping`); saving `MEMORY.md` itself edits its Pinned
     * section and nothing else. The first response line keeps its shape; a
     * second line reports replaced stamps, then a routing reminder, a
     * supersession note, and any lines about the index.
     */
    save: timed(
      async (timer, key: string, content: string, namespace?: string, opts: SaveOptions = {}) => {
        const ns = nsOf(namespace)
        if (isSystemKey(key)) return fail(reservedKey(key, 'save'))
        const mode = opts.mode
        try {
          const entries: Record<string, string> = { [key]: content }
          let corrected: string[] = []
          const extra: string[] = []
          let view: PullResult | null | undefined
          // The root index is not a note: it is regenerated from the notes on
          // every write, so it carries no stamp and no type to route, and the
          // one part of what the agent sends that survives is its Pinned
          // section (`planIndex`). Everything else is read, stamped and routed.
          if (key !== INDEX_KEY) {
            const existing = await timer.time('fetch', () =>
              readExisting(ns, key, opts.force === true),
            )
            const lock = lockedRefusal(existing, key, ns, 'save')
            if (lock && !opts.force) return fail(lock)
            if (mode === 'update' && existing === null) {
              return fail(
                `Nothing to update: there is no entry "${key}" in ${ns}. Resave with the key ` +
                  'of the entry to rewrite, or with mode: "add" if this is a new fact. Nothing was stored.',
              )
            }
            const now = new Date().toISOString()
            let stamped: ReturnType<typeof stampForSave>
            try {
              stamped = stampForSave(existing, content, {
                now,
                agent: session.agentLabel(),
                session: session.sessionId,
                key,
                // The server's timestamp for a legacy note, when a recall in this
                // process has it; `created` falls back to now otherwise.
                serverUpdatedAt: indexes.get(ns)?.doc(key)?.updatedAt,
                supersedes: opts.supersedes,
              })
            } catch (e) {
              if (e instanceof FrontmatterError) {
                return fail(
                  `Refused to save "${key}": ${neutralize(bounded(e.message))} ` +
                    `(frontmatter field "${e.field}"). Nothing was stored.`,
                )
              }
              throw e
            }
            const route = routeCheck(stamped.meta.type, key, ns)
            if (route.refusal && !opts.force) return fail(route.refusal)
            entries[key] = stamped.content
            corrected = stamped.corrected
            if (route.note) extra.push(route.note)

            // A subtree index (`project/MEMORY.md`) is stamped and routed like
            // a note but is a table of contents, not a fact: nothing to gate.
            if (!isHiddenKey(key)) {
              view = await pullView(timer, ns)
              const day = today()
              if (mode === undefined || mode === 'noop') {
                if (view === null) {
                  if (mode === 'noop') {
                    return ok(
                      `noop: "${key}" was not saved and nothing was written; ${ns} could not be ` +
                        'read whole, so no existing entry was compared.',
                    )
                  }
                  extra.push(GATE_SKIPPED)
                } else {
                  const target = gateNoteOf(key, stamped.content).note
                  const pulled = view
                  const candidates = await timer.time('rank', () => {
                    const { corpus, profiles } = gateCorpus(ns, pulled, key, day)
                    return findCandidates(target, corpus, { profiles })
                  })
                  if (mode === 'noop') return ok(neutralize(noopText(key, ns, candidates[0])))
                  if (candidates.length > 0) {
                    return fail(neutralize(renderNeedsDecision(key, ns, candidates)))
                  }
                }
              }
              if (mode === 'supersede') {
                const old = opts.supersedes ?? stamped.meta.supersedes
                if (old === undefined) {
                  return fail(
                    `Refused to save "${key}" with mode "supersede": pass supersedes: "<old key>" ` +
                      'naming the entry this one replaces. Nothing was stored.',
                  )
                }
                if (isHiddenKey(old)) {
                  return fail(
                    `Refused to supersede "${old}": it is an index or a bookkeeping entry, not a ` +
                      'note. Nothing was stored.',
                  )
                }
                const oldContent = await storedNote(timer, ns, old, view)
                if (oldContent === null) {
                  return fail(
                    `Refused to supersede "${old}": there is no such entry in ${ns}. Call ` +
                      'memory_list to see the keys that exist. Nothing was stored.',
                  )
                }
                const oldMeta = noteMeta(oldContent)
                if (oldMeta.status === 'superseded' || oldMeta.status === 'deleted') {
                  return fail(
                    `Refused to supersede "${old}": it is already ${oldMeta.status}` +
                      `${oldMeta.supersededBy ? ` by "${oldMeta.supersededBy}"` : ''}. ` +
                      'Supersede the entry that replaced it, or save with mode: "add". Nothing was stored.',
                  )
                }
                if (parseFrontmatter(oldContent)?.fields.get('locked') === true && !opts.force) {
                  return fail(
                    `Refused to supersede "${old}": it is locked (locked: true in its frontmatter). ` +
                      'Pass force: true if it really should be replaced. Nothing was stored.',
                  )
                }
                entries[old] = markSuperseded(oldContent, key)
                extra.push(
                  `(marked "${old}" superseded by "${key}"; recall hides it unless include_inactive)`,
                )
              }
            }
          }
          const { result: r, notes } = await pushWithBookkeeping(timer, ns, entries, [], view)
          timer.entries += Object.keys(entries).length
          // A 2xx does not mean this key landed: the server refuses oversized and
          // malformed entries per key and reports them here. Match on the key
          // that was sent, since another key's refusal says nothing about this one.
          const refused = r.skipped?.find(s => s.key === key)
          if (refused) return fail(skippedText(key, ns, refused.reason))
          const status = r.uploaded.includes(key) ? 'saved' : 'unchanged'
          const lines = [`${status} "${key}" in ${ns} (v${r.version})`]
          if (corrected.length) lines.push(neutralize(correctedLine(corrected)))
          for (const other of Object.keys(entries)) {
            if (other === key) continue
            const refusedOther = r.skipped?.find(s => s.key === other)
            if (refusedOther) {
              extra.push(
                `(the server refused the change to "${other}" (${bounded(refusedOther.reason, 80)}); ` +
                  'it is still active)',
              )
            }
          }
          lines.push(...extra, ...notes)
          return ok(lines.join('\n'))
        } catch (e) {
          if (e instanceof Rendered) return fail(e.message)
          if (e instanceof SecretFoundError) {
            return fail(
              `Refused to save "${key}" — it looks like it contains a secret:\n${e.message}`,
            )
          }
          const d = denial(`Saving "${key}"`, ns, defaultNamespace, 'Nothing was stored.', e)
          return fail(d ?? `save failed: ${bounded((e as Error).message)}`)
        }
      },
    ),

    /** Rank stored memories by relevance to a natural-language query. */
    recall: timed(
      async (
        timer,
        query: string,
        namespace?: string,
        limit: number = 5,
        namespaces?: string[],
        opts: RecallOptions = {},
      ) => {
        const includeInactive = opts.includeInactive === true
        try {
          if (namespaces && namespace !== undefined)
            throw new Error('use either namespace or namespaces, not both')
          if (namespaces && (namespaces.length === 0 || namespaces.length > 8))
            throw new Error('namespaces must contain between 1 and 8 namespaces')
          const sources = namespaces
            ? [...new Set(namespaces.map(ns => validateNamespace(ns.trim())))]
            : [nsOf(namespace)]
          const ns = sources.join(', ')
          // Recall is the one read that may be answered from the local cache
          // while the server is unreachable: it is read-only, it is what an
          // agent needs first, and the lead line says so when it happens.
          // `get` and `search` do not allow it, nor does any write.
          let staleMs: number | null = null
          const pulled = await Promise.all(
            sources.map(async source => {
              try {
                const r = await pullTimed(timer, source, { allowStale: true })
                if (r.served?.source === 'mirror')
                  staleMs = Math.max(staleMs ?? 0, r.served.staleMs)
                if (Object.keys(r.entries).length === 0 && r.served?.source !== 'mirror') {
                  const lost = await lostEntries(client, source, r.version)
                  if (lost) throw new Rendered(lost)
                }
                return { source, entries: r.entries, docs: docsOf(r, source, !!namespaces) }
              } catch (err) {
                if (err instanceof Rendered) throw err
                const d = denial(
                  'Recalling memories',
                  source,
                  defaultNamespace,
                  'No memories were read.',
                  err,
                )
                if (d) throw new Rendered(d)
                if (!namespaces) throw err
                throw new Error(`could not read ${source}: ${bounded((err as Error).message)}`)
              }
            }),
          )
          // Bookkeeping entries are not memory: a namespace holding nothing but
          // the access sidecar reads as one that holds nothing.
          if (pulled.every(p => p.docs.every(d => isSystemKey(d.key))))
            return ok(`(no memory stored in ${ns} yet)`)
          // The region shown for a hit is cut from what this call pulled,
          // never from the index's copy, so what the caller reads is what the
          // server served this time.
          const fresh = new Map(pulled.map(p => [p.source, p.entries]))
          const contentOf = (key: string, source: string) => {
            const entries = fresh.get(source)
            return entries && Object.hasOwn(entries, key) ? entries[key] : undefined
          }
          const day = today()
          const {
            results: ranked,
            searched,
            inactive,
            belowFloor,
            trimmedByLimit,
            reason,
          } = await timer.time('rank', () =>
            RecallIndex.rank(
              pulled.map(p => {
                const idx = indexFor(p.source)
                idx.sync(p.docs)
                return idx
              }),
              query,
              limit,
              { includeInactive, today: day },
            ),
          )
          // A superseded, deleted or expired note is not searched unless asked
          // for, and a miss has to say so: "12 entries searched" with the
          // thirteenth silently skipped is how an agent concludes a fact it
          // replaced last week was never recorded at all.
          const hiddenNote = inactive
            ? ` (${inactive} superseded, deleted or expired entr${inactive === 1 ? 'y' : 'ies'} ` +
              'not searched; pass include_inactive to include them)'
            : ''
          if (ranked.length === 0 && searched === 0) {
            // Entries exist but none of them is a ranking candidate: the
            // namespace holds nothing but its MEMORY.md index, or nothing but
            // notes that have been replaced. "0 entries searched" reads as an
            // empty namespace and is how an agent concludes there is nothing
            // here, when in fact what is here is the table of contents naming
            // everything that was ever written, or the notes themselves.
            if (inactive)
              return ok(
                `(nothing in ${ns} was searched for "${query}": every note is superseded, ` +
                  `deleted or expired, which recall does not rank by default${hiddenNote}. ` +
                  'Call memory_list to see the keys that exist.)',
              )
            return ok(
              `(nothing in ${ns} was searched for "${query}": the namespace holds only its ` +
                'MEMORY.md index, which recall does not rank. Call memory_get with key ' +
                '"MEMORY.md" to read the index itself.)',
            )
          }
          if (ranked.length === 0 && reason === 'no-content-terms') {
            // Nothing was scored, so the below-floor count is 0 and reporting it
            // would claim the corpus was searched and came back empty. It was
            // not: the query was all function words.
            return ok(
              `(no searchable words in "${query}": every term is a function word the ranker ` +
                `drops, so none of the ${searched} entr${searched === 1 ? 'y' : 'ies'} in ${ns} ` +
                'was scored. Retry with the distinctive words you expect the entry to contain, ' +
                'or call memory_list.)',
            )
          }
          if (ranked.length === 0) {
            // A bare miss is read as "this fact was never recorded", and the agent
            // then saves it again under a second key that phase 1 has no way to
            // reconcile with the first. So the miss says what was searched and
            // names the next move. Per KTD-B the below-floor entries stay
            // withheld: the count is a number and nothing more, because an entry
            // the ranker judged irrelevant is not made relevant by summarizing it
            // here, and leaking its key or text would spend the caller's context
            // on exactly what the floor exists to keep out.
            return ok(
              `(nothing in ${ns} looks relevant to "${query}". ` +
                `${searched} entr${searched === 1 ? 'y' : 'ies'} searched, ` +
                `${belowFloor} below the relevance floor and withheld. ` +
                'Call memory_list before concluding the fact is unrecorded; ' +
                `it may be stored under wording this query did not match.)${hiddenNote}`,
            )
          }
          // Regions, not bodies, and the aggregate budget is spent in rank order:
          // the strongest hit gets its full per-hit allowance and whatever is left
          // bounds the rest. Hits the budget cannot reach are reported by count
          // rather than dropped silently, so the caller can tell a short answer
          // from a truncated one.
          //
          // The budget covers the WHOLE returned string, not just the regions.
          // Charging only the parts left the lead line, the tail and every "\n\n"
          // joiner outside the bound, and a limit-20 recall measured 4,158 against
          // a documented 4,000: a cap the output can exceed is not a cap. Both
          // fixed pieces are reserved at their worst case (every hit omitted, so
          // the tail is present and its count is as wide as it can get) because
          // both lengths depend on numbers that are only known once the loop that
          // spends the budget has finished.
          const staleNote =
            staleMs === null
              ? ''
              : ` (served from the local cache, ${Math.round(staleMs / 1000)}s stale: the server could not be reached)`
          const leadFor = (n: number) =>
            `${n} relevant memor${n === 1 ? 'y' : 'ies'} from ${ns}${staleNote}:\n\n`
          // Two different reasons a relevant entry is missing, and both have to be
          // reported. Only budget omissions were counted, so `limit` trimming was
          // silent: a namespace with 15 entries above the floor and a limit of 5
          // rendered identically to one holding exactly 5, and "5 relevant
          // memories" reads as the whole answer. `belowFloor` cannot cover this,
          // since it is computed before the slice and excludes limit trimming by
          // definition, which is why the ranker now reports `trimmedByLimit`.
          const REASON_BUDGET = 'the recall size cap was reached'
          const REASON_LIMIT = 'more cleared the relevance floor than `limit` allows'
          const REASON_BOTH = `${REASON_BUDGET}, and ${REASON_LIMIT}`
          const tailFor = (n: number, why: string) =>
            n
              ? `\n\n(${n} further relevant entr${n === 1 ? 'y' : 'ies'} not shown: ${why}. Call memory_list, then memory_get by key.)`
              : ''
          const parts: string[] = []
          // Reserved at the worst case on BOTH axes, the widest count and the
          // longest reason, because the cap covers the whole returned string and
          // neither value is known until the loop below has finished.
          let budget =
            AGGREGATE_CHARS -
            leadFor(ranked.length).length -
            tailFor(ranked.length + trimmedByLimit, REASON_BOTH).length
          let omitted = 0
          const formatted = await timer.time('format', () => {
            for (const r of ranked) {
              const header = `### ${r.key}${namespaces ? ` (${r.namespace})` : ''}\n`
              const pointer =
                `\n(region only; call memory_get with key "${r.key}"` +
                `${namespaces ? ` and namespace "${r.namespace}"` : ''} for the full entry)`
              // The trailer is part of the hit, so it is charged to the per-hit
              // allowance as well as reserved from the aggregate like the pointer.
              const trailer = trailerFor(
                r.key,
                r.meta,
                includeInactive && isInactive(r.meta ?? {}, day),
              )
              const joiner = parts.length ? '\n\n'.length : 0
              const allowed = Math.min(
                PER_HIT_CHARS - trailer.length,
                budget - joiner - header.length - pointer.length - trailer.length,
              )
              if (allowed < MIN_REGION_CHARS) {
                omitted++
                continue
              }
              const source = r.namespace ?? sources[0]
              const region = regionFor(contentOf(r.key, source) ?? r.content, query, allowed)
              // The region and the trailer are what the model reads, so they are
              // neutralized here; `memory_get` returns the same entry verbatim,
              // as data.
              const part =
                header + neutralize(region.text + trailer) + (region.partial ? pointer : '')
              budget -= joiner + part.length
              parts.push(part)
              noteAccess(session.pendingAccess, source, r.key, day)
            }
            const shown = parts.length
            const tail = tailFor(
              omitted + trimmedByLimit,
              omitted && trimmedByLimit ? REASON_BOTH : omitted ? REASON_BUDGET : REASON_LIMIT,
            )
            return `${leadFor(shown)}${parts.join('\n\n')}${tail}`
          })
          for (const source of sources) await flushIfDue(timer, source)
          return ok(formatted)
        } catch (e) {
          if (e instanceof Rendered) return fail(e.message)
          return fail(`recall failed: ${bounded((e as Error).message)}`)
        }
      },
    ),

    /**
     * Return one entry's full body, untruncated. This is the read affordance
     * that makes bounding other surfaces safe: nothing they trim is lost,
     * because the agent can always name the key and get the whole entry back.
     *
     * Three properties of this tool are contract, not accident:
     *
     * Bound. Output is bounded by the caller naming exactly one key per call,
     * so unlike recall the size of the namespace cannot amplify a single call.
     * An agent looping this over `memory_list` keys can still reassemble the
     * whole namespace, but only one host-visible call at a time — which is the
     * property that makes the loop observable. A batch or multi-key variant
     * would break that and is deliberately out of scope for phase 1.
     *
     * Data contract. The body is passed through verbatim, as data. Nothing in
     * the entry is parsed or interpreted, and no value derived from entry
     * content is ever used to choose a key, namespace, or path: the key and
     * namespace echoed back are the caller's arguments and nothing else.
     *
     * Cost. One manifest read plus one blob, through `client.entry()` and the
     * server's `?view=entry`, so the size of the namespace does not enter into
     * a single-entry read. (It used to reuse `client.pull`, which paid a
     * whole-namespace download and decrypt per read: 250 ms at 5,000 entries.)
     * A server that predates the entry view answers the full namespace to it;
     * the client reports that as a protocol error and this falls back to the
     * pull it still understands.
     *
     * What the single-entry read records for the write precondition is exactly
     * that key's ciphertext hash and nothing about any other key; recall still
     * observes everything it decrypts. A save of some other key after only a
     * `get` therefore carries no base for it, as a first write never did.
     */
    get: timed(async (timer, key: string, namespace?: string) => {
      const ns = nsOf(namespace)
      try {
        let body: string
        try {
          body = await timer.time('fetch', () => client.entry(ns, key))
          timer.entries = 1
        } catch (e) {
          if (e instanceof OpenRecallHttpError) {
            // The server's own `empty`: no manifest, nothing written yet.
            if (e.status === 404 && e.code === 'empty') return ok(`(no memory stored in ${ns} yet)`)
            // `entry_not_found`, or a key the server will not even look up
            // (`invalid_key`): either way there is no such entry to return.
            if (e.status === 404 || e.status === 400)
              return ok(`(no entry "${key}" in ${ns}, call memory_list to see the keys that exist)`)
            if (e.status === 503 && e.code === 'entry_unreadable')
              return fail(unreadableEntry(key, ns))
          }
          if (e instanceof OpenRecallProtocolError) return getViaPull(timer, key, ns)
          throw e
        }
        if (!isHiddenKey(key)) {
          noteAccess(session.pendingAccess, ns, key, today())
          await flushIfDue(timer, ns)
        }
        return ok(`### ${key} (${ns})\n${body}`)
      } catch (e) {
        const d = denial(`Reading "${key}"`, ns, defaultNamespace, 'Nothing was read.', e)
        return fail(d ?? `get failed: ${bounded((e as Error).message)}`)
      }
    }),

    /** Literal substring/keyword search over keys and decrypted content. */
    search: timed(async (timer, query: string, namespace?: string) => {
      const ns = nsOf(namespace)
      const needle = query.toLowerCase()
      try {
        const { entries, version } = await pullTimed(timer, ns)
        if (Object.keys(entries).length === 0) {
          const lost = await lostEntries(client, ns, version)
          if (lost) return fail(lost)
        }
        // Bookkeeping entries are skipped: the sidecar names every key that was
        // ever recalled, so it would match nearly any search for a key.
        const hits = await timer.time('rank', () =>
          Object.entries(entries).filter(
            ([key, content]) =>
              !isSystemKey(key) &&
              (key.toLowerCase().includes(needle) || content.toLowerCase().includes(needle)),
          ),
        )
        if (hits.length === 0) return ok(`no matches for "${query}" in ${ns}`)
        const body = hits
          .map(([key, content]) => `- ${key}: ${neutralize(snippet(content))}`)
          .join('\n')
        return ok(`${hits.length} match(es) for "${query}" in ${ns}:\n${body}`)
      } catch (e) {
        const d = denial('Searching memories', ns, defaultNamespace, 'No memories were read.', e)
        return fail(d ?? `search failed: ${bounded((e as Error).message)}`)
      }
    }),

    /**
     * List entry keys in a namespace (no content downloaded). Bookkeeping
     * entries under `sys.openrecall/` are left out unless asked for: they are
     * not notes, and a listing is what an agent reads to decide what exists.
     */
    list: timed(async (timer, namespace?: string, opts: ListOptions = {}) => {
      const ns = nsOf(namespace)
      try {
        const hashes = await timer.time('fetch', () => client.hashes(ns, { observe: false }))
        const all = Object.keys(hashes).sort()
        const keys = opts.includeSystem ? all : all.filter(k => !isSystemKey(k))
        const hidden = all.length - keys.length
        timer.entries = keys.length
        if (all.length === 0) return ok(`(${ns} is empty)`)
        const hiddenNote = hidden
          ? `${hidden} bookkeeping entr${hidden === 1 ? 'y' : 'ies'} under ${SYSTEM_PREFIX} not listed; pass include_system: true to see ${hidden === 1 ? 'it' : 'them'}`
          : ''
        if (keys.length === 0) return ok(`(${ns} holds no notes; ${hiddenNote})`)
        return ok(
          `${keys.length} entr${keys.length === 1 ? 'y' : 'ies'} in ${ns}:\n${keys.map(k => `- ${k}`).join('\n')}` +
            (hidden ? `\n(${hiddenNote})` : ''),
        )
      } catch (e) {
        const d = denial('Listing entries', ns, defaultNamespace, 'No entry keys were read.', e)
        return fail(d ?? `list failed: ${bounded((e as Error).message)}`)
      }
    }),

    /**
     * Delete one entry: by default a move to the trash, `hard` an erasure.
     *
     * The stored note is read first so a locked one is refused. A soft delete
     * writes the note under `sys.openrecall/trash/<key>` stamped
     * `status: deleted` and `deleted: <now>` and deletes the original in the
     * same request, so nothing an agent removes is gone until someone erases
     * it on purpose; trash entries are hidden keys, never ranked, listed or
     * compared. `hard: true` erases the note and its trash copy, and is the
     * only way to delete a key already in the trash. A key too long to park
     * is erased with a note saying so. Every deletion goes through the push
     * route, never the bare delete, so the regenerated index (without the
     * deleted key) and any pending access stamps land in the same request.
     */
    delete: timed(async (timer, key: string, namespace?: string, opts: DeleteOptions = {}) => {
      const ns = nsOf(namespace)
      const inTrash = key.startsWith(TRASH_PREFIX)
      if (isSystemKey(key) && !inTrash) return fail(reservedKey(key, 'delete'))
      if (inTrash && !opts.hard) {
        return fail(
          `Refused to delete "${key}": it is already in the trash. Pass hard: true to erase it. ` +
            `"${key}" is still stored.`,
        )
      }
      try {
        const existing = await timer.time('fetch', () => readExisting(ns, key, true))
        const lock = lockedRefusal(existing, key, ns, 'delete')
        if (lock && !opts.force) return fail(lock)
        const parked = inTrash ? null : trashKey(key)
        const hard = opts.hard === true || existing === null || parked === null
        const entries: Record<string, string> = {}
        const deletions = [key]
        if (hard) {
          // The trash copy goes with the note: "erase" means nowhere.
          if (parked !== null) deletions.push(parked)
        } else {
          entries[parked as string] = markDeleted(existing as string, new Date().toISOString())
        }
        const { result: r, notes } = await pushWithBookkeeping(timer, ns, entries, deletions)
        const refused = r.skipped?.find(s => s.key === key || (!hard && s.key === parked))
        if (refused) {
          return fail(
            `Deleting "${key}" from ${ns} was refused by the server (${bounded(refused.reason, 80)}). "${key}" is still stored.`,
          )
        }
        const deleted = r.deleted.includes(key)
        timer.entries += deleted ? 1 : 0
        if (!deleted) {
          if (parked !== null && r.deleted.includes(parked))
            return ok(
              `erased the trash copy of "${key}" from ${ns} (v${r.version}); it was not stored itself`,
            )
          return ok(`nothing to delete — "${key}" is not in ${ns}`)
        }
        if (!hard) {
          return ok(
            [
              `moved "${key}" to the trash in ${ns} (v${r.version}); memory_delete hard=true erases it`,
              ...notes,
            ].join('\n'),
          )
        }
        const lines = [`deleted "${key}" from ${ns} (v${r.version})`]
        if (!opts.hard && !inTrash) {
          lines.push(
            existing === null
              ? '(its body could not be read, so it was erased rather than moved to the trash)'
              : '(its key is too long to park under the trash prefix, so it was erased rather than moved)',
          )
        }
        return ok([...lines, ...notes].join('\n'))
      } catch (e) {
        if (e instanceof Rendered) return fail(e.message)
        const d = denial(`Deleting "${key}"`, ns, defaultNamespace, `"${key}" is still stored.`, e)
        return fail(d ?? `delete failed: ${bounded((e as Error).message)}`)
      }
    }),
  }

  // -------------------------------------------------------------------------
  // The doctor: an audit that proposes and writes nothing (`./doctor.ts`)
  // -------------------------------------------------------------------------

  /**
   * Run markers kept in memory: what this process recorded, and the whole
   * store when no marker path was given or the file cannot be written. The
   * file wins on a read, so a marker another process wrote is honoured.
   */
  const memoryMarkers: DoctorMarkers = {}
  let markerWarned = false
  const warn = options.warn ?? (() => {})

  async function markerFor(ns: string): Promise<DoctorMarker | undefined> {
    const key = markerKey(ns)
    const path = options.doctorMarkerPath
    const stored = path ? (await readMarker(path))[key] : undefined
    return stored ?? memoryMarkers[key]
  }

  /** Finding kinds by count, most frequent first; ties keep report order. */
  function kindsByCount(report: DoctorReport): string[] {
    const counts = new Map<string, number>()
    for (const f of report.findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([kind]) => kind)
  }

  /**
   * What a run leaves behind, per namespace: the session's record (the banner
   * reads it), the in-memory markers, and the marker file when there is one.
   * An unwritable file is said once and never stops a run.
   */
  async function recordRuns(
    runs: { ns: string; version: number; report: DoctorReport }[],
    now: string,
    announced: boolean,
  ): Promise<void> {
    const update: DoctorMarkers = {}
    for (const { ns, version, report } of runs) {
      const findings = report.findings.length
      session.doctor.set(ns, {
        ranAt: now,
        version,
        findings,
        kinds: kindsByCount(report),
        announced,
      })
      update[markerKey(ns)] = { ranAt: now, version, findings }
    }
    Object.assign(memoryMarkers, update)
    const path = options.doctorMarkerPath
    if (!path) return
    const merged = { ...(await readMarker(path)), ...update }
    if (!(await writeMarker(path, merged)) && !markerWarned) {
      markerWarned = true
      warn(`doctor: could not write ${path}; run markers are kept in memory for this process only`)
    }
  }

  /** The doctor's view of one pulled namespace, with the sidecar's access dates parsed out. */
  function doctorInput(ns: string, view: PullResult, now: string): DoctorInput {
    const sidecar = Object.hasOwn(view.entries, ACCESSED_KEY)
      ? view.entries[ACCESSED_KEY]
      : undefined
    return {
      namespace: ns,
      entries: view.entries,
      updatedAt: view.updatedAt,
      accessed: parseAccessed(sidecar).keys,
      now,
      // The server's defaults, not `src/config.ts`: that module freezes the
      // caps the test server runs under, and the meters are about production.
      caps: DEFAULT_CAPS,
    }
  }

  /**
   * The one write the doctor may trigger: the pending access stamps for `ns`,
   * flushed through the sidecar's own path, so the stale-by-access horizons
   * are judged on what this session has read.
   */
  async function flushPending(timer: Timer, ns: string): Promise<void> {
    const pending = session.pendingAccess.get(ns)
    if (!pending?.size) return
    await timer.time('fetch', () => flushAccessed(client, ns, pending))
  }

  /**
   * Audit one or several namespaces and render the report, at most
   * `DEFAULT_MAX_CHARS` characters including the lead line. Read-only: each
   * namespace is pulled with `observe: false`, so the audit never becomes the
   * base of a later write, and nothing is pushed but the access flush above.
   * The run is recorded as announced, since the caller is reading the report.
   */
  const doctor = timed(async (timer, namespace?: string, namespaces?: string[]) => {
    try {
      if (namespaces && namespace !== undefined)
        throw new Error('use either namespace or namespaces, not both')
      if (namespaces && (namespaces.length === 0 || namespaces.length > 8))
        throw new Error('namespaces must contain between 1 and 8 namespaces')
      const sources = namespaces
        ? [...new Set(namespaces.map(ns => validateNamespace(ns.trim())))]
        : [nsOf(namespace)]
      const ns = sources.join(', ')
      const now = new Date().toISOString()
      for (const source of sources) await flushPending(timer, source)
      const views = await Promise.all(
        sources.map(async source => {
          try {
            const r = await pullTimed(timer, source, { observe: false })
            if (Object.keys(r.entries).length === 0) {
              const lost = await lostEntries(client, source, r.version)
              if (lost) throw new Rendered(lost)
            }
            return r
          } catch (err) {
            if (err instanceof Rendered) throw err
            const d = denial(
              'Auditing memory',
              source,
              defaultNamespace,
              'Nothing was audited.',
              err,
            )
            if (d) throw new Rendered(d)
            if (!namespaces) throw err
            throw new Error(`could not read ${source}: ${bounded((err as Error).message)}`)
          }
        }),
      )
      const inputs = views.map((view, i) => doctorInput(sources[i] as string, view, now))
      const { each, across } = await timer.time('rank', () => runDoctorAll(inputs))
      await recordRuns(
        sources.map((source, i) => ({
          ns: source,
          version: (views[i] as PullResult).version,
          report: each[i] as DoctorReport,
        })),
        now,
        true,
      )
      const lead = `doctor report for ${ns}:\n`
      const text = await timer.time(
        'format',
        () => lead + renderReport(across, { maxChars: DEFAULT_MAX_CHARS - lead.length }),
      )
      return ok(text)
    } catch (e) {
      if (e instanceof Rendered) return fail(e.message)
      return fail(`doctor failed: ${bounded((e as Error).message)}`)
    }
  })

  /**
   * The scheduled run: the doctor over `ns` when one is due by its marker
   * (`isDue`: none, more than a day old, or ten or more writes behind the
   * manifest), recorded as not yet announced so the next recall or save on
   * the namespace appends the banner. The manifest version comes from the
   * pull the audit needs anyway, which also warms the client's cache for the
   * first recall. Never throws: a namespace that cannot be read right now is
   * not audited, and the caller hears why.
   */
  async function doctorIfDue(ns: string, opts: { now?: string } = {}): Promise<DoctorDue> {
    const now = opts.now ?? new Date().toISOString()
    const timer = new Timer()
    try {
      const marker = await markerFor(ns)
      await flushPending(timer, ns)
      const view = await pullTimed(timer, ns, { observe: false })
      if (!isDue(marker, now, view.version)) return { ran: false, reason: 'not-due' }
      const report = runDoctorAll([doctorInput(ns, view, now)]).across
      await recordRuns([{ ns, version: view.version, report }], now, false)
      return {
        ran: true,
        findings: report.findings.length,
        kinds: session.doctor.get(ns)?.kinds ?? [],
      }
    } catch (e) {
      return { ran: false, reason: 'failed', error: bounded((e as Error).message) }
    }
  }

  /**
   * The one banner line a scheduled run earns, for the namespaces a recall
   * or save touched: findings and the two most frequent kinds per namespace,
   * then cleared, so it is shown once. Nothing for a run with no findings or
   * one already shown, which keeps every pinned output string intact.
   */
  function bannerFor(sources: string[]): string | null {
    const parts: string[] = []
    for (const ns of sources) {
      const run = session.doctor.get(ns)
      if (!run || run.announced || run.findings === 0) continue
      run.announced = true
      parts.push(
        `${run.findings} ${plural(run.findings, 'suggestion')} for ${ns} (${run.kinds.slice(0, 2).join(', ')})`,
      )
    }
    if (parts.length === 0) return null
    return `(memory_doctor: ${parts.join(' and ')}; call memory_doctor to see them)`
  }

  /**
   * `fn` with the banner appended as a final line when one is pending for the
   * namespaces `sourcesOf` names. A failed call is left alone, and so is one
   * whose arguments `sourcesOf` cannot read (the call has already said why).
   * The banner is outside the tool's own size budget, like the timings
   * trailer: one short line, at most once per scheduled run.
   */
  function withBanner<A extends unknown[]>(
    fn: (...args: A) => Promise<ToolResult>,
    // The whole argument tuple, under `NoInfer`: the tool's own signature
    // decides `A`, optional parameters included, and the reader picks from it.
    sourcesOf: (args: NoInfer<A>) => string[],
  ): (...args: A) => Promise<ToolResult> {
    return async (...args: A) => {
      const r = await fn(...args)
      if (r.isError) return r
      let sources: string[]
      try {
        sources = sourcesOf(args)
      } catch {
        return r
      }
      const banner = bannerFor(sources)
      return banner ? { ...r, text: `${r.text}\n${banner}` } : r
    }
  }

  return {
    ...tools,
    recall: withBanner(tools.recall, ([, namespace, , namespaces]) =>
      namespaces ? namespaces.map(ns => validateNamespace(ns.trim())) : [nsOf(namespace)],
    ),
    save: withBanner(tools.save, ([, , namespace]) => [nsOf(namespace)]),
    doctor,
    doctorIfDue,
  }
}
