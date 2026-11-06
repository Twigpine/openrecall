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
} from '../../client/index.ts'
import { SecretFoundError } from '../../client/secretscan.ts'
import { validateNamespace } from '../namespace.ts'
import {
  type IndexDoc,
  RecallIndex,
  stripFrontmatterText,
  tokenize,
  tokenizeAll,
} from './relevance.ts'

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
 * narrowed to the five methods, so a test double is checked against the real
 * client's signatures by the compiler instead of being waved through with an
 * `as unknown as OpenRecallClient` cast. Two stubs had already drifted under those
 * casts (one returning `skipped` where `PushResult` says `unchanged`, and
 * omitting `namespace`), which is exactly the drift a cast hides.
 */
export type MemoryClient = Pick<OpenRecallClient, 'pull' | 'push' | 'hashes' | 'delete' | 'entry'>

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

export function makeTools(client: MemoryClient, defaultNamespace: string) {
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
    const idx = indexes.get(ns) ?? new RecallIndex()
    indexes.delete(ns)
    indexes.set(ns, idx)
    while (indexes.size > MAX_INDEXED_NAMESPACES) {
      const oldest = indexes.keys().next()
      if (oldest.done) break
      indexes.delete(oldest.value)
    }
    return idx
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
    return ok(`### ${key} (${ns})\n${entries[key]}`)
  }

  return {
    /** Persist one durable memory entry (encrypted before upload). */
    save: timed(async (timer, key: string, content: string, namespace?: string) => {
      const ns = nsOf(namespace)
      try {
        const r = await timer.time('fetch', () => client.push(ns, { [key]: content }))
        timer.entries = 1
        // A 2xx does not mean this key landed: the server refuses oversized and
        // malformed entries per key and reports them here. Match on the key
        // that was sent, since another key's refusal says nothing about this one.
        const refused = r.skipped?.find(s => s.key === key)
        if (refused) return fail(skippedText(key, ns, refused.reason))
        const status = r.uploaded.length ? 'saved' : 'unchanged'
        return ok(`${status} "${key}" in ${ns} (v${r.version})`)
      } catch (e) {
        if (e instanceof SecretFoundError) {
          return fail(
            `Refused to save "${key}" — it looks like it contains a secret:\n${e.message}`,
          )
        }
        const d = denial(`Saving "${key}"`, ns, defaultNamespace, 'Nothing was stored.', e)
        return fail(d ?? `save failed: ${bounded((e as Error).message)}`)
      }
    }),

    /** Rank stored memories by relevance to a natural-language query. */
    recall: timed(
      async (
        timer,
        query: string,
        namespace?: string,
        limit: number = 5,
        namespaces?: string[],
      ) => {
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
          if (pulled.every(p => p.docs.length === 0)) return ok(`(no memory stored in ${ns} yet)`)
          // The region shown for a hit is cut from what this call pulled,
          // never from the index's copy, so what the caller reads is what the
          // server served this time.
          const fresh = new Map(pulled.map(p => [p.source, p.entries]))
          const contentOf = (key: string, source: string) => {
            const entries = fresh.get(source)
            return entries && Object.hasOwn(entries, key) ? entries[key] : undefined
          }
          const {
            results: ranked,
            searched,
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
            ),
          )
          if (ranked.length === 0 && searched === 0) {
            // Entries exist but none of them is a ranking candidate, which today
            // means the namespace holds nothing but its MEMORY.md index. "0
            // entries searched" reads as an empty namespace and is how an agent
            // concludes there is nothing here, when in fact the one thing here is
            // the table of contents naming everything that was ever written.
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
                'it may be stored under wording this query did not match.)',
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
              const joiner = parts.length ? '\n\n'.length : 0
              const allowed = Math.min(
                PER_HIT_CHARS,
                budget - joiner - header.length - pointer.length,
              )
              if (allowed < MIN_REGION_CHARS) {
                omitted++
                continue
              }
              const region = regionFor(
                contentOf(r.key, r.namespace ?? sources[0]) ?? r.content,
                query,
                allowed,
              )
              const part = header + region.text + (region.partial ? pointer : '')
              budget -= joiner + part.length
              parts.push(part)
            }
            const shown = parts.length
            const tail = tailFor(
              omitted + trimmedByLimit,
              omitted && trimmedByLimit ? REASON_BOTH : omitted ? REASON_BUDGET : REASON_LIMIT,
            )
            return `${leadFor(shown)}${parts.join('\n\n')}${tail}`
          })
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
        const hits = await timer.time('rank', () =>
          Object.entries(entries).filter(
            ([key, content]) =>
              key.toLowerCase().includes(needle) || content.toLowerCase().includes(needle),
          ),
        )
        if (hits.length === 0) return ok(`no matches for "${query}" in ${ns}`)
        const body = hits.map(([key, content]) => `- ${key}: ${snippet(content)}`).join('\n')
        return ok(`${hits.length} match(es) for "${query}" in ${ns}:\n${body}`)
      } catch (e) {
        const d = denial('Searching memories', ns, defaultNamespace, 'No memories were read.', e)
        return fail(d ?? `search failed: ${bounded((e as Error).message)}`)
      }
    }),

    /** List entry keys in a namespace (no content downloaded). */
    list: timed(async (timer, namespace?: string) => {
      const ns = nsOf(namespace)
      try {
        const hashes = await timer.time('fetch', () => client.hashes(ns, { observe: false }))
        const keys = Object.keys(hashes).sort()
        timer.entries = keys.length
        if (keys.length === 0) return ok(`(${ns} is empty)`)
        return ok(
          `${keys.length} entr${keys.length === 1 ? 'y' : 'ies'} in ${ns}:\n${keys.map(k => `- ${k}`).join('\n')}`,
        )
      } catch (e) {
        const d = denial('Listing entries', ns, defaultNamespace, 'No entry keys were read.', e)
        return fail(d ?? `list failed: ${bounded((e as Error).message)}`)
      }
    }),

    /** Delete one entry. */
    delete: timed(async (timer, key: string, namespace?: string) => {
      const ns = nsOf(namespace)
      try {
        const r = await timer.time('fetch', () => client.delete(ns, key))
        timer.entries = r.deleted ? 1 : 0
        return r.deleted
          ? ok(`deleted "${key}" from ${ns} (v${r.version})`)
          : ok(`nothing to delete — "${key}" is not in ${ns}`)
      } catch (e) {
        const d = denial(`Deleting "${key}"`, ns, defaultNamespace, `"${key}" is still stored.`, e)
        return fail(d ?? `delete failed: ${bounded((e as Error).message)}`)
      }
    }),
  }
}
