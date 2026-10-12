import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import server, { verifyGitHubSignature } from "../server";

async function createHmacSignature(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const hex = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

describe("Component C & DoD 5: Webhook Event Ingestion & Signature Verification", () => {
  const SECRET = "test-webhook-secret-xyz-123456";

  it("verifies valid HMAC-SHA256 signatures correctly", async () => {
    const body = JSON.stringify({ action: "opened", issue: { number: 42 } });
    const validSig = await createHmacSignature(SECRET, body);

    const isValid = await verifyGitHubSignature(SECRET, validSig, body);
    expect(isValid).toBe(true);

    const isInvalid = await verifyGitHubSignature(SECRET, "sha256=wrongsignature", body);
    expect(isInvalid).toBe(false);

    const isMissing = await verifyGitHubSignature(SECRET, null, body);
    expect(isMissing).toBe(false);
  });

  it("rejects unauthorized webhook requests with 401 when signature is missing or invalid", async () => {
    const testEnv: Env = {
      ...env,
      GITHUB_WEBHOOK_SECRET: SECRET
    } as any;

    const payload = JSON.stringify({ action: "opened", issue: { number: 101 } });

    // 1. Missing signature
    const missingSigReq = new Request("http://localhost:8787/api/webhooks/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload
    });
    const missingRes = await server.fetch(missingSigReq, testEnv);
    expect(missingRes.status).toBe(401);

    // 2. Invalid signature
    const invalidSigReq = new Request("http://localhost:8787/api/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": "sha256=0000000000000000000000000000000000000000000000000000000000000000"
      },
      body: payload
    });
    const invalidRes = await server.fetch(invalidSigReq, testEnv);
    expect(invalidRes.status).toBe(401);
  });

  it("handles valid signed issues.opened event with 202 Accepted and session initialization", async () => {
    const testEnv: Env = {
      ...env,
      GITHUB_WEBHOOK_SECRET: SECRET
    } as any;

    const payload = JSON.stringify({
      action: "opened",
      issue: {
        number: 42,
        title: "Test bug in parser",
        body: "Please fix parsing error on empty strings."
      },
      repository: {
        full_name: "vmlgtm/test-repo"
      }
    });

    const sig = await createHmacSignature(SECRET, payload);
    const request = new Request("http://localhost:8787/api/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "issues",
        "X-Hub-Signature-256": sig
      },
      body: payload
    });

    const response = await server.fetch(request, testEnv);
    expect(response.status).toBe(202);
    const data = (await response.json()) as any;
    expect(data).toMatchObject({
      status: "accepted",
      session: "vmlgtm/test-repo-42"
    });
  });

  it("handles valid signed issue_comment.created event when tagged @otto-pi fix", async () => {
    const testEnv: Env = {
      ...env,
      GITHUB_WEBHOOK_SECRET: SECRET
    } as any;

    const payload = JSON.stringify({
      action: "created",
      issue: {
        number: 77,
        title: "Flaky test in auth"
      },
      comment: {
        body: "@otto-pi fix please rerun tests and push fix"
      },
      repository: {
        full_name: "vmlgtm/test-repo"
      }
    });

    const sig = await createHmacSignature(SECRET, payload);
    const request = new Request("http://localhost:8787/api/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "issue_comment",
        "X-Hub-Signature-256": sig
      },
      body: payload
    });

    const response = await server.fetch(request, testEnv);
    expect(response.status).toBe(202);
    const data = (await response.json()) as any;
    expect(data).toMatchObject({
      status: "accepted",
      session: "vmlgtm/test-repo-77"
    });
  });

  it("returns 200 pong on ping event", async () => {
    const testEnv: Env = {
      ...env,
      GITHUB_WEBHOOK_SECRET: SECRET
    } as any;

    const payload = JSON.stringify({ zen: "Responsive is better than fast." });
    const sig = await createHmacSignature(SECRET, payload);

    const request = new Request("http://localhost:8787/api/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "ping",
        "X-Hub-Signature-256": sig
      },
      body: payload
    });

    const response = await server.fetch(request, testEnv);
    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data).toMatchObject({ status: "pong" });
  });
});
