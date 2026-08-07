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

import type { OpenRecallClient } from '../../client/index.ts'
import { SecretFoundError } from '../../client/secretscan.ts'
import { rankMemoriesDetailed, tokenize, tokenizeAll } from './relevance.ts'

export type ToolResult = { text: string; isError?: boolean }

/**
 * The client surface these tools actually use. Declared structurally, and
 * narrowed to the four methods, so a test double is checked against the real
 * client's signatures by the compiler instead of being waved through with an
 * `as unknown as MemlawbClient` cast. Two stubs had already drifted under those
 * casts (one returning `skipped` where `PushResult` says `unchanged`, and
 * omitting `namespace`), which is exactly the drift a cast hides.
 */
export type MemoryClient = Pick<OpenRecallClient, 'pull' | 'push' | 'hashes' | 'delete'>

const ok = (text: string): ToolResult => ({ text })
const fail = (text: string): ToolResult => ({ text, isError: true })

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
 * Drop YAML-ish frontmatter before the body is split into regions. It is
 * metadata the ranker already reads through `description:`, and returning it
 * alongside a body would spend the budget on the one part of an entry that
 * never answers the question.
 *
 * So frontmatter is never a region of an entry that HAS a body. It is not
 * unreachable, though: when the stripped body yields no block at all, the
 * fallback in `regionFor` emits the raw content, frontmatter included. That is
 * the whole entry, and an entry whose only content is its own description has
 * nothing else to show.
 */
function stripFrontmatter(content: string): string {
  const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(content)
  return m ? content.slice(m[0].length) : content
}

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
  const body = stripFrontmatter(content).trim()
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
  return { text: out, partial: out !== body }
}

export type MemoryTools = ReturnType<typeof makeTools>

export function makeTools(client: MemoryClient, defaultNamespace: string) {
  const nsOf = (ns?: string) => (ns?.trim() ? ns.trim() : defaultNamespace)

  return {
    /** Persist one durable memory entry (encrypted before upload). */
    async save(key: string, content: string, namespace?: string): Promise<ToolResult> {
      const ns = nsOf(namespace)
      try {
        const r = await client.push(ns, { [key]: content })
        const status = r.uploaded.length ? 'saved' : 'unchanged'
        return ok(`${status} "${key}" in ${ns} (v${r.version})`)
      } catch (e) {
        if (e instanceof SecretFoundError) {
          return fail(
            `Refused to save "${key}" — it looks like it contains a secret:\n${e.message}`,
          )
        }
        return fail(`save failed: ${(e as Error).message}`)
      }
    },

    /** Rank stored memories by relevance to a natural-language query. */
    async recall(query: string, namespace?: string, limit = 5): Promise<ToolResult> {
      const ns = nsOf(namespace)
      try {
        const { entries } = await client.pull(ns)
        if (Object.keys(entries).length === 0) return ok(`(no memory stored in ${ns} yet)`)
        const {
          results: ranked,
          searched,
          belowFloor,
          reason,
        } = rankMemoriesDetailed(query, entries, limit)
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
        const leadFor = (n: number) => `${n} relevant memor${n === 1 ? 'y' : 'ies'} from ${ns}:\n\n`
        const tailFor = (n: number) =>
          n
            ? `\n\n(${n} further relevant entr${n === 1 ? 'y' : 'ies'} not shown: the recall size cap was reached. Call memory_list, then memory_get by key.)`
            : ''
        const parts: string[] = []
        let budget = AGGREGATE_CHARS - leadFor(ranked.length).length - tailFor(ranked.length).length
        let omitted = 0
        for (const r of ranked) {
          const header = `### ${r.key}\n`
          const pointer = `\n(region only; call memory_get with key "${r.key}" for the full entry)`
          const joiner = parts.length ? '\n\n'.length : 0
          const allowed = Math.min(PER_HIT_CHARS, budget - joiner - header.length - pointer.length)
          if (allowed < MIN_REGION_CHARS) {
            omitted++
            continue
          }
          const region = regionFor(r.content, query, allowed)
          const part = header + region.text + (region.partial ? pointer : '')
          budget -= joiner + part.length
          parts.push(part)
        }
        const shown = parts.length
        const tail = tailFor(omitted)
        return ok(`${leadFor(shown)}${parts.join('\n\n')}${tail}`)
      } catch (e) {
        return fail(`recall failed: ${(e as Error).message}`)
      }
    },

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
     * Cost. This reuses `client.pull(ns)`, so it pays a whole-namespace
     * download and decrypt per single-entry read. Accepted for phase 1: no
     * client-side single-entry fetch exists and client/index.ts is out of
     * scope here. A list-then-get loop multiplies that cost linearly.
     */
    async get(key: string, namespace?: string): Promise<ToolResult> {
      const ns = nsOf(namespace)
      try {
        const { entries } = await client.pull(ns)
        if (Object.keys(entries).length === 0) return ok(`(no memory stored in ${ns} yet)`)
        // Own-property check, not `entries[key]`: a key like "__proto__" or
        // "toString" must miss, never resolve to something off the prototype.
        if (!Object.hasOwn(entries, key))
          return ok(`(no entry "${key}" in ${ns}, call memory_list to see the keys that exist)`)
        return ok(`### ${key} (${ns})\n${entries[key]}`)
      } catch (e) {
        return fail(`get failed: ${(e as Error).message}`)
      }
    },

    /** Literal substring/keyword search over keys and decrypted content. */
    async search(query: string, namespace?: string): Promise<ToolResult> {
      const ns = nsOf(namespace)
      const needle = query.toLowerCase()
      try {
        const { entries } = await client.pull(ns)
        const hits = Object.entries(entries).filter(
          ([key, content]) =>
            key.toLowerCase().includes(needle) || content.toLowerCase().includes(needle),
        )
        if (hits.length === 0) return ok(`no matches for "${query}" in ${ns}`)
        const body = hits.map(([key, content]) => `- ${key}: ${snippet(content)}`).join('\n')
        return ok(`${hits.length} match(es) for "${query}" in ${ns}:\n${body}`)
      } catch (e) {
        return fail(`search failed: ${(e as Error).message}`)
      }
    },

    /** List entry keys in a namespace (no content downloaded). */
    async list(namespace?: string): Promise<ToolResult> {
      const ns = nsOf(namespace)
      try {
        const hashes = await client.hashes(ns)
        const keys = Object.keys(hashes).sort()
        if (keys.length === 0) return ok(`(${ns} is empty)`)
        return ok(
          `${keys.length} entr${keys.length === 1 ? 'y' : 'ies'} in ${ns}:\n${keys.map(k => `- ${k}`).join('\n')}`,
        )
      } catch (e) {
        return fail(`list failed: ${(e as Error).message}`)
      }
    },

    /** Delete one entry. */
    async delete(key: string, namespace?: string): Promise<ToolResult> {
      const ns = nsOf(namespace)
      try {
        await client.delete(ns, key)
        return ok(`deleted "${key}" from ${ns}`)
      } catch (e) {
        return fail(`delete failed: ${(e as Error).message}`)
      }
    },
  }
}
