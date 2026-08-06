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
import { rankMemoriesDetailed, stemTerm } from './relevance.ts'

export type ToolResult = { text: string; isError?: boolean }

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
 * Drop YAML-ish frontmatter. It is metadata the ranker already reads through
 * `description:`, and returning it as a region would spend the budget on the
 * one part of an entry that never answers the question.
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

function regionTerms(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(t => t.length > 1).map(stemTerm)
}

/**
 * The block carrying the strongest query-term match, earliest on a tie.
 *
 * A term is weighted by how few of this entry's blocks contain it, which is the
 * same rarity idea the ranker applies across entries, applied here within one.
 * That is what keeps a word repeated in every paragraph (the entry's own topic,
 * or a function word the ranker's stoplist caught but this layer cannot reach)
 * from outvoting the rare word that actually located the answer.
 */
function pickBlock(blocks: Block[], query: string): Block {
  const q = new Set(regionTerms(query))
  const sets = blocks.map(b => new Set(regionTerms(`${b.heading}\n${b.text}`)))
  const weight = new Map<string, number>()
  for (const t of q) {
    const df = sets.reduce((n, s) => n + (s.has(t) ? 1 : 0), 0)
    if (df > 0) weight.set(t, Math.log(1 + blocks.length / df))
  }
  let best = 0
  let bestScore = -1
  for (let i = 0; i < blocks.length; i++) {
    let score = 0
    for (const [t, w] of weight) if (sets[i].has(t)) score += w
    if (score > bestScore) {
      best = i
      bestScore = score
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
  if (blocks.length === 0) return { text: '', partial: body.length > 0 }
  const block = pickBlock(blocks, query)
  const text = block.fence && block.text.length > cap ? ELIDED_FENCE : block.text

  let prefix = ''
  if (block.heading) {
    const h = clip(block.heading, Math.floor(cap / 3))
    if (cap - h.length - 1 >= MIN_REGION_CHARS) prefix = `${h}\n`
  }
  const out = prefix + clip(text, cap - prefix.length)
  return { text: out, partial: out !== body }
}

export type MemoryTools = ReturnType<typeof makeTools>

export function makeTools(client: OpenRecallClient, defaultNamespace: string) {
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
        } = rankMemoriesDetailed(query, entries, limit)
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
        const parts: string[] = []
        let budget = AGGREGATE_CHARS
        let omitted = 0
        for (const r of ranked) {
          const header = `### ${r.key}\n`
          const pointer = `\n(region only; call memory_get with key "${r.key}" for the full entry)`
          const allowed = Math.min(PER_HIT_CHARS, budget - header.length - pointer.length)
          if (allowed < MIN_REGION_CHARS) {
            omitted++
            continue
          }
          const region = regionFor(r.content, query, allowed)
          const part = header + region.text + (region.partial ? pointer : '')
          budget -= part.length
          parts.push(part)
        }
        const shown = parts.length
        const tail = omitted
          ? `\n\n(${omitted} further relevant entr${omitted === 1 ? 'y' : 'ies'} not shown: the recall size cap was reached. Call memory_list, then memory_get by key.)`
          : ''
        return ok(
          `${shown} relevant memor${shown === 1 ? 'y' : 'ies'} from ${ns}:\n\n${parts.join('\n\n')}${tail}`,
        )
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
