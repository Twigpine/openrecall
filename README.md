```
╭─────────────────────────────────────────────────────────────────────────────────────────╮
│  ● ● ●                          openrecall — ~/memory                          ⌘ + T    │
├─────────────────────────────────────────────────────────────────────────────────────────┤

     ██████╗ ██████╗ ███████╗███╗   ██╗██████╗ ███████╗ ██████╗ █████╗ ██╗     ██╗
    ██╔═══██╗██╔══██╗██╔════╝████╗  ██║██╔══██╗██╔════╝██╔════╝██╔══██╗██║     ██║
    ██║   ██║██████╔╝█████╗  ██╔██╗ ██║██████╔╝█████╗  ██║     ███████║██║     ██║
    ██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║██╔══██╗██╔══╝  ██║     ██╔══██║██║     ██║
    ╚██████╔╝██║     ███████╗██║ ╚████║██║  ██║███████╗╚██████╗██║  ██║███████╗███████╗
     ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝ ╚═════╝╚═╝  ╚═╝╚══════╝╚══════╝

      one memory for every agent and every session · the host cannot read it

    $ openrecall push ./memories user:me
      ⠿ scan secrets    ✓  0 leaked
      ⠿ encrypt  12     ✓  aes-256-gcm · key derived locally, never sent
      ⠿ delta sync   →  memory.twigpine.com
        ↑ 3 changed   · 9 unchanged   ✓ server saw only ciphertext
    $ ▮

╰─────────────────────────────────────────────────────────────────────────────────────────╯
```

<div align="center">

[![CI](https://github.com/Twigpine/openrecall/actions/workflows/ci.yml/badge.svg)](https://github.com/Twigpine/openrecall/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@twigpine/openrecall.svg)](https://www.npmjs.com/package/@twigpine/openrecall)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![Bun](https://img.shields.io/badge/bun-%3E%3D1.2-black?logo=bun)](https://bun.sh)

</div>

**One memory for every agent and every session — open-source, self-hostable,
zero-knowledge.**
The memory layer of the agent stack — Claude Code, Zero, OpenClaude, Codex,
Cursor, and your SDK agents all read and write the same durable memory, carried
across sessions and stored where *no one but you can read it*.

```bash
npm i -g @twigpine/openrecall
openrecall init                # one passphrase, kept owner-only on this machine
openrecall setup all --write   # connect every agent it finds
```

> **OpenRecall by [Twigpine](https://twigpine.com)** — the memory layer next to
> [Zero](https://github.com/Twigpine/zero) and
> [OpenClaude](https://github.com/Twigpine/openclaude) (agents), OpenGateway
> (inference), and the Twigpine Network (code).

---

## Why

Agents forget everything between sessions, and what one agent learns the next
one never sees. The existing fix — syncing memory to a vendor's cloud — locks
that memory to one tool and means a third party can read everything your agents
learn about you and your code. OpenRecall is the alternative:

- **Unified.** One memory, every agent. A built-in **MCP server** gives Claude
  Code, Zero, OpenClaude, Codex, Cursor, Gemini CLI, opencode, and SDK agents
  the same memory tools (`memory_save`/`recall`/`search`/`get`/`list`/`delete`)
  over the same store, and `openrecall setup` wires them up for you.
- **Works offline, no server needed.** Local mode keeps ciphertext in
  `~/.openrecall` and lets every agent on the machine share it safely. Point it
  at a server when you want the same memory on every machine.
- **Zero-knowledge.** Memory is encrypted on your machine before upload. The
  server stores and serves only ciphertext (AES-256-GCM, key derived from your
  passphrase). We host it but we cannot read it.
- **Self-hostable.** One server, pluggable storage (filesystem, S3/Tigris/R2,
  more coming). Run it on our cloud or your own.
- **Delta sync.** Deterministic encryption means only changed entries upload,
  even though the server never sees plaintext.
- **Secret-aware.** A client-side scanner refuses to upload entries that look
  like they contain live credentials — before they're ever encrypted or sent.

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

Encryption happens in the MCP server process on your machine. Whether memory
lives on local disk or on a server, the store only ever holds ciphertext — the
key never leaves the client.

## Quick start

```bash
npm i -g @twigpine/openrecall   # Node 24+; or prefix commands with npx -y @twigpine/openrecall
openrecall init                 # writes ~/.openrecall/config.json (0600) with a fresh passphrase
openrecall setup                # see which agents are on this machine
openrecall setup all --write    # register OpenRecall with all of them
openrecall status               # check config + store
```

Restart your agents and they share one memory. `setup` without `--write` is a
dry run that prints every change first; it edits agent configs through their
own `mcp add` CLIs where they exist and backs up any JSON file it touches. Per
agent details — including Zero's sandbox and the Claude Code / OpenClaude
plugin — are in **[docs/agents.md](./docs/agents.md)**.

> ⚠️ **Zero-knowledge means no recovery.** The passphrase in
> `~/.openrecall/config.json` is the only key to your memory — back that file
> up. Nobody, including the host, can recover it.

**From source** (until the first npm release):

```bash
bun install && bun run build
node dist/openrecall.js init
node dist/openrecall.js setup all --write   # registers absolute paths to this checkout
```

## Use from any agent (MCP)

`openrecall setup` covers Claude Code, Zero, OpenClaude, Codex, Cursor, Gemini
CLI, opencode, Windsurf, Claude Desktop, and VS Code. For anything else that
speaks MCP, register a stdio server — no env or secrets needed in the agent's
config:

```json
{
  "mcpServers": {
    "openrecall": { "command": "npx", "args": ["-y", "@twigpine/openrecall", "mcp"] }
  }
}
```

Claude Code and OpenClaude can instead install the plugin, which bundles the
MCP server and the memory skill:

```text
/plugin install openrecall --marketplace Twigpine/openrecall
```

| Tool | Purpose |
|---|---|
| `memory_save(key, content)` | persist a durable fact |
| `memory_recall(query)` | rank stored memories by relevance (locally) and return the matching part of each |
| `memory_search(query)` | literal keyword/substring search |
| `memory_get(key)` | read one entry in full |
| `memory_list()` | list entry keys |
| `memory_delete(key)` | remove an entry |

### Teaching the agent to use memory

Tools alone don't make an agent use memory well — it needs the *discipline*
(recall before answering, save only durable facts, don't duplicate). That lives
in one place, [`skills/openrecall-memory/SKILL.md`](./skills/openrecall-memory/SKILL.md),
and reaches every agent:

- **Agents with skills** (Claude Code, Zero, OpenClaude, Codex): `setup`
  installs it into their skills directory.
- **Every MCP client:** the server exposes the same text as the `memory_guide`
  prompt and a short version in its startup `instructions`.

## Self-host a server

A server lets several machines share one memory. It needs [Bun](https://bun.sh):

```bash
bun install
export STATIC_API_KEYS="me:$(openssl rand -hex 24)"   # owner:key — note the key
STORE=fs DATA_DIR=./data bun run src/index.ts

# on each machine — the same passphrase everywhere (copy it from the first)
openrecall init --url https://memory.example.com --api-key <key> --namespace user:me
```

Each API key owns the `user:<owner>` namespace subtree. For many users, use the
Supabase key table in `migrations/` instead of static keys.
`ALLOW_UNAUTHENTICATED=true` skips auth entirely — only for a server bound to
localhost. What lands on the server is ciphertext — `grep` its data dir for any
plaintext and you'll find nothing. A Docker image and `fly.toml` are included.

## Use as a library

```ts
import { OpenRecallClient } from '@twigpine/openrecall'

const memory = new OpenRecallClient({
  url: 'https://memory.twigpine.com',
  apiKey: process.env.OPENRECALL_API_KEY,
  passphrase: process.env.OPENRECALL_PASSPHRASE, // stays local
})

await memory.push('user:me', { 'MEMORY.md': '# what I know about the user...' })
const { entries } = await memory.pull('user:me')
```

The library entry points are TypeScript sources — use them from Bun or through
a bundler.

## API

All bodies are ciphertext; the server validates sizes/hashes without decrypting.

| Method | Route | Purpose |
|---|---|---|
| `GET`  | `/health` | liveness |
| `GET`  | `/api/memory/:ns` | full data (ciphertext entries + checksums) |
| `GET`  | `/api/memory/:ns?view=hashes` | per-key checksums only (for delta) |
| `PUT`  | `/api/memory/:ns` | delta upsert `{ entries, deletions?, base? }` |
| `DELETE` | `/api/memory/:ns?key=<entryKey>[&base=sha256:<hex>]` | remove one entry |

A *namespace* (`user:me`, `repo:owner/name`, `agent:intern`) is the unit of
scoping. Entry keys mirror the memdir layout (`MEMORY.md`, `feedback/x.md`).

The hashes view also reports `supports` (server capabilities a client can rely
on) and `erasure` (whether this deployment's store actually removes bytes on
delete); write responses carry `erasure` too.

`base` is an optional precondition: a map of entry key to the ciphertext hash
the caller believes that key holds, or `null` for "should not exist". A request
that disagrees with the stored manifest is refused with `409 stale_base_version`
and a `details.conflicts` map naming what each key actually holds. Omitting
`base` writes unconditionally, which is what a client that has not adopted it
still does. This guards the caller's own turn, not the moment between its last
read and its write, which is why the check is per entry rather than a namespace
version. A namespace whose manifest cannot be parsed answers
`503 manifest_unreadable` rather than appearing empty.

## Configuration

- **Client** (CLI + MCP server): `~/.openrecall/config.json`, written by
  `openrecall init` — `url` (`local` or a server URL), `apiKey`, `passphrase`,
  `namespace`, `scan` (`block`|`warn`|`off`). `OPENRECALL_URL`,
  `OPENRECALL_API_KEY`, `OPENRECALL_PASSPHRASE`, `OPENRECALL_NAMESPACE`,
  `OPENRECALL_SCAN` override it; `OPENRECALL_HOME` moves the whole directory.
- **Server:** see [`.env.example`](./.env.example) — `STORE` (`fs`|`s3`),
  `ALLOW_UNAUTHENTICATED`, `STATIC_API_KEYS` / Supabase auth, and per-namespace
  and per-account limits.

## Security model

- **Encryption:** AES-256-GCM; key = `scrypt(passphrase, salt=sha256("openrecall:"+namespace))`.
- **Integrity:** the entry key is GCM additional-authenticated-data, so a blob
  is bound to its key and can't be swapped or replayed.
- **Determinism:** synthetic-IV nonce enables delta sync; the only leak is
  whether two entries are byte-identical.
- **Key custody:** the passphrase lives only in `~/.openrecall/config.json`
  (mode 0600) or your environment, and only the local MCP/CLI process reads it.
  Agent configs never contain it.
- **Defense in depth:** a client-side secret scanner runs before encryption and
  (by default) blocks saves containing live-looking credentials. Override with
  `OPENRECALL_SCAN=warn|off`.
- **Tenancy:** each API key maps to an owner who controls exactly their own
  `user:<owner>` namespace subtree (strict segment match, no substring escapes);
  per-account quotas and per-owner rate limits are enforced server-side.
- **Upgrade path:** a version byte on every blob allows migrating to
  XChaCha20-Poly1305 + Argon2id without breaking existing data.

## Status

**Beta.** The crypto-blind server, client crypto, CLI, local mode, MCP server,
agent setup, secret scanner, quotas, and rate limiting are implemented and
covered by `bun test`, including real MCP sessions over stdio under both Bun
and Node. Next: the first npm release, the hosted beta at
`memory.twigpine.com`, and a self-service console for API keys — see
[ROADMAP.md](./ROADMAP.md).

## Development

```bash
bun install
bun test            # run the suite (run `bun run build` first to include the Node bundle)
bun run build       # dist/openrecall.js — the single-file Node CLI that npm ships
bun run type-check  # tsc --noEmit
bun run check       # biome lint + format check
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
server.** See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full guide.

## Contributing

Issues and PRs welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) (dev
setup, design principles, Conventional Commits, DCO sign-off) and our
[Code of Conduct](./CODE_OF_CONDUCT.md).

## Security

OpenRecall is security software. Please report vulnerabilities privately — **do not
open a public issue.** See [SECURITY.md](./SECURITY.md) for the process and the
threat model.

## License

Released under the [MIT License](./LICENSE). Contributions are accepted under
the same license (see [CONTRIBUTING.md](./CONTRIBUTING.md)).
