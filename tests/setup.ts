/**
 * Test preload. config.ts freezes its values the first time it's imported, and
 * bun shares the module cache across all test files in one process — so the env
 * must be set HERE, before any src module loads, or whichever test file imports
 * config first wins. Using `??=` lets an individual env override still apply.
 *
 * The byte/count caps are small on purpose so quota tests can trip them with
 * tiny payloads; they're well above anything the other suites push.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.STORE ??= 'fs'
process.env.DATA_DIR ??= mkdtempSync(join(tmpdir(), 'openrecall-test-'))
process.env.ALLOW_UNAUTHENTICATED ??= 'true'
// The node driver's pure half needs these present to construct; no node is
// contacted, and no test in the suite sets STORE=node.
process.env.GITLAWB_NODE_URL ??= 'http://node.invalid'
process.env.GITLAWB_NODE_STORE_SECRET ??= 'test-node-store-secret'
process.env.GITLAWB_NODE_IDENTITY_PATH ??= '/dev/null'
process.env.GITLAWB_NODE_ACKNOWLEDGE ??= 'true'
process.env.MAX_ENTRIES_PER_NAMESPACE ??= '5'
process.env.MAX_NAMESPACE_BYTES ??= '5000'
process.env.MAX_NAMESPACES_PER_OWNER ??= '3'
process.env.MAX_OWNER_BYTES ??= '4000'
