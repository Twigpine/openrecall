# Contributing to OpenRecall

Thanks for your interest in improving OpenRecall — open-source, self-hostable,
zero-knowledge agent memory. This guide gets you from clone to merged PR.

By participating you agree to our [Code of Conduct](./CODE_OF_CONDUCT.md).

## TL;DR

```bash
bun install
bun test            # 50 tests
bun run type-check  # tsc --noEmit
bun run check       # biome: format + lint
```

Green on all three is the bar for every PR.

## Prerequisites

- [Bun](https://bun.sh) `>= 1.2` — the runtime, test runner, and package manager.
  TypeScript runs directly in development; `bun run build` bundles the CLI +
  MCP server into `dist/openrecall.js` (plain Node 24+) for npm.
- Node `>= 20` to exercise the bundle (`node dist/openrecall.js …`).

## Project layout

```
src/            crypto-blind HTTP server (never sees plaintext)
  handler.ts      request routing + the sync contract
  memory.ts       manifest + delta upsert (write path)
  quota.ts        per-owner quota accounting
  ratelimit.ts    per-owner token bucket
  auth.ts         API-key → owner; namespace authorization
  store/          BlobStore: fs | s3 (Tigris/R2/AWS)
  mcp/            the `openrecall mcp` server (tools, relevance, guide)
  cli/            client settings, local mode (in-process store + lock), `setup`
client/         the zero-knowledge client (encrypt → ciphertext)
  crypto.ts       AES-256-GCM + scrypt; deterministic nonce for delta sync
  secretscan.ts   pre-encryption secret scanner
  index.ts        OpenRecallClient (push/pull/delta)
bin/            the CLI (openrecall.ts): init | setup | status | push | pull | mcp | serve
scripts/        build.ts — the single-file Node bundle
skills/         the openrecall-memory agent skill (canonical guidance)
.claude-plugin/ Claude Code / OpenClaude plugin + marketplace manifests
docs/           user docs (agents.md)
migrations/     hosted Supabase schema
tests/          bun:test suites
```

## Running it locally

```bash
# Use a throwaway home so you never touch your real ~/.openrecall
export OPENRECALL_HOME=$(mktemp -d)

# Local mode: no server, encrypted store under $OPENRECALL_HOME/data
bun run bin/openrecall.ts init
bun run bin/openrecall.ts push ./my-memories
bun run bin/openrecall.ts setup all          # dry run — prints what it would change

# Against a server (filesystem storage, single-user open mode, localhost only)
ALLOW_UNAUTHENTICATED=true STORE=fs DATA_DIR=./data bun run src/index.ts
OPENRECALL_URL=http://localhost:8080 bun run bin/openrecall.ts status

# The published artifact: build, then run under plain Node
bun run build && node dist/openrecall.js mcp
```

## Design principles (please preserve these)

1. **The server is crypto-blind.** It must never be able to read memory
   plaintext. Anything that would send plaintext, a passphrase, or a derived key
   to the server is a non-starter. Encryption lives in `client/`.
2. **Zero-dependency core.** `src/` (server) and `client/` use only `node:`
   built-ins. The only third-party deps are for the MCP server
   (`@modelcontextprotocol/sdk`, `zod`) and stay isolated to `src/mcp/`. Don't
   add dependencies to the server or client without discussion.
3. **Validate everything off the wire.** Namespaces and entry keys are
   attacker-controlled; keep them going through `namespace.ts` validators.
4. **Self-host parity.** Hosted and self-host run the same binary, differing only
   by config. Don't fork behavior on "are we hosted".

## Security-sensitive changes

Changes to `client/crypto.ts`, `src/auth.ts`, `src/quota.ts`, namespace
validation, or the secret scanner get extra scrutiny. Include tests that prove
the security property (e.g. tenant isolation, ciphertext-at-rest). If you think
you've found a vulnerability, **do not open a public issue** — see
[SECURITY.md](./SECURITY.md).

## Tests

- Write tests with `bun:test`. Every behavior change needs a test.
- Cross-cutting test env (storage dir, limits) is set in `tests/setup.ts`
  (a bun preload) because `config.ts` freezes at first import.
- The bar: `bun test`, `bun run type-check`, and `bun run check` all pass.

## Commits & pull requests

We use **[Conventional Commits](https://www.conventionalcommits.org/)** — they
drive automated releases and the changelog via release-please. Format:

```
<type>(<optional scope>): <summary>

feat(mcp): add memory_search tool
fix(quota): reject over-quota writes atomically
docs: clarify zero-knowledge recovery caveat
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`.
A `feat` bumps the minor version, `fix` the patch; `feat!` or a
`BREAKING CHANGE:` footer bumps major.

**PR checklist:**

- [ ] `bun test`, `bun run type-check`, and `bun run check` pass.
- [ ] New behavior is covered by tests.
- [ ] Conventional Commit title.
- [ ] Docs/README updated if behavior changed.
- [ ] Commits are signed off (DCO, below).

## Developer Certificate of Origin (DCO)

We use the [DCO](https://developercertificate.org/) — a lightweight affirmation
that you wrote the patch or have the right to submit it. Add a sign-off to each
commit:

```bash
git commit -s -m "fix(auth): tighten namespace match"
```

This appends `Signed-off-by: Your Name <you@example.com>` using your git
identity. No CLA.

## License

By contributing, you agree your contributions are licensed under the
[MIT License](./LICENSE), matching the project license.
