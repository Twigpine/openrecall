/**
 * The package version, for `openrecall --version`.
 *
 * Consumers pin a minimum (zero's enable notice tells an operator to run
 * `openrecall --version`), so this has to work in every shipped form: source
 * under Bun, the Node bundle, and the compiled binaries. Importing the
 * manifest lets the bundler inline the value, so no file is read at runtime
 * and a release bump carries it.
 */

import pkg from '../package.json' with { type: 'json' }

export function version(): string {
  return pkg.version
}

/**
 * The lowest Node this package runs on, from `engines.node` (">=24.22.1" →
 * "24.22.1"). `setup` pins whichever Node ran it; below this floor the pinned
 * command would fail at the agent's first start, so it warns instead.
 */
export function nodeFloor(): string {
  return pkg.engines.node.replace(/^[^\d]*/, '')
}
