/**
 * Credential masking filter for transcripts, logs, and WebSocket messages.
 * Enforces zero secret leakage by redacting GitHub tokens, private keys,
 * ecosystem API keys, and injected environment secrets.
 */

const TOKEN_PATTERNS: Array<{ regex: RegExp; replace: (match: string, ...args: any[]) => string }> = [
  // GitHub classic personal access token
  { regex: /\bghp_[a-zA-Z0-9_]{10,}\b/g, replace: () => "ghp_[REDACTED]" },
  // GitHub OAuth access token
  { regex: /\bgho_[a-zA-Z0-9_]{10,}\b/g, replace: () => "gho_[REDACTED]" },
  // GitHub fine-grained personal access token
  { regex: /\bgithub_pat_[a-zA-Z0-9_]{20,}\b/g, replace: () => "github_pat_[REDACTED]" },
  // GitHub user-to-server token
  { regex: /\bghu_[a-zA-Z0-9_]{10,}\b/g, replace: () => "ghu_[REDACTED]" },
  // GitHub server-to-server token
  { regex: /\bghs_[a-zA-Z0-9_]{10,}\b/g, replace: () => "ghs_[REDACTED]" },
  // GitHub refresh token
  { regex: /\bghr_[a-zA-Z0-9_]{10,}\b/g, replace: () => "ghr_[REDACTED]" },

  // Generic and test short forms (e.g., ghp_xxxx in tests)
  { regex: /\bghp_[a-zA-Z0-9_]+\b/g, replace: () => "ghp_[REDACTED]" },
  { regex: /\bgho_[a-zA-Z0-9_]+\b/g, replace: () => "gho_[REDACTED]" },
  { regex: /\bgithub_pat_[a-zA-Z0-9_]+\b/g, replace: () => "github_pat_[REDACTED]" },

  // Private key blocks (RSA, EC, OpenSSH, Generic)
  {
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => "[REDACTED PRIVATE KEY]"
  },

  // Sentry auth tokens
  { regex: /\bsntrys_[a-zA-Z0-9_]{10,}\b/g, replace: () => "sntrys_[REDACTED]" },
  // Linear API keys
  { regex: /\blin_api_[a-zA-Z0-9_]{10,}\b/g, replace: () => "lin_api_[REDACTED]" },
  // Slack tokens
  { regex: /\bxox[baprs]-[a-zA-Z0-9-]{10,}\b/g, replace: () => "xox-[REDACTED]" },

  // Bearer tokens in headers
  {
    regex: /\b(Bearer\s+)[a-zA-Z0-9_\-\.]{20,}\b/gi,
    replace: (_match, prefix: string) => `${prefix}[REDACTED]`
  }
];

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redacts tokens and specified secret values from a string.
 */
export function sanitizeTokens(
  text: string,
  customSecrets?: readonly (string | undefined)[]
): string {
  if (!text || typeof text !== "string") return text;

  let result = text;

  // 1. Redact known exact secrets if provided (min length 6 to prevent over-matching)
  if (customSecrets) {
    for (const secret of customSecrets) {
      if (typeof secret === "string" && secret.trim().length >= 6) {
        const secretPattern = new RegExp(escapeRegExp(secret.trim()), "g");
        result = result.replace(secretPattern, "[REDACTED]");
      }
    }
  }

  // 2. Redact known token patterns
  for (const { regex, replace } of TOKEN_PATTERNS) {
    result = result.replace(regex, replace);
  }

  return result;
}

/**
 * Recursively redacts tokens and secrets across arbitrary data structures.
 */
export function sanitizeValue<T>(
  value: T,
  customSecrets?: readonly (string | undefined)[]
): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return sanitizeTokens(value, customSecrets) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, customSecrets)) as unknown as T;
  }

  if (typeof value === "object") {
    const clone: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      clone[key] = sanitizeValue(val, customSecrets);
    }
    return clone as unknown as T;
  }

  return value;
}
