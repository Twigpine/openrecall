/**
 * Re-path and re-wrap a node-stored namespace under a new store secret.
 *
 * The store secret derives every node-visible name (the repo, the in-repo entry
 * leaves) and the key that wraps the manifest and usage records at rest. It
 * therefore cannot be rotated in place: a new secret means a different repo
 * holding differently-named objects under a different wrapping key. This is the
 * procedure that makes it rotatable at all, and it exists so that the answer to
 * a suspected disclosure is a runbook rather than an outage.
 *
 * What it does NOT do, deliberately: re-encrypt entry blobs. Those are
 * encrypted by the client under the user's passphrase, which this process never
 * has. They are copied byte for byte. If this script ever rewrites an entry
 * blob's bytes, that is a bug, and the verification pass below fails on it.
 *
 * Secrets are read from named environment variables, never from argv, because
 * argv is readable by any process on the box (`ps`) and this is the value that
 * names and unwraps every tenant's storage.
 *
 * The namespaces to migrate are supplied by the caller. They cannot be
 * enumerated from the node: repo names are keyed hashes of the namespace, which
 * is the property that keeps the node from learning them, so the operator
 * supplies the list from their own records.
 *
 * Run:
 *   OLD=... NEW=... bun run scripts/node-store-migrate.ts \
 *     --from-secret-env OLD --to-secret-env NEW \
 *     --namespace user:alice --namespace user:bob [--owner <ownerHash>] [--commit]
 *
 * Without --commit it reports what it would move and writes nothing.
 */

import { config } from '../src/config.ts'
import { namespaceSlug } from '../src/namespace.ts'
import { blobPrefix, entryPath, manifestPath } from '../src/store/blobstore.ts'
import { NodeBlobStore } from '../src/store/node.ts'

type Args = {
  fromEnv: string
  toEnv: string
  namespaces: string[]
  owners: string[]
  commit: boolean
}

function parse(argv: string[]): Args {
  const a: Args = { fromEnv: '', toEnv: '', namespaces: [], owners: [], commit: false }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1] ?? ''
    switch (argv[i]) {
      case '--from-secret-env':
        a.fromEnv = v
        i++
        break
      case '--to-secret-env':
        a.toEnv = v
        i++
        break
      case '--namespace':
        a.namespaces.push(v)
        i++
        break
      case '--owner':
        a.owners.push(v)
        i++
        break
      case '--commit':
        a.commit = true
        break
      default:
        throw new Error(`unknown argument: ${argv[i]}`)
    }
  }
  return a
}

function secretFrom(name: string): string {
  if (!name) throw new Error('both --from-secret-env and --to-secret-env are required')
  const v = (process.env[name] ?? '').trim()
  // Naming an empty variable is the dangerous case: it would derive a valid but
  // wrong namespace rather than fail, and the migration would "succeed" into a
  // location nothing can find again.
  if (!v) throw new Error(`environment variable ${name} is empty or unset`)
  return v
}

function store(secret: string): NodeBlobStore {
  return new NodeBlobStore({
    secret,
    identityPath: config.node.identityPath,
    url: config.node.url,
    // The operator is mid-migration on a store they already run; the gate is
    // about enabling node storage, and refusing here would block the recovery
    // procedure it exists to make possible.
    acknowledged: true,
  })
}

const args = parse(process.argv.slice(2))
if (args.namespaces.length === 0 && args.owners.length === 0) {
  throw new Error('nothing to do: pass at least one --namespace or --owner')
}
const from = secretFrom(args.fromEnv)
const to = secretFrom(args.toEnv)
if (from === to) throw new Error('the two secrets are identical; this would be a no-op')

const old = store(from)
const next = store(to)

/**
 * What to copy, per namespace. Not a single `ns/<slug>/` sweep: the driver
 * resolves a prefix to a repo by mapping it, and only the leaf directories are
 * mappable. `entries/` is the legacy layout, listed because a namespace written
 * before the blobs layout still has objects there and a migration that silently
 * skipped them would lose data while reporting success.
 */
const prefixes = [
  ...args.namespaces.flatMap(ns => {
    const slug = namespaceSlug(ns)
    return [blobPrefix(slug), entryPath(slug, '')]
  }),
]

/**
 * Objects that are single paths rather than a listable prefix: each manifest,
 * and each owner's usage record. An owner's directory cannot be listed, because
 * only usage.json under owners/<hash>/ is mappable to a repo.
 */
const singles = [
  ...args.namespaces.map(ns => manifestPath(namespaceSlug(ns))),
  ...args.owners.map(o => `owners/${o}/usage.json`),
]

let moved = 0
let bytes = 0
const failures: string[] = []

async function move(path: string): Promise<void> {
  const body = await old.get(path)
  if (!body) {
    // Listed but unreadable is drift worth stopping on, not skipping past.
    failures.push(`${path}: listed by the old store but read back empty`)
    return
  }
  if (!args.commit) {
    console.log(`  would move ${path} (${body.length} bytes)`)
    return
  }
  await next.put(path, body)
  // Verify by reading back through the new secret, not by trusting the put.
  const check = await next.get(path)
  if (!check || Buffer.compare(Buffer.from(check), Buffer.from(body)) !== 0) {
    failures.push(`${path}: did not read back identical under the new secret`)
    return
  }
  moved++
  bytes += body.length
  console.log(`  moved ${path} (${body.length} bytes, byte-identical)`)
}

/** One object failing is recorded and the run continues to the summary. */
async function tryMove(path: string): Promise<void> {
  try {
    await move(path)
  } catch (err) {
    failures.push(`${path}: ${(err as Error).message}`)
  }
}

// Blobs first, manifests last: a manifest names its blobs, so a run that stops
// partway leaves unreferenced blobs, never a manifest pointing at nothing.
for (const prefix of prefixes) {
  const paths = await old.list(prefix)
  console.log(`\n${prefix}  (${paths.length} object${paths.length === 1 ? '' : 's'})`)
  for (const path of paths) await tryMove(path)
}

for (const path of singles) {
  console.log(`\n${path}`)
  await tryMove(path)
}

console.log(
  args.commit
    ? `\nmoved ${moved} object(s), ${bytes} bytes, every one byte-identical after the move`
    : '\ndry run: nothing was written. Re-run with --commit to move.',
)
if (failures.length > 0) {
  console.log(`\n${failures.length} FAILURE(S):`)
  for (const f of failures) console.log(`  ${f}`)
  process.exit(1)
}
console.log(
  args.commit
    ? '\nThe old repos still exist and still hold the old ciphertext. Retiring them is a\n' +
        'separate, deliberate step: verify reads under the new secret first.'
    : '',
)
