# Contributing to openrecall

Thanks for your interest in improving openrecall — open-source, self-hostable,
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

- [Bun](https://bun.sh) `>= 1.1` — the runtime, test runner, and package manager.
  No Node build step; TypeScript runs directly.

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
client/         the zero-knowledge client (encrypt → ciphertext)
  crypto.ts       AES-256-GCM + scrypt; deterministic nonce for delta sync
  secretscan.ts   pre-encryption secret scanner
  index.ts        OpenRecallClient (push/pull/delta)
bin/            the CLI (openrecall.ts): push | pull | mcp | serve
skills/         the openrecall-memory agent skill (canonical guidance)
migrations/     hosted Supabase schema
tests/          bun:test suites
```

## Running it locally

```bash
# Server (filesystem storage, single-user open mode)
ALLOW_UNAUTHENTICATED=true STORE=fs DATA_DIR=./data bun run src/index.ts

# In another shell: round-trip some memory, end-to-end encrypted
OPENRECALL_URL=http://localhost:8080 OPENRECALL_PASSPHRASE=dev \
  bun run bin/openrecall.ts push ./my-memories user:me

# Or run the MCP server (stdio)
OPENRECALL_URL=http://localhost:8080 OPENRECALL_PASSPHRASE=dev \
  bun run bin/openrecall.ts mcp
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
