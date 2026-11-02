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
The memory layer of the agent stack — Claude Code, Cursor, opencode, and your
SDK agents all read and write the same durable memory, carried across sessions
and stored on a server that *cannot read it*.

> Part of the [Twigpine](https://twigpine.com) stack: opengateway (inference) ·
> node (code) · openclaude (agent) · **openrecall (memory)**.

---

## Why

Agents forget everything between sessions, and what one agent learns the next
one never sees. The existing fix — syncing memory to a vendor's cloud — locks
that memory to one tool and means a third party can read everything your agents
learn about you and your code. openrecall is the alternative:

- **Unified.** One namespace, every agent. A built-in **MCP server** gives
  Claude Code, Cursor, opencode, and SDK agents the same memory tools
  (`memory_save`/`recall`/`search`/`list`/`delete`) over the same store; a
  simple sync API any agent can speak is underneath.
- **Zero-knowledge.** Memory is encrypted on your machine before upload. The
  server stores and serves only ciphertext (AES-256-GCM, key derived from your
  passphrase). We host it but we cannot read it.
- **Self-hostable.** One binary, pluggable storage (filesystem, S3/Tigris/R2,
  more coming). Run it on our cloud or your own.
- **Delta sync.** Deterministic encryption means only changed entries upload,
  even though the server never sees plaintext.
- **Secret-aware.** A client-side scanner refuses to upload entries that look
  like they contain live credentials — before they're ever encrypted or sent.

## How it works

```
agent / CLI / MCP
   │   plaintext in, plaintext out
   ▼  [ client/crypto.ts — encrypt with key derived from your passphrase ]
   │   ciphertext
   ▼
openrecall server  (crypto-blind — only ever sees ciphertext)
   ▼
BlobStore: fs | s3 (Tigris/R2/AWS) | ipfs/git (planned)
```

The server is **crypto-blind**: it does delta sync, dedup, and storage entirely
over ciphertext. The encryption key never leaves the client.

## Quick start (self-host)

```bash
bun install

# 1. run the server (filesystem storage, single-user open mode)
ALLOW_UNAUTHENTICATED=true STORE=fs DATA_DIR=./data bun run src/index.ts

# 2. sync a memory directory, end-to-end encrypted
export OPENRECALL_URL=http://localhost:8080
export OPENRECALL_PASSPHRASE='your-zero-knowledge-passphrase'   # never sent to the server

bun run bin/openrecall.ts push ./my-memories user:me   # encrypt + upload
bun run bin/openrecall.ts pull ./restored      user:me   # download + decrypt
```

What lands on the server is ciphertext — `grep` your data dir for any plaintext
and you'll find nothing.

> ⚠️ **Zero-knowledge means no recovery.** If you lose your passphrase, the host
> cannot help you — the data is unreadable to everyone but the key holder. Back
> up your passphrase.

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

## Use from any agent (MCP)

openrecall ships an MCP server in the same package, so any MCP-capable agent
gets durable encrypted memory by adding one config block — and every agent
pointed at the same namespace and passphrase shares it. Add to your client's
MCP config (Claude Code shown):

```json
{
  "mcpServers": {
    "openrecall": {
      "command": "bunx",
      "args": ["-y", "@twigpine/openrecall", "mcp"],
      "env": {
        "OPENRECALL_URL": "https://memory.twigpine.com",
        "OPENRECALL_API_KEY": "mk_live_...",
        "OPENRECALL_PASSPHRASE": "your-zero-knowledge-passphrase",
        "OPENRECALL_NAMESPACE": "user:me"
      }
    }
  }
}
```

The MCP server runs **locally**, holds the passphrase, and encrypts/decrypts
in-process — so the remote server still only ever sees ciphertext. Tools:

| Tool | Purpose |
|---|---|
| `memory_save(key, content)` | persist a durable fact |
| `memory_recall(query)` | rank stored memories by relevance (local) |
| `memory_search(query)` | literal keyword/substring search |
| `memory_list()` | list entry keys |
| `memory_delete(key)` | remove an entry |

For self-host, omit `OPENRECALL_API_KEY` and point `OPENRECALL_URL` at your server.

### Teaching the agent to use memory

Tools alone don't make an agent use memory well — it needs the *discipline*
(recall before answering, save only durable facts, don't duplicate). That lives
in one place, [`skills/openrecall-memory/SKILL.md`](./skills/openrecall-memory/SKILL.md):

- **Claude Code:** install it as a skill (drop the folder in your skills dir) and
  the agent reads it when memory is relevant.
- **Any MCP client:** the server exposes the same text as the `memory_guide`
  prompt and a short version in its startup `instructions`, so Cursor / opencode
  / SDK agents get the protocol without a separate file.

## API

All bodies are ciphertext; the server validates sizes/hashes without decrypting.

| Method | Route | Purpose |
|---|---|---|
| `GET`  | `/health` | liveness + active store |
| `GET`  | `/api/memory/:ns` | full data (ciphertext entries + checksums) |
| `GET`  | `/api/memory/:ns?view=hashes` | per-key checksums only (for delta) |
| `PUT`  | `/api/memory/:ns` | delta upsert `{ entries, deletions? }` |
| `DELETE` | `/api/memory/:ns?key=<entryKey>` | remove one entry |

A *namespace* (`user:me`, `repo:owner/name`, `agent:intern`) is the unit of
scoping. Entry keys mirror the memdir layout (`MEMORY.md`, `feedback/x.md`).

## Configuration

See [`.env.example`](./.env.example). Key knobs: `STORE` (`fs`|`s3`),
`ALLOW_UNAUTHENTICATED`, `STATIC_API_KEYS` / Supabase auth, and per-namespace
size/count limits.

## Security model

- **Encryption:** AES-256-GCM; key = `scrypt(passphrase, salt=sha256("openrecall:"+namespace))`.
- **Integrity:** the entry key is GCM additional-authenticated-data, so a blob
  is bound to its key and can't be swapped or replayed.
- **Determinism:** synthetic-IV nonce enables delta sync; the only leak is
  whether two entries are byte-identical.
- **Defense in depth:** a client-side secret scanner runs before encryption and
  (by default) blocks uploads containing live-looking credentials. Override with
  `OPENRECALL_SCAN=warn|off`.
- **Tenancy:** each API key maps to an owner who controls exactly their own
  `user:<owner>` namespace subtree (strict segment match, no substring escapes);
  per-account quotas and per-owner rate limits are enforced server-side.
- **Upgrade path:** a version byte on every blob allows migrating to
  XChaCha20-Poly1305 + Argon2id without breaking existing data.

See [`PLAN.md`](./PLAN.md) for the full roadmap (MCP server, openclaude drop-in,
git-backed signed history, sharing/forking, billing).

## Status

**Beta.** The crypto-blind server, client crypto, CLI, MCP server, secret
scanner, per-account quotas, and rate limiting are implemented and tested
(`bun test` — 50 tests). Hosted free beta at `memory.twigpine.com`. Next:
self-service console for API keys, the openclaude native drop-in, and the
Postgres index for horizontal scale (the hosted beta runs a single machine
deliberately — see [`PLAN.md`](./PLAN.md) §7).

## Development

```bash
bun install
bun test            # run the suite
bun run type-check  # tsc --noEmit
bun run check       # biome lint + format check
```

For contributors, the codebase splits cleanly along the trust boundary:

```
client/   the zero-knowledge client — encrypts here; holds the key
src/      the crypto-blind server — only ever sees ciphertext
src/mcp/  the MCP server (memory tools) over the client
bin/      the CLI (push | pull | mcp | serve)
```

The cardinal rule: **plaintext, passphrases, and derived keys never reach the
server.** See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full guide.

## Contributing

Issues and PRs welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) (dev
setup, design principles, Conventional Commits, DCO sign-off) and our
[Code of Conduct](./CODE_OF_CONDUCT.md).

## Security

openrecall is security software. Please report vulnerabilities privately — **do not
open a public issue.** See [SECURITY.md](./SECURITY.md) for the process and the
threat model.

## License

Released under the [MIT License](./LICENSE). Contributions are accepted under
the same license (see [CONTRIBUTING.md](./CONTRIBUTING.md)).
