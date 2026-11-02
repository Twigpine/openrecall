# openrecall v0.1 — Initial Release Plan

> Target: **free open beta** of hosted zero-knowledge agent memory at
> `memory.twigpine.com`, with an **MCP server** as the primary day-one surface so
> any MCP-capable agent (Claude Code, Cursor, opencode, SDK) gets durable,
> end-to-end-encrypted memory by adding one config block.
>
> Companion to [`PLAN.md`](./PLAN.md) (the full multi-phase roadmap). This doc is
> the cut line for *what ships first*. Decisions locked 2026-06-24:
> MCP-first · free beta (no billing) · hosted by us.

## Build status (updated 2026-06-24)

Code-complete and tested (`bun test` → 48 pass, `tsc --noEmit` clean):

- ✅ **M1 hardening** — strict `authorizeNamespace` (segment match + ACL stub,
  isolation tests), per-namespace + per-owner quotas (`src/quota.ts`), per-owner
  token-bucket rate limiting (`src/ratelimit.ts`), runtime body cap + security
  headers, Supabase migration (`migrations/0001_init.sql`).
- ✅ **M2 MCP server** — `openrecall mcp` (`src/mcp/`): 5 tools over OpenRecallClient,
  local relevance ranker, verified end-to-end over real stdio JSON-RPC.
- ✅ **M3 secret scanner** — `client/secretscan.ts`, wired into push + MCP save,
  `OPENRECALL_SCAN=block|warn|off`.
- ✅ **M5 (partial)** — CI + release workflows (`.github/workflows/`), Docker
  reproducible install, README/`.env.example` updated to shipped behavior.
- ⏳ **Remaining for launch:** M4 onboarding console (sign-in → issue API key →
  copy MCP config); deploy to `memory.twigpine.com`; prod ciphertext-at-rest
  smoke; create the `Twigpine/openrecall` repo + first tag. These need accounts/infra
  (Supabase, Fly, npm/GHCR tokens), so they're the human-in-the-loop steps.

---

## 0. Where we are (baseline — already built & green)

`bun test` → 19 pass, `tsc --noEmit` clean. The crypto-blind core is done:

| Area | Status | Files |
|---|---|---|
| Sync contract (GET/PUT/DELETE, hashes view, delta upsert) | ✅ | `src/handler.ts`, `src/memory.ts` |
| Namespace + entry-key validation (path-traversal safe) | ✅ | `src/namespace.ts` |
| BlobStore trait: `fs` + `s3`/Tigris | ✅ | `src/store/*` |
| Auth: open / static-keys / Supabase lookup | ✅ | `src/auth.ts` |
| Client crypto (AES-256-GCM, scrypt, deterministic nonce) | ✅ | `client/crypto.ts` |
| `OpenRecallClient` push/pull/delta | ✅ | `client/index.ts` |
| CLI `push` / `pull` / `serve` | ✅ | `bin/openrecall.ts` |
| Deploy config (Fly + Docker, single machine) | ✅ | `fly.toml`, `Dockerfile` |

The product *works* today for a self-hosting CLI user. v0.1 is about making it
**hosted, multi-tenant, and usable from a real agent without writing code.**

---

## 1. Scope — what v0.1 is (and isn't)

### In scope (the launch bar)
1. **MCP server** — `openrecall mcp` subcommand exposing memory tools; the headline
   feature. Local key custody; remote stays ciphertext-only.
2. **Hosted multi-tenant beta** at `memory.twigpine.com` — Supabase-backed API
   keys, real namespace isolation, quotas (count + bytes), abuse limits.
3. **Self-service onboarding** — minimal web console: X/Supabase sign-in → create
   API key → copy a ready-to-paste MCP config + passphrase guidance.
4. **Client-side secret scanner** — defense-in-depth, runs before encryption
   (ported from openclaude). README already promises it.
5. **Single npm package** `@twigpine/openrecall` published — server, client, CLI, MCP
   in one (`bunx -y @twigpine/openrecall mcp`).
6. **OSS hygiene** — CI (test + typecheck + GHCR image), release-please, docs
   accurate to shipped behavior, MIT license.

### Explicitly NOT in v0.1 (fast-follows, tracked in PLAN.md)
- ❌ Billing / paid tiers (free beta; quotas only).
- ❌ openclaude native drop-in shim (Path A) — fast-follow #1.
- ❌ Local sync daemon / file watcher (Path C).
- ❌ git-backed / IPFS BlobStore adapters.
- ❌ Memory sharing/forking, searchable-encrypted tier, versioning UI.
- ❌ Postgres MetadataIndex / horizontal scale (stay single-machine — see §6).
- ❌ Key recovery (beta = "back up your passphrase, no recovery"; documented).

---

## 2. Milestones & sequencing

Ordered by dependency and leverage. Each milestone is independently shippable to
staging. **Estimates are rough engineering-days, single dev.**

### M1 — Hosted multi-tenant hardening (foundation) · ~2–3d
Make the server safe to expose to strangers before anyone connects.
- **Supabase schema + migration**: `openrecall_api_keys` table
  (`id`, `owner_id`, `key_hash`, `name`, `created_at`, `last_used_at`,
  `revoked_at`) + `openrecall_namespaces` for quota accounting
  (`owner_id`, `namespace`, `entry_count`, `total_bytes`, `updated_at`).
  Ship as a checked-in SQL migration, not console clicks.
- **Per-owner quotas** (not just per-namespace): cap namespaces/owner, total
  bytes/owner. Enforce in `upsert` against the accounting row; structured `413`.
- **Rate limiting**: token-bucket per owner (in-memory is fine at single
  machine; document the limit). Add `429` with `Retry-After`.
- **Tighten `authorizeNamespace`**: current rule (`namespace.includes(":"+owner)`)
  is too loose for multi-tenant — `owner "ab"` could match `repo:lab/...`. Replace
  with explicit segment matching + an ACL hook stub. **Security-critical.**
- **Request hardening**: enforce `MAX_BODY_BYTES` even when `content-length` is
  absent (stream cap), reject unknown methods early, add security headers.
- **Health/readiness**: `/health` already exists; add store round-trip check.

### M2 — MCP server (the headline) · ~3–4d
`openrecall mcp` stdio subcommand wrapping the already-bundled `OpenRecallClient`.
- **Tools** (thin, plaintext-in/out; encryption stays in-process):
  - `memory_save({ namespace?, key, content })`
  - `memory_recall({ namespace?, query })` — pull + run `findRelevantMemories`
    locally (port the scorer from openclaude memdir).
  - `memory_search({ namespace?, query })` — substring/keyword over decrypted set.
  - `memory_list({ namespace? })` — keys + sizes + timestamps (no content).
  - `memory_delete({ namespace?, key })`.
- **Config resolution**: `OPENRECALL_URL`, `OPENRECALL_API_KEY`, `OPENRECALL_PASSPHRASE`,
  default `namespace` (e.g. `user:<owner>`). Fail loudly + helpfully if passphrase
  missing.
- **Recall quality**: this is the make-or-break UX. Reuse openclaude's relevance
  scorer; decrypt locally, score, return top-N with file/section context.
- **Ship the config snippet** users paste (see M4):
  `{ "command": "bunx", "args": ["-y", "@twigpine/openrecall", "mcp"], "env": {...} }`.
- **Tests**: spin the in-process server (handler.ts) + MCP tools against `fs`
  store end-to-end; assert server only ever holds ciphertext.

### M3 — Client-side secret scanner · ~1d
- Port openclaude's gitleaks-style regex scan; run in `OpenRecallClient.push` and
  the MCP `memory_save` path **before** `encryptEntry`.
- Default: **block + warn** on high-confidence hits; `OPENRECALL_SCAN=warn|block|off`.
- Unit tests with known secret fixtures. Update README (remove "planned").

### M4 — Self-service onboarding console · ~2–3d
Minimal but real. Can be a small static page + a couple of API routes on the same
Fly app (or a tiny Next on Vercel hitting Supabase).
- Sign in (reuse opengateway/X + Supabase auth).
- **Issue/revoke API keys** — show `mk_live_...` once, store only `key_hash`.
- **Generated setup card**: copy-paste MCP JSON pre-filled with their key + URL,
  plus a generated strong passphrase suggestion and the **"zero-knowledge = no
  recovery, back this up"** warning prominently.
- **Namespace list** (encrypted): keys, sizes, last-modified, quota usage. By
  design it cannot show plaintext.
- Out of scope: any billing UI.

### M5 — Release engineering & launch · ~1–2d
- **CI** (GitHub Actions): `bun test` + `tsc --noEmit` on PR; on tag, publish npm
  + build/push GHCR image (match `node` repo's release-please + GHCR pattern).
- **release-please** for MIT-licensed OSS repo `Twigpine/openrecall`.
- **Deploy** `memory.twigpine.com` (Fly, `STORE=s3` Tigris, Supabase secrets set).
- **Smoke test in prod**: real API key → MCP save/recall round-trip → confirm
  ciphertext-at-rest via Tigris object inspection.
- **Docs pass**: README status → "Beta", quickstart for *hosted* path (not just
  self-host), MCP setup, security model, threat model, beta limits.
- **Launch**: short announcement; gather the first cohort.

**Critical path:** M1 → M2 → M5. M3 and M4 parallelize against M2.
**Rough total:** ~9–13 dev-days to a credible public beta.

---

## 3. Definition of done (v0.1 ship gate)

- [ ] A new user can go sign-in → key → paste MCP config → have an agent
      `memory_save` then `memory_recall` across a fresh session, **without writing
      code or reading source.**
- [ ] `grep`-ing the Tigris bucket / data dir for any saved plaintext returns
      nothing (ciphertext-at-rest proven in prod).
- [ ] Tenant isolation test: owner A's key cannot read/write owner B's namespace
      (automated test + manual prod check).
- [ ] Quota + rate limits return structured `413`/`429`; verified.
- [ ] Secret scanner blocks a planted credential before upload.
- [ ] CI green; `@twigpine/openrecall` installs and `bunx ... mcp` runs clean on a
      machine that never saw the repo.
- [ ] Docs match shipped behavior; passphrase-loss warning is unmissable.

---

## 4. Key decisions (locked) & open questions

**Locked**
- MCP-first launch surface (widest reach, no upstream dependency).
- Free beta, quotas not billing.
- Single Fly machine (`min_machines_running = 1`) — no Postgres index yet (§6).
- Crypto stays AES-256-GCM + scrypt for v0.1; version byte already reserves the
  Argon2id/XChaCha20 upgrade path. **Don't re-architect crypto pre-launch.**

**Open (need a call before/within the milestone noted)**
- **Default namespace UX (M2):** one `user:<id>` per user, or expose namespaces as
  a first-class concept in the MCP tools from day one? Recommend: default to
  `user:<id>`, allow optional `namespace` arg. Keep simple.
- **Passphrase custody (M2/M4):** env var only for beta, or offer OS-keychain
  storage in the MCP server? Recommend: env var for beta, keychain fast-follow.
- **Console hosting (M4):** same Fly app (Bun static + routes) vs separate Vercel
  Next app. Recommend: smallest thing — static page + 2 routes on the Fly app to
  avoid a second deploy target during beta.
- **Beta quota numbers (M1):** starting caps (e.g. 5 namespaces, 50 MB, 2k
  entries/ns, N req/min). Set conservatively; easy to raise.

---

## 5. Top risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Loose authorization** (`includes` substring match) leaks across tenants | Critical | M1 rewrite to explicit segment ACL + isolation test in DoD |
| Recall quality feels worse than a vendor's server-side memory | High (adoption) | M2 reuses proven openclaude scorer; budget time to tune top-N + context |
| Passphrase loss → user locked out, blames us | Med (support/trust) | Unmissable warnings (M4), generated strong passphrase, documented no-recovery; keychain fast-follow |
| Single machine = no HA; restart drops in-memory rate-limit/lock state | Med | Acceptable for beta; `auto_start`, healthcheck; Postgres index is the scale fast-follow (§6) |
| Secret accidentally synced before scanner ships | Med | M3 early; scanner defaults to **block**; client-side so it never leaves the machine |
| npm/`bunx` cold-start UX for MCP is slow/janky | Low–Med | Test the published-package path on a clean machine in DoD; consider pinning |

---

## 6. Explicit scale deferral (why single-machine is OK for beta)

The manifest read-modify-write is guarded by an **in-process** per-namespace lock
(`src/memory.ts`). That's correct for one machine and wrong for many. v0.1 stays at
`min_machines_running = 1` deliberately. The scale fast-follow (PLAN §7) moves the
manifest/version into Postgres with a row-level version check, at which point we
can run N machines. **Do not horizontally scale before that lands** — it would
corrupt manifests. This is a documented, deliberate beta constraint, not an
oversight.

---

## 7. Fast-follow order (post-launch, for reference)

1. **openclaude native drop-in** (Path A) — configurable team-memory base URL +
   E2E shim. Deepest integration; highest-fidelity for our own agent.
2. **Postgres MetadataIndex** → horizontal scale + HA.
3. **Billing**: opengateway credits / Polar / x402; paid tiers above free quota.
4. **OS-keychain passphrase custody** + recovery-blob option.
5. **Local sync daemon** (Path C) mirroring `~/.claude` memdir for any tool.
6. **git-backed signed BlobStore** for audit/versioning; versioning UI.
7. **Sharing/forking**, then **searchable-encrypted tier**.
