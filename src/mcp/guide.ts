/**
 * The memory-usage guidance the MCP server exposes (as the `memory_guide`
 * prompt and a short form in the server `instructions`), and that `openrecall
 * setup` installs as a skill for agents that support skills.
 *
 * The canonical text lives in skills/openrecall-memory/SKILL.md so there's ONE
 * source of truth shared by every agent. It is imported as text, so the
 * bundler inlines it and the guide works from any install layout (repo
 * checkout, npm/npx, or the single-file dist build).
 */

import skillMarkdown from '../../skills/openrecall-memory/SKILL.md' with { type: 'text' }

/** The SKILL.md file exactly as shipped, frontmatter included. */
export const SKILL_MARKDOWN: string = skillMarkdown

/** Directory name the skill installs under in an agent's skills dir. */
export const SKILL_NAME = 'openrecall-memory'

function stripFrontmatter(md: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(md)
  return m ? md.slice(m[0].length).trimStart() : md
}

/** The full memory-usage guide: the SKILL.md body without its frontmatter. */
export function loadMemoryGuide(): string {
  return stripFrontmatter(SKILL_MARKDOWN).trim()
}

/** One-paragraph version embedded in the MCP server `instructions`. */
export const SHORT_INSTRUCTIONS =
  'You have durable, end-to-end-encrypted memory via these tools. For a project task, ' +
  'call memory_projects to find its existing ID, then memory_project with a stable ' +
  'ID such as github.com/owner/repo. Recall from the returned shared and project ' +
  'namespaces together using memory_recall(namespaces: [...]). Save project facts ' +
  'in the project namespace and user preferences in the shared namespace; opening ' +
  'a project does not change tool defaults. At the start of any task, call memory_recall ' +
  'to retrieve what you already know about this ' +
  'user and project before asking them to repeat it. When you learn a stable ' +
  'fact (a preference, a project decision, a convention, or feedback on how to ' +
  'work), persist it with memory_save; skip transient context and never save ' +
  'secrets. Route by what the fact is: openrecall takes durable facts that must ' +
  "survive across machines, the host agent's local memdir keeps the session " +
  'log, and repo-shared facts belong in team memory. If a fact fits two, ask ' +
  'who needs it: you on every machine, this session only, or everyone on the ' +
  'repository. ' +
  'Every note has a type (user, feedback, project or reference) that the client stamps ' +
  'into its frontmatter along with id, created, updated, agent and session: user notes ' +
  'go in the shared namespace, project and reference notes in the open project namespace, ' +
  'feedback in either. ' +
  'Search before adding to avoid duplicates. Call the "memory_guide" ' +
  'prompt for the full protocol.'
