/**
 * Transcript sanitizer (R14-05). The smoke runner captures HTTP bodies,
 * headers, SQL output, and container logs — all untrusted text that may
 * echo secrets (session cookies, passwords, tokens, connection strings).
 * Every line entering the transcript passes through here.
 *
 * Deliberately shape-based, never value-based: the runner never compares
 * against real secret values, so there is nothing to leak by comparison.
 * Image digests (sha256:...) are EVIDENCE and must survive redaction.
 */

const RULES: Array<{ re: RegExp; label: string }> = [
  // Session cookie value (ol_session=<token>), in headers or log lines.
  { re: /\bol_session=[^;\s"']+/gi, label: 'ol_session=[REDACTED]' },
  // Bearer tokens in Authorization headers or echoed bodies.
  { re: /\bBearer [REDACTED]+/gi, label: 'Bearer [REDACTED]' },
  // JSON password fields: "password":"...".
  { re: /("password"\s*:\s*")[^"]*(")/gi, label: '$1[REDACTED]$2' },
  // Connection-string credentials: scheme://user:PASS@host.
  { re: /(:\/\/[^/\s:]+:)[^/\s@]+@/g, label: '$1[REDACTED]@' },
  // Live provider key shapes (test keys are synthetic but redact anyway).
  { re: /\bsk_live_[A-Za-z0-9]+/g, label: '[REDACTED]' },
  { re: /\bsk_test_[A-Za-z0-9]+/g, label: '[REDACTED]' },
  { re: /\bwhsec_[A-Za-z0-9]+/g, label: '[REDACTED]' },
  { re: /\bAC[0-9a-fA-F]{32}/g, label: '[REDACTED]' },
  // GitHub / generic token prefixes.
  { re: /\bgh[pousr]_[A-Za-z0-9_]+/g, label: '[REDACTED]' },
  // PEM private key blocks (headers + base64 body stay out of transcripts).
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: '[REDACTED PRIVATE KEY]' },
  // Argon2 password hashes (fixture INSERTs carry them on command lines).
  { re: /\$argon2id\$[^'"\s]+/g, label: '[REDACTED]' },
]

export function redact(text: string): string {
  let out = text
  for (const { re, label } of RULES) {
    re.lastIndex = 0
    out = out.replace(re, label)
  }
  return out
}

/**
 * Credential-scan patterns for the credential-scan probe. Count-only: the
 * probe reports HOW MANY matches per pattern, never the matched values.
 * These run over the RAW captured text (before redaction) — otherwise the
 * scan would only ever prove the redactor works.
 */
export const SCAN_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'sk_live', re: /\bsk_live_[A-Za-z0-9]+/g },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9_]+/g },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'twilio-sid', re: /\bAC[0-9a-fA-F]{32}/g },
  // The placeholder itself must never match (scan runs over text that may
  // already be partially redacted).
  { name: 'connection-string-credentials', re: /:\/\/[^/\s:]+:(?!\[REDACTED\])[^/\s@]+@/g },
  { name: 'password-assignment', re: /\bpassword\s*=\s*[^\s,;]+/gi },
  { name: 'argon2-hash', re: /\$argon2id\$[^'"\s]+/g },
]

export function scanCredentials(raw: string): Array<{ name: string; count: number }> {
  return SCAN_PATTERNS.map(({ name, re }) => {
    re.lastIndex = 0
    const matches = raw.match(re)
    return { name, count: matches?.length ?? 0 }
  })
}
