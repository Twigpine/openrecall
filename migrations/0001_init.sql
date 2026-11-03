-- openrecall — hosted auth schema (Supabase / Postgres).
--
-- The openrecall server is crypto-blind and this schema keeps it that way: it
-- stores ONLY API-key *hashes* and an owner id. No passphrase, no data key, no
-- memory plaintext ever touches the database. The server authenticates a
-- request by looking up sha256(token) here (see src/auth.ts):
--
--   GET /rest/v1/openrecall_api_keys?select=owner_id&key_hash=eq.<hash>&revoked_at=is.null
--
-- Apply with: psql "$DATABASE_URL" -f migrations/0001_init.sql
-- (or paste into the Supabase SQL editor).

create extension if not exists pgcrypto;

-- ─── API keys ────────────────────────────────────────────────────────────
-- One row per issued key. The raw key (e.g. mk_live_...) is shown to the user
-- exactly once at creation time and never stored; we keep only its sha256 hex.
create table if not exists public.openrecall_api_keys (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  key_hash      text not null unique,            -- sha256(token), lowercase hex
  name          text,                            -- user-facing label
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz                      -- non-null => key disabled
);

-- The server's hot path: hash lookup of a live key.
create index if not exists openrecall_api_keys_key_hash_live_idx
  on public.openrecall_api_keys (key_hash)
  where revoked_at is null;

create index if not exists openrecall_api_keys_owner_idx
  on public.openrecall_api_keys (owner_id);

-- ─── Row-level security ──────────────────────────────────────────────────
-- The server connects with the service-role key and BYPASSES RLS, so its
-- lookups are unaffected. RLS exists so the web console (acting as the signed-in
-- user) can only ever see and manage that user's own keys.
alter table public.openrecall_api_keys enable row level security;

drop policy if exists "owners read own keys" on public.openrecall_api_keys;
create policy "owners read own keys"
  on public.openrecall_api_keys for select
  using (auth.uid() = owner_id);

drop policy if exists "owners insert own keys" on public.openrecall_api_keys;
create policy "owners insert own keys"
  on public.openrecall_api_keys for insert
  with check (auth.uid() = owner_id);

-- Revocation is an UPDATE of revoked_at (we never hard-delete for audit).
drop policy if exists "owners update own keys" on public.openrecall_api_keys;
create policy "owners update own keys"
  on public.openrecall_api_keys for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

-- Note: per-owner storage quotas are enforced by the server against a usage
-- record in the crypto-blind BlobStore (see src/quota.ts), NOT here, so that
-- self-hosters get identical quota behavior without a database.
