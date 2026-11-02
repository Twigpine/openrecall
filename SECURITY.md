# Security Policy

openrecall is security software — a zero-knowledge memory backend. We take reports
seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Do not open a public issue, PR, or discussion for a security vulnerability.**

Report privately via **GitHub Private Vulnerability Reporting**:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** (under "Advisories").
3. Describe the issue, the impact, and a reproduction if you have one.

This opens a private advisory only you and the maintainers can see. We aim to
acknowledge within **72 hours** and to keep you updated as we triage, fix, and
coordinate disclosure. With your agreement we'll credit you in the advisory.

If you cannot use GitHub advisories, note that in any channel you can reach the
maintainers and we'll arrange a private path.

## Supported versions

openrecall is pre-1.0 and ships from `main`. Security fixes land on the latest
`0.x` minor and are released promptly. Older `0.x` lines are not maintained —
please track the latest release.

| Version | Supported |
| ------- | --------- |
| latest `0.x` | ✅ |
| older   | ❌ |

## Threat model & scope

openrecall's core guarantee is that **the server is crypto-blind**: clients encrypt
every entry before upload (AES-256-GCM, key derived from a passphrase that never
leaves the client), so the server stores and serves only ciphertext.

**The server can see:** namespace ids, entry keys (paths), ciphertext blobs,
ciphertext byte sizes and hashes, and timestamps. **The server cannot see:**
memory plaintext, your passphrase, or the derived key.

We're especially interested in reports that break these properties:

- Any way the **server** could recover plaintext, the passphrase, or a data key.
- **Cross-tenant access** — one owner reading or writing another's namespace
  (namespace authorization is in `src/auth.ts`).
- **Crypto weaknesses** — nonce reuse beyond the documented deterministic design,
  AEAD/AAD binding bypass, key-derivation issues (`client/crypto.ts`).
- **Path traversal** via namespace or entry keys (`src/namespace.ts`).
- **Quota / rate-limit bypass** enabling resource exhaustion
  (`src/quota.ts`, `src/ratelimit.ts`).
- Secret-scanner bypasses that let obvious credentials upload unflagged
  (`client/secretscan.ts`) — defense-in-depth, but still worth reporting.

### Known and accepted properties (not vulnerabilities)

- **No passphrase recovery.** Zero-knowledge means if you lose your passphrase,
  the host cannot recover your data. This is by design.
- **Byte-identical entries are detectable.** The deterministic nonce that enables
  delta sync reveals whether two ciphertext entries are identical. Documented
  trade-off in `client/crypto.ts`.
- **Metadata is visible to the host** (namespace ids, entry keys, sizes,
  timestamps) — see scope above. A future tier may hash entry keys.
- **Single-instance hosted beta.** The hosted deployment runs one instance on
  purpose; in-process locks/limits assume that (see PLAN.md §7). Self-hosters
  should not run multiple instances against shared storage until the Postgres
  index lands.

Thank you for helping keep openrecall and its users safe.
