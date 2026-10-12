import { env } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { describe, expect, it } from "vitest";
import type { PiServerMessage } from "../protocol";
import { EMPTY_VIEW, reduceEvents, type PiSessionView } from "../view";

async function connect(name: string, query = ""): Promise<WebSocket> {
  const response = await routeAgentRequest(
    new Request(`https://example.com/agents/pi-harness-test/${name}${query}`, {
      headers: { Upgrade: "websocket" }
    }),
    env
  );
  expect(response?.status).toBe(101);
  const socket = response!.webSocket as WebSocket;
  socket.accept();
  return socket;
}

function follow(socket: WebSocket) {
  let view: PiSessionView = EMPTY_VIEW;
  const frames: PiServerMessage[] = [];
  const waiters: Array<() => void> = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const message = JSON.parse(event.data) as PiServerMessage | { type: string };
    if (!("type" in message)) return;
    frames.push(message as PiServerMessage);
    if (message.type === "events") {
      view = reduceEvents(
        view,
        (message as Extract<PiServerMessage, { type: "events" }>).events
      );
    }
    for (const waiter of waiters.splice(0)) waiter();
  });
  const until = async (check: () => boolean, timeoutMs = 25_000) => {
    const startTime = Date.now();
    while (!check()) {
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`Condition never held within ${timeoutMs}ms`);
      }
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 25);
      });
    }
  };
  return { view: () => view, frames, until };
}

describe("Phase 1: Sandboxed Code Execution & Guardrails", () => {
  describe("Step 2 & DoD 1: Tool Availability & Schema Inspection", () => {
    it("advertises 'exec' in the hello event tool catalog with valid JSON schema", async () => {
      const name = crypto.randomUUID();
      const socket = await connect(name);
      const client = follow(socket);

      await client.until(() => client.frames.some((f) => f.type === "hello"));
      const hello = client.frames.find((f) => f.type === "hello") as Extract<
        PiServerMessage,
        { type: "hello" }
      >;
      expect(hello).toBeDefined();

      const execTool = hello.tools.find((t) => t.name === "exec");
      expect(execTool).toBeDefined();
      expect(execTool?.description).toContain("Run JavaScript in the workspace");
      expect(execTool?.parameters).toMatchObject({
        type: "object",
        properties: expect.objectContaining({
          command: expect.objectContaining({
            type: "string",
            description: expect.stringContaining("ES module source to run")
          })
        })
      });

      socket.close();
    });
  });

  describe("Step 3 & DoD 2: Happy Path Execution Test", () => {
    it("executes JavaScript, captures stdout, and returns structured result with durationMs", async () => {
      const name = crypto.randomUUID();
      const stub = env.PI_HARNESS_TEST.getByName(name);

      // Write calc.js to /workspace/calc.js
      await stub.writeFile(
        "/workspace/calc.js",
        `export function factorial(n) {
  return n <= 1 ? 1 : n * factorial(n - 1);
}`
      );

      // Verify file was written
      const readContent = await stub.readFile("/workspace/calc.js");
      expect(readContent).toContain("factorial");

      // Execute script that imports calc.js and calculates factorial of 6
      const rawResult = await stub.runExec(`
import { factorial } from "./calc.js";
const result = factorial(6);
console.log(result);
`);

      const result = JSON.parse(rawResult);
      expect(result).toMatchObject({
        exitCode: 0,
        stderr: ""
      });
      expect(result.stdout.trim()).toBe("720");
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("verifies end-to-end happy path interaction over WebSocket session", async () => {
      const name = crypto.randomUUID();
      const socket = await connect(name);
      const client = follow(socket);

      await client.until(() => client.frames.some((f) => f.type === "events"));

      socket.send(
        JSON.stringify({
          type: "submit",
          id: "m1",
          input: "Write a script to /workspace/calc.js that calculates factorial of 6, run it with exec, and explain the result."
        })
      );

      await client.until(() =>
        client.view().messages.some(
          (m) =>
            m.role === "assistant" &&
            m.parts.some(
              (p) =>
                p.type === "text" &&
                p.text.includes("Factorial of 6 is 720")
            )
        )
      );

      await client.until(() => !client.view().running);
      socket.close();
    });
  });

  describe("Step 4 & DoD 3: Self-Correction Loop Test", () => {
    it("captures AssertionError in stderr with exitCode 1 and succeeds after fix", async () => {
      const name = crypto.randomUUID();
      const stub = env.PI_HARNESS_TEST.getByName(name);

      // 1. First run: deliberate failure asserting add(2, 2) === 5
      await stub.writeFile(
        "/workspace/math.js",
        `export function add(a, b) { return a + b; }`
      );

      const failRunRaw = await stub.runExec(`
import { add } from "./math.js";
import assert from "node:assert";
assert.strictEqual(add(2, 2), 5);
`);

      const failResult = JSON.parse(failRunRaw);
      expect(failResult.exitCode).toBe(1);
      expect(failResult.stderr).toContain("AssertionError");

      // 2. Self-correction: fix assertion to add(2, 2) === 4
      const fixRunRaw = await stub.runExec(`
import { add } from "./math.js";
import assert from "node:assert";
assert.strictEqual(add(2, 2), 4);
console.log("All assertions passed!");
`);

      const fixResult = JSON.parse(fixRunRaw);
      expect(fixResult.exitCode).toBe(0);
      expect(fixResult.stdout).toContain("All assertions passed!");
      expect(fixResult.stderr).toBe("");
    });

    it("verifies end-to-end multi-turn self-correction loop over WebSocket session", async () => {
      const name = crypto.randomUUID();
      const socket = await connect(name);
      const client = follow(socket);

      await client.until(() => client.frames.some((f) => f.type === "events"));

      socket.send(
        JSON.stringify({
          type: "submit",
          id: "m2",
          input: "Write a test in /workspace/math.test.js that asserts add(2, 2) === 5. Run it, observe the error, fix the function to add(2, 2) === 4, and re-run until it passes."
        })
      );

      await client.until(() =>
        client.view().messages.some(
          (m) =>
            m.role === "assistant" &&
            m.parts.some(
              (p) =>
                p.type === "text" &&
                p.text.includes("Self-correction loop successful")
            )
        )
      );

      await client.until(() => !client.view().running);
      socket.close();
    });
  });

  describe("Step 5 & DoD 4: Guardrail Stress Tests", () => {
    it("enforces timeout on infinite loop / hanging promise within 15 seconds", async () => {
      const name = crypto.randomUUID();
      const stub = env.PI_HARNESS_TEST.getByName(name);

      const start = Date.now();
      const timeoutRaw = await stub.runExec(`
await new Promise(() => {});
`);
      const elapsed = Date.now() - start;

      const result = JSON.parse(timeoutRaw);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Execution timed out after 15000ms");
      expect(elapsed).toBeLessThanOrEqual(16_000);

      // Verify Durable Object is healthy and can execute subsequent code
      const nextRunRaw = await stub.runExec(`console.log("recovered");`);
      const nextResult = JSON.parse(nextRunRaw);
      expect(nextResult.exitCode).toBe(0);
      expect(nextResult.stdout.trim()).toBe("recovered");
    }, 20_000);

    it("truncates large output (>100KB) at 50KB with truncation warning notice", async () => {
      const name = crypto.randomUUID();
      const stub = env.PI_HARNESS_TEST.getByName(name);

      const bombRaw = await stub.runExec(`
console.log("SPAM_LINE_".repeat(12000));
`);

      const result = JSON.parse(bombRaw);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("[Output truncated at 50KB...]");
      // Output must be capped around 50KB (~51200 bytes + warning notice)
      const encoded = new TextEncoder().encode(result.stdout);
      expect(encoded.byteLength).toBeLessThanOrEqual(52_000);
    });

    it("restricts filesystem escape attempts outside /workspace", async () => {
      const name = crypto.randomUUID();
      const stub = env.PI_HARNESS_TEST.getByName(name);

      // Attempt reading outside /workspace using node:fs/promises
      const escapeRaw = await stub.runExec(`
import fs from "node:fs/promises";
await fs.readFile("/etc/passwd", "utf8");
`);

      const result = JSON.parse(escapeRaw);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("stay under /workspace");

      // Attempt reading relative path outside /workspace
      const escapeParentRaw = await stub.runExec(`
import fs from "node:fs/promises";
await fs.readFile("../etc/passwd", "utf8");
`);

      const parentResult = JSON.parse(escapeParentRaw);
      expect(parentResult.exitCode).toBe(1);
      expect(parentResult.stderr).toContain("stay under /workspace");
    });
  });
});
