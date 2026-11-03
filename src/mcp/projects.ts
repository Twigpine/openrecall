/**
 * Discoverable project scopes, stored through the encrypted client. A project
 * ID is supplied by the agent rather than inferred from an MCP process's cwd,
 * which GUI clients often start outside the user's working project.
 */

import { sha256Hex } from '../hash.ts'
import { validateNamespace } from '../namespace.ts'
import type { MemoryClient, ToolResult } from './tools.ts'

export function projectId(value: string): string {
  const id = value
    .trim()
    .toLowerCase()
    .replace(/\/$/, '')
    .replace(/\.git$/, '')
  if (
    !/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(id) ||
    id.includes('..') ||
    id.includes('//') ||
    id.endsWith('/')
  )
    throw new Error(
      'use a stable project ID such as github.com/owner/repo; ' +
        'IDs are case-insensitive and must not contain credentials or local paths',
    )
  return id
}

export function projectNamespace(sharedNamespace: string, id: string): string {
  return validateNamespace(
    `${validateNamespace(sharedNamespace)}/projects/${sha256Hex(projectId(id))}`,
  )
}

export function makeProjects(client: MemoryClient, sharedNamespace: string) {
  const catalog = () => validateNamespace(`${validateNamespace(sharedNamespace)}/projects`)

  return {
    async open(project: string): Promise<ToolResult> {
      try {
        const id = projectId(project)
        const namespace = projectNamespace(sharedNamespace, id)
        // One entry per project, so independent registrations cannot overwrite
        // a shared catalog file. Identical registrations are unchanged writes.
        await client.push(catalog(), {
          [`${sha256Hex(id)}.json`]: JSON.stringify({ version: 1, id, namespace }),
        })
        return {
          text:
            `Project: ${id}\nProject namespace: ${namespace}\nShared namespace: ${sharedNamespace}\n\n` +
            'Save project decisions and references in the project namespace. Save standing ' +
            'user preferences and general feedback in the shared namespace. For recall, pass ' +
            'both as namespaces; for save/get/list/delete, pass the intended namespace explicitly. ' +
            'Opening a project does not change any tool defaults or move existing memories.',
        }
      } catch (err) {
        return { text: `project failed: ${(err as Error).message}`, isError: true }
      }
    },

    async list(limit = 20, offset = 0): Promise<ToolResult> {
      try {
        if (!Number.isInteger(limit) || limit < 1 || limit > 50)
          throw new Error('limit must be an integer between 1 and 50')
        if (!Number.isInteger(offset) || offset < 0)
          throw new Error('offset must be a non-negative integer')
        const { entries } = await client.pull(catalog())
        const projects: { id: string; namespace: string }[] = []
        let invalid = 0
        for (const [key, content] of Object.entries(entries)) {
          try {
            const record: unknown = JSON.parse(content)
            if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error()
            const { version, id, namespace } = record as Record<string, unknown>
            if (
              version !== 1 ||
              typeof id !== 'string' ||
              id !== projectId(id) ||
              key !== `${sha256Hex(id)}.json` ||
              namespace !== projectNamespace(sharedNamespace, id)
            )
              throw new Error()
            projects.push({ id, namespace })
          } catch {
            invalid++
          }
        }
        projects.sort((a, b) => a.id.localeCompare(b.id))
        const page = projects.slice(offset, offset + limit)
        const body = page.map(p => `- ${p.id}: ${p.namespace}`).join('\n')
        return {
          text:
            `Shared namespace: ${sharedNamespace}\n${projects.length} registered project(s).` +
            (projects.length
              ? ` Showing ${page.length} from offset ${offset}.\n${body}`
              : ' Call memory_project with a stable project ID to register one.') +
            (offset + page.length < projects.length
              ? `\nMore projects: call memory_projects with offset ${offset + page.length}.`
              : '') +
            (invalid ? `\n${invalid} invalid catalog entry/entries skipped in ${catalog()}.` : ''),
        }
      } catch (err) {
        return { text: `projects failed: ${(err as Error).message}`, isError: true }
      }
    },
  }
}
