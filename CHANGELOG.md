# Changelog

All notable changes to this project are documented here. This file is maintained
automatically by [release-please](https://github.com/googleapis/release-please)
from [Conventional Commits](https://www.conventionalcommits.org/) — edit commit
messages, not this file.

## [0.3.0](https://github.com/Twigpine/openrecall/compare/v0.2.1...v0.3.0) (2026-11-06)


### ⚠ BREAKING CHANGES

* `GET /health` no longer returns `store`, and a namespace whose manifest cannot be parsed now answers 503 `manifest_unreadable` where it previously served an empty view. Without this footer release-please would cut a patch for a changed contract, because `bump-patch-for-minor-pre-major` is set.

### Features

* passphrase file, --version and standalone binaries ([#9](https://github.com/Twigpine/openrecall/issues/9)) ([b4d4e07](https://github.com/Twigpine/openrecall/commit/b4d4e077e4754d352e3132a0ded225fd961de0cf))


### Bug Fixes

* **ci:** resolve code scanning alerts ([#25](https://github.com/Twigpine/openrecall/issues/25)) ([b2ab6b5](https://github.com/Twigpine/openrecall/commit/b2ab6b535944ba4c11179ac3c8c2133fde3d65b7))
* **cli:** never print the service key in the setup card ([#31](https://github.com/Twigpine/openrecall/issues/31)) ([ebac262](https://github.com/Twigpine/openrecall/commit/ebac26246607894183dd0cb717cdb40ae58bc9a8))
* **mcp:** expose MCP server startup and tool-failure status ([#15](https://github.com/Twigpine/openrecall/issues/15)) ([d599a6a](https://github.com/Twigpine/openrecall/commit/d599a6a10e064f32bd5698d059c3ef69796420a8))
* report refused pushes and honest delete results ([#13](https://github.com/Twigpine/openrecall/issues/13)) ([d3322fb](https://github.com/Twigpine/openrecall/commit/d3322fba123e9bf0a9fc298376b0c96a20c9fdd8))
* **server:** answer bad requests with 4xx and bad config with a startup error ([#14](https://github.com/Twigpine/openrecall/issues/14)) ([4a0233e](https://github.com/Twigpine/openrecall/commit/4a0233e0ce01fd759c121ab1f43a66c7bdd6e341))
* **tests:** isolate preflight from the real config and always test a … ([#35](https://github.com/Twigpine/openrecall/issues/35)) ([335e1aa](https://github.com/Twigpine/openrecall/commit/335e1aa7462d63439c2f9103ddab13faad47f151))
* **tests:** prevent backtracking in frontmatter regex extraction ([#26](https://github.com/Twigpine/openrecall/issues/26)) ([c0d0d64](https://github.com/Twigpine/openrecall/commit/c0d0d64f6b80ec7231b978ccc74ec7f8cb827200))

## [0.2.1](https://github.com/Twigpine/openrecall/compare/v0.2.0...v0.2.1) (2026-11-03)


### Features

* **mcp:** organize shared and project memory and refresh branding ([#22](https://github.com/Twigpine/openrecall/issues/22)) ([ea900fa](https://github.com/Twigpine/openrecall/commit/ea900faf3e78e6cef4be3c672f241c96cd5f1118))


### Bug Fixes

* **cli:** launch the installed Bun runtime for serve ([#21](https://github.com/Twigpine/openrecall/issues/21)) ([9c741e1](https://github.com/Twigpine/openrecall/commit/9c741e1f9a8e7c0a8183d20d0467d534ff8f8745))

## [0.2.0](https://github.com/Twigpine/openrecall/compare/v0.1.0...v0.2.0) (2026-11-03)


### ⚠ BREAKING CHANGES

* **package:** the package requires Node >= 24.22.1 (was >= 20).
* **server:** `GET /health` no longer returns `store`, and a namespace whose manifest cannot be parsed now answers 503 `manifest_unreadable` where it previously served an empty view. Without this footer release-please would cut a patch for a changed contract, because `bump-patch-for-minor-pre-major` is set.
* **client:** PullResult gains a required `updatedAt` field. The type is exported from the package entry point, so external code that constructs or mocks a PullResult literal will not compile until it carries the field. It is required rather than optional on purpose, so the compiler finds every stand-in instead of letting one silently diverge from the real client. Values are typed `string | undefined` because a key can legitimately be absent and this project does not enable noUncheckedIndexedAccess.
* every public identifier is renamed. Nothing was published or deployed under the old names, so there is no migration path.
    - package @gitlawb/memlawb -> @twigpine/openrecall; bin memlawb -> openrecall
    - MemlawbClient / MemlawbClientOptions -> OpenRecallClient / OpenRecallClientOptions
    - env MEMLAWB_* -> OPENRECALL_* (URL, API_KEY, PASSPHRASE, NAMESPACE, SCAN,
      SUPABASE_URL, SUPABASE_SECRET_KEY)
    - key-derivation salt "memlawb:" -> "openrecall:" (data encrypted under the old
      salt cannot be decrypted)
    - Supabase table memlawb_api_keys -> openrecall_api_keys
    - skill memlawb-memory -> openrecall-memory; Fly app memlawb -> openrecall

### Features

* **client:** surface per-entry updatedAt from the manifest ([#5](https://github.com/Twigpine/openrecall/issues/5)) ([eeb9032](https://github.com/Twigpine/openrecall/commit/eeb90323ebf135ceeee321620ca476ff6a2e82cb))
* rebrand as OpenRecall by Twigpine and connect any agent ([#11](https://github.com/Twigpine/openrecall/issues/11)) ([d4b0e8f](https://github.com/Twigpine/openrecall/commit/d4b0e8f93f8175e3418bde22408fda2636520fb9))
* **recall:** rework ranking, bound recall output, add memory_get ([#4](https://github.com/Twigpine/openrecall/issues/4)) ([19af9e4](https://github.com/Twigpine/openrecall/commit/19af9e42ea5b5acc225274561ff2e2204cdac1e4))
* **server:** crash-safe storage, write preconditions, and honest deletion ([#7](https://github.com/Twigpine/openrecall/issues/7)) ([211025a](https://github.com/Twigpine/openrecall/commit/211025adff74c4b119bfe2cb23f583087a802ca4))


### Bug Fixes

* **lock:** compare the tail check against the stored chained promise ([#6](https://github.com/Twigpine/openrecall/issues/6)) ([4bdf494](https://github.com/Twigpine/openrecall/commit/4bdf494fe3ffab1c955c856c47b58ee1ef19e86a))
* **namespace:** hash namespace into slug to stop cross-tenant collisions ([0c9f82d](https://github.com/Twigpine/openrecall/commit/0c9f82d022dace631bd8582ca3508adfab6809a8))
* **namespace:** hash namespace into slug to stop cross-tenant collisions ([07d2a96](https://github.com/Twigpine/openrecall/commit/07d2a96f575f4993972710eaaca0409e324bd255))
* **package:** ship the client as ESM with declarations so Node can import it ([#17](https://github.com/Twigpine/openrecall/issues/17)) ([457ed36](https://github.com/Twigpine/openrecall/commit/457ed36fa7580fd2d6478d206d2da2368a4ff7cf))
* **review:** correct injective→collision-resistant wording; pin slug algorithm and hex format in tests ([29f0376](https://github.com/Twigpine/openrecall/commit/29f0376d544decde27971f84d250fffb1a5d4396))


### Miscellaneous Chores

* **package:** require Node 24.22.1, matching OpenClaude ([#16](https://github.com/Twigpine/openrecall/issues/16)) ([fa0f5bb](https://github.com/Twigpine/openrecall/commit/fa0f5bb544119cc5544bac4d4337d842dfa5e33b))

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
