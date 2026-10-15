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

/** Folded text of a tool result, as the model sees it. */
function resultText(message: { content?: unknown } | undefined): string {
  const content = (message?.content ?? []) as { type: string; text?: string }[];
  return content.map((part) => part.text ?? "").join("");
}

describe("Phase 4: shell execution in the session's container", () => {
  it("advertises pi's bash, and no JavaScript-only exec, in the hello catalog", async () => {
    const socket = await connect(crypto.randomUUID());
    const client = follow(socket);
    await client.until(() => client.frames.some((f) => f.type === "hello"));
    const hello = client.frames.find((f) => f.type === "hello") as Extract<PiServerMessage, { type: "hello" }>;

    expect(hello.tools.find((t) => t.name === "exec")).toBeUndefined();
    const bash = hello.tools.find((t) => t.name === "bash");
    expect(bash?.description).toContain("Internet is off");
    expect(bash?.parameters).toMatchObject({
      type: "object",
      properties: expect.objectContaining({
        command: expect.objectContaining({ type: "string" }),
        timeout: expect.objectContaining({ type: "number" })
      })
    });
    expect(hello.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["read", "write", "edit", "ls", "find", "grep", "prepare_workspace", "run_checks"])
    );
    socket.close();
  });

  it("writes a file with pi's write tool and runs it with bash over a WebSocket session", async () => {
    const name = crypto.randomUUID();
    const stub = env.PI_HARNESS_TEST.getByName(name);
    await stub.writeFile("/workspace/calc.js", "let f = 1; for (let i = 1; i <= 6; i++) f *= i; console.log(f);");
    const socket = await connect(name);
    const client = follow(socket);
    await client.until(() => client.frames.some((f) => f.type === "events"));

    socket.send(
      JSON.stringify({
        type: "submit",
        id: "m1",
        input: "Run the factorial script in /workspace/calc.js with bash and explain the result."
      })
    );
    await client.until(() =>
      client.view().messages.some(
        (m) => m.role === "assistant" && m.parts.some((p) => p.type === "text" && p.text.includes("Factorial of 6 is 720"))
      )
    );
    await client.until(() => !client.view().running);
    expect(await stub.commands()).toContain("env -u GITHUB_TOKEN -u GH_TOKEN -u GIT_TOKEN -u GITHUB_APP_PRIVATE_KEY -u GITHUB_WEBHOOK_SECRET -u NPM_TOKEN -u NODE_AUTH_TOKEN GIT_TERMINAL_PROMPT=0 timeout -k 5 600 bash -c node /workspace/calc.js");
    socket.close();
  });

  it("feeds a failing command's output back so the model can correct itself", async () => {
    const socket = await connect(crypto.randomUUID());
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
        (m) => m.role === "assistant" && m.parts.some((p) => p.type === "text" && p.text.includes("Self-correction loop successful"))
      )
    );
    await client.until(() => !client.view().running);
    const failure = client
      .view()
      .messages.flatMap((m) => m.parts)
      .find((p) => p.type === "tool-result" && p.error);
    expect(JSON.stringify(failure)).toContain("AssertionError");
    expect(JSON.stringify(failure)).toContain("Command exited with code 1");
    socket.close();
  });

  it("keeps only the last 50 KB of a large output in the model's context", async () => {
    const name = crypto.randomUUID();
    const stub = env.PI_HARNESS_TEST.getByName(name);
    await stub.prompt("bash: yes | head -c 200000");
    const messages: any[] = await (stub as any).getSessionMessages("1");
    const result = messages.map((entry) => entry.model?.[0]).find((message) => message?.role === "toolResult");
    const text = resultText(result);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(55 * 1024);
    expect(text).toMatch(/truncated/i);
  });
});
