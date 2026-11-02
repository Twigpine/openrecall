# openrecall — Secured, Open-Source Agent Memory

> The memory layer of the agent stack. Open-source, self-hostable, **zero-knowledge**.
> Hosted by Twigpine at `memory.twigpine.com`; runnable by anyone, anywhere.

Status: **Planning** (2026-06-24)

---

## 1. Problem & opportunity

Agents forget everything between sessions. openclaude already ships a two-tier memory system:

- **Private memdir** (`src/memdir/`) — local `.md` files with frontmatter
  (`type: user|feedback|project|reference`), an `MEMORY.md` index, and relevance
  recall (`findRelevantMemories`). Local-only.
- **Team memory sync** (`src/services/teamMemorySync/`) — syncs a repo-scoped memdir
  to **Anthropic's server** (`/api/claude_code/team_memory`) with delta upload,
  per-key SHA-256 checksums, gitleaks secret scanning, and a debounced file watcher.

**The gap:** the only cloud backend is Anthropic's — closed, org-locked, and they can
read it. There is no self-hostable, provider-neutral, *private* memory backend that any
agent can use.

**openrecall** fills it: a backend we operate as a hosted service but that anyone can run
anywhere, where **memory is end-to-end encrypted so even the host cannot read it.**

## 2. Core principle: zero-knowledge (resolves the "public storage" risk)

The blocking concern: storing memory in public twigpine-node repos would expose it.

Resolution: **encrypt client-side before upload; store only ciphertext.** Then storage
location publicness is irrelevant — every backend just holds opaque blobs.

- Per-user master key derived from a passphrase (Argon2id) or generated and wrapped.
- Per-namespace data key; entries encrypted with AEAD (XChaCha20-Poly1305 / libsodium).
- Server sees: namespace id, entry key (path), ciphertext, content hash, timestamps.
  Server never sees: plaintext memory, the passphrase, or the data key.
- Metadata-minimization: entry "keys" (file paths) can themselves be hashed/encrypted
  so even memory *structure* isn't leaked (tier-2 option).
- Existing client-side gitleaks secret scan stays on as defense-in-depth.

Trade-off accepted: server-side relevance recall is impossible on ciphertext. Recall
stays **client-side** (decrypt locally, then run the existing `findRelevantMemories`).
A later optional "searchable tier" can do server-side encrypted search (see §7).

## 3. Architecture

```
agent (openclaude / Claude Code / Cursor / opencode / SDK)
   │
   ├─ Path A  native sync  → speaks /team_memory contract (openclaude, ~0 changes)
   ├─ Path B  MCP tools    → memory_save / recall / search / list (universal)
   └─ Path C  local daemon → mirrors ~/.claude memdir to cloud (tool-agnostic)
        │
        ▼   [ client-side E2E encrypt + secret scan ]
   openrecall server  (Bun on Fly — opengateway template)
        │   auth (X sign-in / API key)  •  rate limit  •  quota/billing
        ▼
   BlobStore (pluggable)               MetadataIndex (Postgres)
   ├─ hosted default: Tigris/S3 PRIVATE bucket    namespaces, entry keys,
   ├─ git-backed (opt-in): private signed repo    content hashes, versions,
   └─ self-host: fs / ipfs / your own S3          checksums, ACLs
```

Reuses: BlobStore trait (s3/fs/ipfs) from node work, Tigris cache-through, opengateway
deploy/auth/credits, the existing MCP plugin pattern.

## 4. Data & API model

Namespace = unit of sharing/scoping. Examples: `user:<id>` (private),
`repo:<owner>/<name>` (team), `agent:<id>`. Each namespace holds entries keyed by path
(`MEMORY.md`, `feedback/x.md`, ...), mirroring the memdir layout.

**Sync API (Path A — openclaude drop-in).** Mirror the existing contract so openclaude
works by changing a base URL:

- `GET  /api/memory/:namespace`            → full data + entryChecksums
- `GET  /api/memory/:namespace?view=hashes`→ metadata + per-key checksums only
- `PUT  /api/memory/:namespace`            → upsert entries (delta, upsert semantics)
- `404` = namespace empty. Structured `413` for too-many/too-large entries.

Bodies are ciphertext; server validates sizes/hashes without decrypting.

**MCP tools (Path B — universal).**
`memory_save`, `memory_recall(query)`, `memory_search`, `memory_list`, `memory_delete`.
Encryption/decryption happen in the MCP server process running locally (holds the key),
so the remote openrecall server still only sees ciphertext.

## 5. Security model details

- **Auth:** API key (header) + X sign-in for the web console (reuse opengateway auth).
- **Key custody:** key never sent to server. Options: (a) passphrase-derived,
  re-entered/cached locally; (b) generated key stored in OS keychain; (c) optional
  recovery via Shamir split or a sealed recovery blob the user stores themselves.
- **Tenant isolation:** every read/write authorized against namespace ACL; entry keys
  scoped under namespace prefix; path-traversal validation (port `validateTeamMemKey`).
- **Abuse limits:** per-namespace entry count + size caps (tunable), rate limits.
- **Self-host parity:** same server binary; hosted vs self-host differ only by config
  (BlobStore driver, DB URL, auth provider).

## 6. Build phases

**Phase 0 — Spec & scaffold (this doc + repo).**
- Create `Twigpine/openrecall` OSS repo (MIT, release-please + GHCR — match node).
- Lock crypto choices, API schema (Zod), namespace/ACL model.

**Phase 1 — Hosted MVP, openclaude drop-in (highest leverage).**
- openrecall server (Bun/Fly): auth, `/api/memory` sync contract, Postgres index,
  Tigris/S3 private BlobStore. Server is crypto-blind (stores ciphertext).
- openclaude client change: configurable team-memory base URL + a thin E2E-encrypt
  shim around the existing sync push/pull. Secret scan stays.
- Web console at `memory.twigpine.com`: sign in, see namespaces (encrypted entry list),
  manage API keys, quota. Cannot show plaintext (by design) unless key supplied locally.

**Phase 2 — Universal MCP server.**
- Ship as a `openrecall mcp` subcommand of the single `@twigpine/openrecall` package (NOT a
  separate `-mcp` package — matches the `gl mcp serve` pattern; the MCP server is a thin
  stdio wrapper over the already-bundled OpenRecallClient). Exposes memory_save / recall /
  search / list / delete; works in Claude Code, Cursor, opencode, SDK agents. Local key
  custody; remote stays ciphertext-only.
- MCP client config: `command: "bunx", args: ["-y", "@twigpine/openrecall", "mcp"]`.

**Phase 3 — Self-host + pluggable storage.**
- One-command self-host (Docker compose: server + Postgres + minio/fs).
- BlobStore adapters: fs, S3, IPFS, and **git-backed (private, encrypted)** — each
  memory edit becomes a signed commit for full audit/version history.

**Phase 4 — Local sync daemon (Path C).**
- Background watcher mirroring `~/.claude` memdir ↔ cloud for any tool that reads those
  files (port openclaude's debounced watcher + delta sync).

## 7. Later / optional

- **Searchable encrypted tier:** server-side recall over ciphertext via client-derived
  blind index / vector commitments (trades some privacy for server recall).
- **Memory sharing & forking:** share a namespace to another user (re-wrap data key to
  their pubkey); fork a public/anonymized memory set.
- **Billing:** free private tier (N namespaces / MB), paid for scale/team — reuse
  opengateway credits + Polar/x402.
- **Versioning UI:** diff/rollback memory over time (trivial if git-backed).

## 8. Open questions

- Key recovery UX for non-technical users without weakening zero-knowledge.
- Conflict resolution for concurrent multi-device writes (current team sync is
  server-wins per-key; may want CRDT/merge for memory).
- How much openclaude client change is acceptable upstream vs a fork/plugin.

## 9. Differentiators vs Anthropic team memory

1. **Zero-knowledge** — host cannot read your agent's memory.
2. **Open-source & self-hostable** — own your data, run it anywhere.
3. **Provider-neutral** — any agent via MCP, not just one vendor's CLI.
4. **Versioned/auditable** — optional git-backed signed history.
