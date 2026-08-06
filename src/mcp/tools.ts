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
import { rankMemories } from './relevance.ts'

export type ToolResult = { text: string; isError?: boolean }

const ok = (text: string): ToolResult => ({ text })
const fail = (text: string): ToolResult => ({ text, isError: true })

function snippet(content: string, max = 200): string {
  const oneLine = content.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
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
        const ranked = rankMemories(query, entries, limit)
        if (ranked.length === 0) return ok(`(nothing in ${ns} looks relevant to "${query}")`)
        const body = ranked.map(r => `### ${r.key}\n${r.content.trim()}`).join('\n\n')
        return ok(
          `${ranked.length} relevant memor${ranked.length === 1 ? 'y' : 'ies'} from ${ns}:\n\n${body}`,
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
