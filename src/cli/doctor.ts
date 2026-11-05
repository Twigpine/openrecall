/**
 * `openrecall doctor [namespace]`: the audit `memory_doctor` gives an agent,
 * printed for a person.
 *
 * Settings resolve the way every other command's do (env over config file),
 * the client and the memory tools are built the way the MCP server builds
 * them, and the doctor tool runs over the configured namespace or the one
 * given. The report goes to stdout as the tool renders it: the meters line,
 * then one section per finding kind with the tool call that fixes each item.
 * Keys and descriptions appear in it, as the report needs them to; note
 * bodies do not.
 *
 * It proposes and never writes. The one write the tool can trigger is the
 * flush of pending access stamps, and a process that has recalled nothing has
 * none. The run is recorded in `<home>/state/doctor.json` like an agent's, so
 * the next MCP start does not repeat an audit somebody just read.
 */

import { join } from 'node:path'
import { makeSession } from '../mcp/session.ts'
import { makeTools } from '../mcp/tools.ts'
import { validateNamespace } from '../namespace.ts'
import { makeClient } from './client.ts'
import { resolveSettings } from './settings.ts'

/** Print the report; 0 on success, 1 when the namespace could not be read. */
export async function cmdDoctor(namespace?: string): Promise<number> {
  const s = resolveSettings()
  const ns = namespace ? validateNamespace(namespace) : s.namespace
  const client = await makeClient(s)
  const tools = makeTools(client, s.namespace, makeSession({ env: process.env }), {
    doctorMarkerPath: join(s.home, 'state', 'doctor.json'),
    warn: line => console.error(`warning: ${line}`),
  })
  const r = await tools.doctor(ns)
  if (r.isError) {
    console.error(`error: ${r.text}`)
    return 1
  }
  console.log(r.text)
  return 0
}
