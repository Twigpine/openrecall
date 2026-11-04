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
