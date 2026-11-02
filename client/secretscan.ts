/**
 * Client-side secret scanner — defense in depth.
 *
 * Agent memory is a magnet for accidental secrets: an agent summarizing a
 * session can easily write "the API key is sk-..." into a note. Even though
 * openrecall encrypts everything before upload, a leaked passphrase would then
 * expose those secrets too, and a synced secret is a synced secret. So we scan
 * plaintext HERE, on the client, BEFORE encryption, and (by default) refuse to
 * upload entries that look like they contain live credentials.
 *
 * This is a pragmatic regex pass in the spirit of gitleaks — high-signal
 * patterns, tuned to avoid the worst false positives. It is not a guarantee;
 * it's a seatbelt. Mode is controlled by the caller (OPENRECALL_SCAN): block
 * (default), warn, or off.
 */

export type ScanMode = 'block' | 'warn' | 'off'

export type Finding = {
  /** entry key the secret was found in */
  entryKey: string
  /** short rule id, e.g. "aws-access-key-id" */
  rule: string
  /** human description */
  description: string
  /** 1-based line number */
  line: number
  /** the matched text, redacted to first/last few chars */
  match: string
}

type Rule = { id: string; description: string; re: RegExp }

// High-signal patterns. Anchored/shaped to keep false positives low.
const RULES: Rule[] = [
  {
    id: 'aws-access-key-id',
    description: 'AWS access key id',
    re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b/,
  },
  {
    id: 'aws-secret-access-key',
    description: 'AWS secret access key',
    re: /\baws_?(?:secret_?)?access_?key[^\n]{0,20}['"=:\s]([A-Za-z0-9/+]{40})\b/i,
  },
  {
    id: 'github-token',
    description: 'GitHub token',
    re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/,
  },
  { id: 'slack-token', description: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'openai-key', description: 'OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: 'anthropic-key', description: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'google-api-key', description: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    id: 'stripe-secret-key',
    description: 'Stripe secret key',
    re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/,
  },
  {
    id: 'gitlab-pat',
    description: 'GitLab personal access token',
    re: /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    id: 'private-key',
    description: 'PEM private key block',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  },
  {
    id: 'jwt',
    description: 'JSON Web Token',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    id: 'generic-assignment',
    description: 'Hardcoded secret/password/token assignment',
    re: /\b(?:api[_-]?key|secret|passwd|password|token|access[_-]?token)\b[^\n]{0,10}[=:]\s*['"][^'"\n]{8,}['"]/i,
  },
]

function redact(s: string): string {
  if (s.length <= 8) return '*'.repeat(s.length)
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}

/** Scan a single entry's plaintext, returning any findings. */
export function scanEntry(entryKey: string, plaintext: string): Finding[] {
  const findings: Finding[] = []
  const lines = plaintext.split('\n')
  for (let i = 0; i < lines.length; i++) {
    for (const rule of RULES) {
      const m = rule.re.exec(lines[i])
      if (m) {
        findings.push({
          entryKey,
          rule: rule.id,
          description: rule.description,
          line: i + 1,
          match: redact(m[1] ?? m[0]),
        })
      }
    }
  }
  return findings
}

/** Scan a whole set of entries (key -> plaintext). */
export function scanEntries(entries: Record<string, string>): Finding[] {
  const all: Finding[] = []
  for (const [key, text] of Object.entries(entries)) all.push(...scanEntry(key, text))
  return all
}

/** Thrown by enforce() in `block` mode when secrets are found. */
export class SecretFoundError extends Error {
  readonly findings: Finding[]
  constructor(findings: Finding[]) {
    super(
      `refusing to upload: ${findings.length} potential secret(s) detected.\n` +
        findings.map(f => `  ${f.entryKey}:${f.line} — ${f.description} (${f.match})`).join('\n') +
        `\nReview and remove them, or set OPENRECALL_SCAN=warn to override (NOT recommended).`,
    )
    this.findings = findings
  }
}

/**
 * Apply scan policy to entries about to be uploaded.
 *   - off:   skip entirely (returns []).
 *   - warn:  return findings; caller logs them but proceeds.
 *   - block: throw SecretFoundError if anything is found.
 */
export function enforce(entries: Record<string, string>, mode: ScanMode): Finding[] {
  if (mode === 'off') return []
  const findings = scanEntries(entries)
  if (findings.length && mode === 'block') throw new SecretFoundError(findings)
  return findings
}
