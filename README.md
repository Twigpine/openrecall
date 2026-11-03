```text
    ___    ___   ___   _  _   ___   ___    ___     _     _      _
   / _ \  | _ \ | __| | \| | | _ \ | __|  / __|   /_\   | |    | |
  | (_) | |  _/ | _|  | .` | |   / | _|  | (__   / _ \  | |__  | |__
   \___/  |_|   |___| |_|\_| |_|_\ |___|  \___| /_/ \_\ |____| |____|

             one memory for every agent and every session
             open source · self-hostable · zero-knowledge
```

OpenRecall is the memory layer of the agent stack. Claude Code, Zero,
OpenClaude, Codex, Cursor, and your own SDK agents read and write the same
durable memory, carried across sessions and stored where no one but you can
read it: entries are encrypted on your machine, and whatever holds them, a
local directory or a server, only ever sees ciphertext.

[![CI](https://github.com/Twigpine/openrecall/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Twigpine/openrecall/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/tag/Twigpine/openrecall?label=release&color=0ea5e9)](https://github.com/Twigpine/openrecall/tags)
[![npm](https://img.shields.io/npm/v/@twigpine/openrecall?color=cb3837)](https://www.npmjs.com/package/@twigpine/openrecall)
[![npm downloads](https://img.shields.io/npm/dm/@twigpine/openrecall)](https://www.npmjs.com/package/@twigpine/openrecall)
[![Discussions](https://img.shields.io/badge/discussions-open-7c3aed)](https://github.com/Twigpine/openrecall/discussions)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/k68zFR6AcB)
[![X](https://img.shields.io/badge/X-@twigpine-000000?logo=x&logoColor=white)](https://x.com/twigpine)
[![Security Policy](https://img.shields.io/badge/security-policy-0f766e)](SECURITY.md)
[![License](https://img.shields.io/badge/license-MIT-2563eb)](LICENSE)

OpenRecall is by [Twigpine](https://twigpine.com), next to
[Zero](https://github.com/Twigpine/zero) and
[OpenClaude](https://github.com/Twigpine/openclaude) (agents), OpenGateway
(inference), and the Twigpine Network (code).

[Quick Start](#quick-start) | [Use from any agent](#use-from-any-agent) | [Self-host](#self-host-a-server) | [Library](#use-as-a-library) | [Security](#security-model) | [Development](#development) | [Community](#community)

## Why OpenRecall

Agents forget everything between sessions, and what one agent learns the next
one never sees. The usual fix, syncing memory to a vendor's cloud, ties that
memory to one tool and lets a third party read everything your agents learn
about you and your code.

- **One memory, every agent.** A built-in MCP server gives every agent the same
  six memory tools over the same store, and `openrecall setup` connects the
  agents on your machine for you.
- **Private by construction.** Memory is encrypted with a key derived from your
  passphrase before it leaves the process. A server stores and serves
  ciphertext only; we can host it and still cannot read it.
- **No server required.** Local mode keeps ciphertext in `~/.openrecall` and
  lets every agent on the machine share it safely. Add a server when you want
  the same memory on every machine.
- **Self-hostable, with delta sync.** One server, pluggable storage (filesystem
  or S3-compatible). Deterministic encryption means only changed entries are
  uploaded, even though the server never sees plaintext.
- **Secret-aware.** A client-side scanner refuses to save entries that look like
  live credentials, before they are encrypted or sent anywhere.

## Quick start

```bash
npm i -g @twigpine/openrecall     # Node 24+
openrecall init                   # one passphrase, kept owner-only in ~/.openrecall
openrecall setup all --write      # connect every agent found on this machine
openrecall status                 # check the config and the store
```

Restart your agents and they share one memory. No server is involved: this is
local mode. `setup` without `--write` is a dry run that prints every change
first; where an agent has its own `mcp add`, that is what it uses, and any JSON
file it edits is backed up. Per-agent notes, including Zero's sandbox and the
Claude Code / OpenClaude plugin, are in [docs/agents.md](./docs/agents.md).

> **Zero-knowledge means no recovery.** The passphrase in
> `~/.openrecall/config.json` is the only key to your memory. Back that file up;
> nobody, including the host, can recover it.

## Three ways to use it

| | You run | Good for |
|---|---|---|
| **Local** | `npm i -g @twigpine/openrecall`, then `init` and `setup` | one machine, every agent on it, no server |
| **Server** | `openrecall serve`, or the Docker image | the same memory on every machine, or a team |
| **Library** | `import { OpenRecallClient } from '@twigpine/openrecall'` | agents you write yourself |

One rule ties them together: **the MCP server runs wherever the passphrase is.**
Recall ranks over plaintext after decryption, so it has to run on your machine.
A server only stores and syncs ciphertext; it is what makes memory follow you
across machines, never a place that can read it.

## Use from any agent

`openrecall setup` covers Claude Code, Zero, OpenClaude, Codex, Cursor, Gemini
CLI, opencode, Windsurf, Claude Desktop, and VS Code. For anything else that
speaks MCP, register a stdio server. The agent's config holds no secrets:

```json
{
  "mcpServers": {
    "openrecall": { "command": "npx", "args": ["-y", "@twigpine/openrecall", "mcp"] }
  }
}
```

Claude Code and OpenClaude can install the plugin instead, which bundles the
MCP server and the memory skill:

```text
/plugin install openrecall --marketplace Twigpine/openrecall
```

| Tool | Purpose |
|---|---|
| `memory_save(key, content)` | persist a durable fact |
| `memory_recall(query)` | rank stored memories by relevance (locally) and return the matching part of each |
| `memory_search(query)` | literal keyword or substring search |
| `memory_get(key)` | read one entry in full |
| `memory_list()` | list entry keys |
| `memory_delete(key)` | remove an entry |

Tools alone do not make an agent use memory well; it also needs the discipline
to recall before answering, save only durable facts, and never duplicate. That
lives in one place, [`skills/openrecall-memory/SKILL.md`](./skills/openrecall-memory/SKILL.md).
`setup` installs it where an agent loads skills, and the MCP server exposes the
same text as its `memory_guide` prompt and in its startup instructions, so every
client gets it.

## Self-host a server

A server lets several machines share one memory. Install [Bun](https://bun.sh)
and ensure `bun` is on your PATH. The npm-installed `openrecall serve` launches
Bun automatically; everything else in the package runs on Node. For local
memory on one machine, use `init` and `setup` from the quick start above.

```bash
npm i -g @twigpine/openrecall
export STATIC_API_KEYS="me:$(openssl rand -hex 24)"   # owner:key, note the key
STORE=fs DATA_DIR=./data openrecall serve

# on each machine, the same passphrase everywhere (copy it from the first)
openrecall init --url https://memory.example.com --api-key <key> --namespace user:me
```

With releases before the automatic Bun launch, run
`bunx --bun @twigpine/openrecall serve` instead.

Each API key owns the `user:<owner>` namespace subtree. For many users, use the
Supabase key table in [`migrations/`](./migrations) instead of static keys.
`ALLOW_UNAUTHENTICATED=true` skips auth entirely, for a server bound to
localhost only. A Docker image (`ghcr.io/twigpine/openrecall`) and a
[`fly.toml`](./fly.toml) are included; configuration is in
[`.env.example`](./.env.example). What lands on the server is ciphertext: grep
its data directory for any plaintext and you will find nothing.

## Use as a library

```ts
import { OpenRecallClient } from '@twigpine/openrecall'

const memory = new OpenRecallClient({
  url: 'https://memory.example.com',            // your server
  apiKey: process.env.OPENRECALL_API_KEY,
  passphrase: process.env.OPENRECALL_PASSPHRASE, // never leaves this process
})

await memory.push('user:me', { 'MEMORY.md': '# what I know about the user' })
const { entries } = await memory.pull('user:me')
```

The entry points (`@twigpine/openrecall`, `/crypto`, `/secretscan`) ship as
plain ESM with type declarations, for Node 24+, Bun, or any bundler. An agent
that only needs memory tools is better served by the MCP server; the library is
for code that wants the sync protocol itself.

## How it works

```
agent (Claude Code · Zero · OpenClaude · Codex · Cursor · …)
   │   MCP tools: plaintext in, plaintext out
   ▼  openrecall mcp — runs on your machine, holds the passphrase
   │  [ client/crypto.ts — encrypt with a key derived from your passphrase ]
   │   ciphertext
   ▼
local store (~/.openrecall/data)   or   openrecall server (crypto-blind)
                                            ▼
                                  BlobStore: fs | s3 (Tigris/R2/AWS)
```

## Security model

- **Encryption.** AES-256-GCM with
  `key = scrypt(passphrase, salt = sha256("openrecall:" + namespace))`.
- **Integrity.** The entry key is GCM additional authenticated data, so a blob
  is bound to its key and cannot be swapped or replayed.
- **Determinism.** A synthetic-IV nonce enables delta sync; the only leak is
  whether two entries are byte-identical.
- **Key custody.** The passphrase lives only in `~/.openrecall/config.json`
  (mode 0600) or your environment, and only the local MCP/CLI process reads it.
  Agent configs never contain it.
- **Defense in depth.** The client-side secret scanner runs before encryption
  and blocks saves containing live-looking credentials by default
  (`OPENRECALL_SCAN=warn|off` to relax it).
- **Tenancy.** Each API key maps to an owner who controls exactly their own
  `user:<owner>` subtree, with per-account quotas and per-owner rate limits
  enforced server-side.
- **Upgrade path.** A version byte on every blob allows a move to
  XChaCha20-Poly1305 and Argon2id without breaking existing data.

Report vulnerabilities privately; see [SECURITY.md](./SECURITY.md) for the
process and the threat model.

## HTTP API

All bodies are ciphertext; the server validates sizes and hashes without
decrypting anything.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | liveness |
| `GET` | `/api/memory/:ns` | full data (ciphertext entries + checksums) |
| `GET` | `/api/memory/:ns?view=hashes` | per-key checksums only, for delta sync |
| `PUT` | `/api/memory/:ns` | delta upsert `{ entries, deletions?, base? }` |
| `DELETE` | `/api/memory/:ns?key=<entryKey>[&base=sha256:<hex>]` | remove one entry |

A *namespace* (`user:me`, `repo:owner/name`, `agent:intern`) is the unit of
scoping, and entry keys mirror a memory directory (`MEMORY.md`,
`feedback/x.md`). The hashes view also reports `supports` (capabilities a client
can rely on) and `erasure` (whether this deployment's store really removes
bytes on delete).

`base` is an optional per-entry precondition: the ciphertext hash the caller
believes a key holds, or `null` for "should not exist". A disagreement is
refused with `409 stale_base_version` and a `details.conflicts` map naming what
each key actually holds; omitting `base` writes unconditionally. A namespace
whose manifest cannot be parsed answers `503 manifest_unreadable` rather than
appearing empty.

## Configuration

- **Client** (CLI and MCP server): `~/.openrecall/config.json`, written by
  `openrecall init`, holds `url` (`local` or a server URL), `apiKey`,
  `passphrase`, `namespace`, and `scan` (`block` | `warn` | `off`).
  `OPENRECALL_URL`, `OPENRECALL_API_KEY`, `OPENRECALL_PASSPHRASE`,
  `OPENRECALL_NAMESPACE`, and `OPENRECALL_SCAN` override it; `OPENRECALL_HOME`
  moves the whole directory.
- **Server:** [`.env.example`](./.env.example) documents `STORE` (`fs` | `s3`),
  `ALLOW_UNAUTHENTICATED`, `STATIC_API_KEYS` or Supabase auth, and the
  per-namespace and per-account limits.

## Status

**Beta.** `@twigpine/openrecall` is on npm. The crypto-blind server, client
crypto, CLI, local mode, MCP server, agent setup, secret scanner, quotas, and
rate limiting are implemented and covered by `bun test`, including real MCP
sessions over stdio under both Bun and Node and an install of the packed
package under Node. Next: the hosted beta at `memory.twigpine.com` and a
self-service console for API keys. See [ROADMAP.md](./ROADMAP.md).

## Development

```bash
bun install
bun run build       # dist/openrecall.js (the Node CLI) and dist/client/ (the library)
bun test            # the suite; build first so the Node bundle and package tests run
bun run type-check  # tsc --noEmit
bun run check       # biome lint + format
```

The codebase splits along the trust boundary:

```
client/    the zero-knowledge client — encrypts here; holds the key
src/       the crypto-blind server — only ever sees ciphertext
src/cli/   client settings, local mode, and `openrecall setup`
src/mcp/   the MCP server (memory tools) over the client
bin/       the CLI (init | setup | status | push | pull | mcp | serve)
skills/    the openrecall-memory skill, shared by every agent
```

The cardinal rule: **plaintext, passphrases, and derived keys never reach the
server.** A test walks the import graph to enforce it. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the full guide.

## Community

- Use [GitHub Discussions](https://github.com/Twigpine/openrecall/discussions) for Q&A, ideas, and community conversation
- Use [GitHub Issues](https://github.com/Twigpine/openrecall/issues) for confirmed bugs and actionable feature work
- Join the [Discord](https://discord.gg/k68zFR6AcB) to chat with the community in real time
- Follow [@twigpine on X](https://x.com/twigpine) for updates and announcements

## Contributing

Issues and PRs welcome. For larger changes, open an issue first so the scope is
clear. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the dev setup, design
principles, Conventional Commits, and DCO sign-off, and our
[Code of Conduct](./CODE_OF_CONDUCT.md).

## License

Released under the [MIT License](./LICENSE). Contributions are accepted under
the same license.
