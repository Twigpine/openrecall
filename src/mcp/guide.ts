/**
 * Loads the memory-usage guidance that the MCP server exposes (as the
 * `memory_guide` prompt and a short form in the server `instructions`).
 *
 * The canonical text lives in skills/openrecall-memory/SKILL.md so there's ONE
 * source of truth shared by the Claude Code skill and provider-neutral MCP
 * clients. We read that file's body (frontmatter stripped) at startup; if it
 * isn't present (e.g. an unusual package layout), we fall back to a compact
 * inline version so the prompt is never empty.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FALLBACK = `# openrecall memory

You have durable, end-to-end-encrypted memory via the openrecall MCP tools.

- **Recall first.** At the start of a task, call \`memory_recall\` with a
  description of what you're doing before asking the user things they may have
  already told you. Act on what comes back; don't announce it.
- **Save what's durable.** When you learn a stable, reusable fact — a user
  preference, a project decision, a convention, or feedback on how to work —
  persist it with \`memory_save\`. Skip transient context and anything obvious
  from the repo. Never save secrets.
- **Maintain it.** Search before adding to avoid duplicates; update or
  \`memory_delete\` facts that are wrong or stale; keep a \`MEMORY.md\` index.

Tools: memory_save(key, content) · memory_recall(query, limit?) ·
memory_search(query) · memory_list() · memory_delete(key).`

function stripFrontmatter(md: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(md)
  return m ? md.slice(m[0].length).trimStart() : md
}

/** The full memory-usage guide (SKILL.md body, or the inline fallback). */
export function loadMemoryGuide(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url)) // src/mcp
    const skillPath = join(here, '..', '..', 'skills', 'openrecall-memory', 'SKILL.md')
    const body = stripFrontmatter(readFileSync(skillPath, 'utf8')).trim()
    return body.length > 0 ? body : FALLBACK
  } catch {
    return FALLBACK
  }
}

/** One-paragraph version embedded in the MCP server `instructions`. */
export const SHORT_INSTRUCTIONS =
  'You have durable, end-to-end-encrypted memory via these tools. At the start ' +
  'of a task, call memory_recall to retrieve what you already know about this ' +
  'user and project before asking them to repeat it. When you learn a stable ' +
  'fact (a preference, a project decision, a convention, or feedback on how to ' +
  'work), persist it with memory_save; skip transient context and never save ' +
  'secrets. Search before adding to avoid duplicates. Call the "memory_guide" ' +
  'prompt for the full protocol.'
