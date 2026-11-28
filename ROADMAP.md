# OpenRecall roadmap

OpenRecall by Twigpine: one end-to-end-encrypted memory for every agent and
every session. This page tracks what has shipped, what blocks the first public
release, and what comes after. Open an issue or discussion to weigh in.

## Shipped on `main`

- **Crypto-blind server.** Delta sync and storage happen entirely over
  ciphertext, on a pluggable BlobStore (`fs`, `s3` for Tigris/R2/AWS).
- **Zero-knowledge client.** AES-256-GCM with a scrypt-derived key and a
  deterministic nonce for delta sync. A client-side secret scanner runs
  before encryption.
- **Multi-tenant hardening.** Strict per-owner namespace authorization,
  collision-resistant namespace slugs, per-namespace and per-account quotas,
  and per-owner rate limits.
- **MCP server.** `openrecall mcp` exposes `memory_save`, `memory_recall`,
  `memory_search`, `memory_get`, `memory_list` and `memory_delete`, plus the
  `memory_guide` prompt and server instructions.
- **Works for any agent.**
  - `openrecall init` creates one owner-only config file.
  - `openrecall setup` connects Claude Code, Zero, OpenClaude, Codex, Cursor,
    Gemini CLI, opencode, Windsurf, Claude Desktop and VS Code.
  - The `openrecall-memory` skill is installed where an agent loads skills.
  - A Claude Code / OpenClaude plugin is available.
  - See [docs/agents.md](./docs/agents.md).
- **Local mode.** Memory works with no server: ciphertext lives in
  `~/.openrecall/data`, shared safely by every agent on the machine through a
  cross-process lock.
- **Runs without Bun.** The CLI and MCP server ship as a single Node bundle,
  so `npx -y @twigpine/openrecall mcp` works anywhere Node 24+ does. Only
  `openrecall serve` needs Bun.

## First public release (v0.2)

- [ ] Publish `@twigpine/openrecall` to npm and the server image to GHCR
      (release-please; npm through trusted publishing, so no token).
- [ ] Hosted beta at `memory.twigpine.com`:
  - [ ] Twigpine Supabase project with `migrations/0001_init.sql` applied.
  - [ ] Fly app `openrecall` with `STORE=s3` and its secrets set.
  - [ ] TLS certificate and DNS record.
- [ ] Production smoke test: a real API key does an MCP save and recall
      round-trip, and the objects in Tigris are confirmed to be ciphertext.
- [ ] Self-service console: sign in, issue an API key, and copy a ready
      `openrecall init --url … --api-key …` line.
- [ ] GitHub housekeeping: create the `Twigpine/maintainers` team, enable
      Discussions and private vulnerability reporting.

## Agent integrations

Every MCP client works today. These items deepen specific integrations.

- **Zero.** These changes belong in Twigpine/zero:
  - Pass MCP server `instructions` to the model. Today the skill carries the
    guidance instead.
  - Let users trust a server's tools, so memory is usable in Auto mode.
  - Make the MCP connect timeout configurable (currently 8 s).
  - Allow per-server sandbox network grants, so a remote store works without
    opening the network to every command.
- **OpenClaude native memory backend.** OpenClaude's built-in team-memory sync
  only works with Anthropic OAuth and a github.com remote, and it uploads
  plaintext. A native OpenRecall backend would encrypt in-process and sync the
  memory directory to OpenRecall. This is the deepest integration for our own
  agent, and it belongs in Twigpine/openclaude.
- **Memory-directory sync.** A background watcher that mirrors Claude Code and
  OpenClaude memory directories to and from OpenRecall, for agents that read
  memory files rather than MCP tools.

## Scale

The server guards each namespace's manifest read-modify-write with an
**in-process** lock (`src/lock.ts`). Per-owner quotas and rate limits are also
in memory. That is correct for one server process and wrong for several, so
the hosted beta runs exactly one machine (`min_machines_running = 1`).

- **Do not run multiple server instances against shared storage** until the
  Postgres metadata index lands. Doing so can corrupt manifests.
- The next step is moving manifests and versions into Postgres with row-level
  version checks. That enables horizontal scale and high availability.
- Local mode is unaffected. It serializes writes across processes with a
  lock file on disk (`<data>/.lock`, created with `O_EXCL`) and locks writes
  only: reads take no lock and re-read the manifest when a blob has moved
  under them.
- Latency targets for the memory tools, and how to measure them, are in
  [docs/performance.md](docs/performance.md); `openrecall status --timings`
  prints the per-stage breakdown.

## Later

- OS-keychain passphrase custody and an optional recovery blob.
- A git-backed, signed BlobStore on the Twigpine Network, for audit history
  and a versioning UI.
- Namespace sharing and forking, by re-wrapping keys to another user's public
  key.
- A searchable-encrypted tier.
- Paid tiers above the free quota, billed through OpenGateway credits.
- A crypto upgrade to XChaCha20-Poly1305 and Argon2id. Every blob carries a
  version byte for this.

## Open questions

- How to recover keys for non-technical users without weakening
  zero-knowledge.
- How to resolve conflicts between concurrent writes from several devices.
  Today the last write per key wins; memory may want a merge strategy.
