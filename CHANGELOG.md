# Changelog

All notable changes to this project are documented here. This file is maintained
automatically by [release-please](https://github.com/googleapis/release-please)
from [Conventional Commits](https://www.conventionalcommits.org/) — edit commit
messages, not this file.

## 0.1.0 (2026-06-25)

Initial release — open-source, self-hostable, zero-knowledge agent memory.

### Features

- **Crypto-blind sync server** — `GET`/`PUT`/`DELETE /api/memory/:namespace`
  with delta upsert, a hashes-only view, per-namespace manifests, and a
  pluggable BlobStore (`fs`, `s3`/Tigris/R2/AWS). The server only ever stores
  ciphertext.
- **Zero-knowledge client** — `OpenRecallClient` and `openrecall` CLI (`push`/`pull`):
  AES-256-GCM with a scrypt-derived key and a deterministic nonce that enables
  delta sync without the server seeing plaintext.
- **MCP server** — `openrecall mcp` exposes `memory_save`, `memory_recall`,
  `memory_search`, `memory_list`, and `memory_delete` to any MCP-capable agent,
  with local relevance ranking and a `memory_guide` prompt.
- **openrecall-memory skill** — canonical recall-first / save-durable guidance for
  agents, shared by Claude Code and the MCP `memory_guide` prompt.
- **Secret scanner** — client-side, pre-encryption scan that blocks uploads of
  live-looking credentials (`OPENRECALL_SCAN=block|warn|off`).
- **Multi-tenant hardening** — strict per-owner namespace authorization,
  per-namespace and per-account quotas, and per-owner rate limiting.
- **Self-host & deploy** — Docker image and Fly config; one binary for both
  hosted and self-hosted, differing only by configuration.
