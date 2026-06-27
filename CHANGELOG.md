# Changelog

All notable changes to this project are documented here. This file is maintained
automatically by [release-please](https://github.com/googleapis/release-please)
from [Conventional Commits](https://www.conventionalcommits.org/) — edit commit
messages, not this file.

## [0.1.1](https://github.com/Gitlawb/memlawb/compare/v0.1.0...v0.1.1) (2026-06-27)


### Bug Fixes

* **namespace:** hash namespace into slug to stop cross-tenant collisions ([0c9f82d](https://github.com/Gitlawb/memlawb/commit/0c9f82d022dace631bd8582ca3508adfab6809a8))
* **namespace:** hash namespace into slug to stop cross-tenant collisions ([07d2a96](https://github.com/Gitlawb/memlawb/commit/07d2a96f575f4993972710eaaca0409e324bd255))
* **review:** correct injective→collision-resistant wording; pin slug algorithm and hex format in tests ([29f0376](https://github.com/Gitlawb/memlawb/commit/29f0376d544decde27971f84d250fffb1a5d4396))

## 0.1.0 (2026-06-25)

Initial release — open-source, self-hostable, zero-knowledge agent memory.

### Features

- **Crypto-blind sync server** — `GET`/`PUT`/`DELETE /api/memory/:namespace`
  with delta upsert, a hashes-only view, per-namespace manifests, and a
  pluggable BlobStore (`fs`, `s3`/Tigris/R2/AWS). The server only ever stores
  ciphertext.
- **Zero-knowledge client** — `MemlawbClient` and `memlawb` CLI (`push`/`pull`):
  AES-256-GCM with a scrypt-derived key and a deterministic nonce that enables
  delta sync without the server seeing plaintext.
- **MCP server** — `memlawb mcp` exposes `memory_save`, `memory_recall`,
  `memory_search`, `memory_list`, and `memory_delete` to any MCP-capable agent,
  with local relevance ranking and a `memory_guide` prompt.
- **memlawb-memory skill** — canonical recall-first / save-durable guidance for
  agents, shared by Claude Code and the MCP `memory_guide` prompt.
- **Secret scanner** — client-side, pre-encryption scan that blocks uploads of
  live-looking credentials (`MEMLAWB_SCAN=block|warn|off`).
- **Multi-tenant hardening** — strict per-owner namespace authorization,
  per-namespace and per-account quotas, and per-owner rate limiting.
- **Self-host & deploy** — Docker image and Fly config; one binary for both
  hosted and self-hosted, differing only by configuration.
