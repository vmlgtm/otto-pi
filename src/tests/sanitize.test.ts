import { describe, expect, it } from "vitest";
import { sanitizeTokens, sanitizeValue } from "../sanitize";

describe("Phase 2 Guardrail: Secret Protection & Sanitization", () => {
  it("redacts classic GitHub personal access tokens (ghp_)", () => {
    const input = "Cloning with token ghp_ABC1234567890abcdefghijklmnopqrstuvwxyz and test token ghp_sampletoken123";
    const result = sanitizeTokens(input);
    expect(result).not.toContain("ghp_ABC1234567890abcdefghijklmnopqrstuvwxyz");
    expect(result).not.toContain("ghp_sampletoken123");
    expect(result).toBe("Cloning with token ghp_[REDACTED] and test token ghp_[REDACTED]");
  });

  it("redacts GitHub OAuth tokens (gho_)", () => {
    const input = "Authorization: token gho_16C7e42F292c6912E7710c838347Ae178B4a";
    const result = sanitizeTokens(input);
    expect(result).not.toContain("gho_16C7e42F292c6912E7710c838347Ae178B4a");
    expect(result).toBe("Authorization: token gho_[REDACTED]");
  });

  it("redacts GitHub fine-grained personal access tokens (github_pat_)", () => {
    const input = "Exported github_pat_11AAAAAAA0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN_1234567890";
    const result = sanitizeTokens(input);
    expect(result).not.toContain("github_pat_11AAAAAAA0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN_1234567890");
    expect(result).toBe("Exported github_pat_[REDACTED]");
  });

  it("redacts user/server/refresh tokens (ghu_, ghs_, ghr_)", () => {
    const input = "Tokens: ghu_abc123456789, ghs_def123456789, ghr_ghi123456789";
    const result = sanitizeTokens(input);
    expect(result).toBe("Tokens: ghu_[REDACTED], ghs_[REDACTED], ghr_[REDACTED]");
  });

  it("redacts PEM private key blocks", () => {
    const key = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y3GkZ...fakecontent...
-----END RSA PRIVATE KEY-----`;
    const input = `Configured key:\n${key}\nProceeding...`;
    const result = sanitizeTokens(input);
    expect(result).not.toContain("MIIEowIBAAKCAQEA0Y3GkZ");
    expect(result).toContain("[REDACTED PRIVATE KEY]");
  });

  it("redacts ecosystem tokens: Sentry, Linear, Slack, Bearer", () => {
    const input = "Sentry: sntrys_abcdef123456, Linear: lin_api_1234567890abcdef, Slack: xoxb-1234567890-abcdef";
    const result = sanitizeTokens(input);
    expect(result).toBe("Sentry: sntrys_[REDACTED], Linear: lin_api_[REDACTED], Slack: xox-[REDACTED]");
  });

  it("redacts custom injected runtime secrets", () => {
    const rawSecret = "super-secret-random-hex-string-99128";
    const input = `Server connected with secret=${rawSecret} and key=foo`;
    const result = sanitizeTokens(input, [rawSecret]);
    expect(result).not.toContain(rawSecret);
    expect(result).toBe("Server connected with secret=[REDACTED] and key=foo");
  });

  it("recursively sanitizes complex objects and arrays in WebSocket payloads", () => {
    const payload = {
      type: "events",
      session: "1",
      events: [
        {
          type: "tool_output",
          output: "Remote git URL with auth: https://ghp_abcdef1234567890@github.com/vmlgtm/repo.git",
          details: {
            authHeader: "Bearer ghp_secretpass1234567890",
            tokens: ["gho_myoauthkey12345", "clean_string"]
          }
        }
      ]
    };

    const sanitized = sanitizeValue(payload);
    expect(sanitized.events[0].output).toBe("Remote git URL with auth: https://ghp_[REDACTED]@github.com/vmlgtm/repo.git");
    expect(sanitized.events[0].details.authHeader).toBe("Bearer ghp_[REDACTED]");
    expect(sanitized.events[0].details.tokens[0]).toBe("gho_[REDACTED]");
    expect(sanitized.events[0].details.tokens[1]).toBe("clean_string");
  });
});
