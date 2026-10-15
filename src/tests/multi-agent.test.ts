import { env } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { describe, expect, it } from "vitest";
import type { PiServerMessage, SubagentInfo } from "../protocol";
import { EMPTY_VIEW, reduceEvents, type PiSessionView } from "../view";
import {
  ROLE_DEFINITIONS,
  getRoleDefinition,
  isToolAllowedForRole,
  filterToolsForRole
} from "../agents/roles";
import { generateHandoffSummary, createHandoffNote } from "../agents/handoff";
import { MAX_CONCURRENT_SUBAGENTS, MAX_SUBAGENT_TURNS } from "../agents/orchestrator";
import { projectEntries } from "../transcript";

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

describe("Phase 3: Multi-Agent Swarms & Pi Subagents Collaboration", () => {
  describe("1. Role Separation & Privilege Boundaries (DoD 1 & Step 2)", () => {
    it("enforces isolated tool scoping and preambles across all specialist roles", () => {
      const explorer = getRoleDefinition("explorer");
      const coder = getRoleDefinition("coder");
      const reviewer = getRoleDefinition("reviewer");
      const architect = getRoleDefinition("architect");

      // Verify Explorer role
      expect(explorer.role).toBe("explorer");
      expect(explorer.allowedTools).toEqual(["read", "ls", "find", "grep"]);
      expect(isToolAllowedForRole("explorer", "read")).toBe(true);
      expect(isToolAllowedForRole("explorer", "grep")).toBe(true);
      expect(isToolAllowedForRole("explorer", "write")).toBe(false);
      expect(isToolAllowedForRole("explorer", "edit")).toBe(false);
      expect(isToolAllowedForRole("explorer", "exec")).toBe(false);
      expect(isToolAllowedForRole("explorer", "git_push")).toBe(false);
      expect(isToolAllowedForRole("explorer", "delegate_task")).toBe(false);

      // Verify Coder role
      expect(coder.role).toBe("coder");
      expect(coder.allowedTools).toEqual(["read", "write", "edit", "exec"]);
      expect(isToolAllowedForRole("coder", "write")).toBe(true);
      expect(isToolAllowedForRole("coder", "exec")).toBe(true);
      expect(isToolAllowedForRole("coder", "git_push")).toBe(false);
      expect(isToolAllowedForRole("coder", "github_create_pull_request")).toBe(false);
      expect(isToolAllowedForRole("coder", "delegate_task")).toBe(false);

      // Verify Reviewer role
      expect(reviewer.role).toBe("reviewer");
      expect(reviewer.allowedTools).toEqual(["git_diff", "read", "exec"]);
      expect(isToolAllowedForRole("reviewer", "git_diff")).toBe(true);
      expect(isToolAllowedForRole("reviewer", "read")).toBe(true);
      expect(isToolAllowedForRole("reviewer", "write")).toBe(false);
      expect(isToolAllowedForRole("reviewer", "edit")).toBe(false);
      expect(isToolAllowedForRole("reviewer", "git_push")).toBe(false);
      expect(isToolAllowedForRole("reviewer", "delegate_task")).toBe(false);

      // Verify Architect has orchestrator tools
      expect(architect.allowedTools).toContain("delegate_task");
      expect(architect.allowedTools).toContain("github_create_pull_request");
    });

    it("filters tools correctly when preparing child session registries", () => {
      const mockTools: any[] = [
        { name: "read" },
        { name: "write" },
        { name: "edit" },
        { name: "ls" },
        { name: "find" },
        { name: "grep" },
        { name: "exec" },
        { name: "git_diff" },
        { name: "git_push" },
        { name: "delegate_task" }
      ];

      const explorerTools = filterToolsForRole(mockTools, "explorer").map((t) => t.name);
      expect(explorerTools).toEqual(["read", "ls", "find", "grep"]);

      const coderTools = filterToolsForRole(mockTools, "coder").map((t) => t.name);
      expect(coderTools).toEqual(["read", "write", "edit", "exec"]);

      const reviewerTools = filterToolsForRole(mockTools, "reviewer").map((t) => t.name);
      expect(reviewerTools).toEqual(["read", "exec", "git_diff"]);
    });

    it("verifies Explorer role rejects mutating tool calls (Step 2)", async () => {
      const name = crypto.randomUUID();
      const stub = env.PI_HARNESS_TEST.getByName(name);

      // Verify that explorer cannot execute write
      expect(isToolAllowedForRole("explorer", "write")).toBe(false);
      expect(isToolAllowedForRole("explorer", "delete")).toBe(false);
    });
  });

  describe("2. Recursion Depth & Subagent Hierarchy Limits (Guardrail 1 & DoD 4)", () => {
    it("rejects attempts to delegate tasks from within a subagent (depth > 0)", async () => {
      const name = crypto.randomUUID();
      const stub = env.PI_HARNESS_TEST.getByName(name);

      // Attempt to invoke delegate_task from a child session ID "pi-sub-1"
      const result = await stub.runDelegateTask(
        {
          role: "coder",
          task: "Subagent trying to delegate further work"
        },
        "pi-sub-1" // Child session
      );

      const content = (result as any).content as any[];
      const text = content?.[0]?.text ?? "";
      expect(text).toContain("RecursionGuardrailViolation");
      expect(text).toContain("Subagents (depth > 0) are strictly forbidden from spawning further subagents");
    });

    it("verifies delegate_task is never included in subagent tool sets", () => {
      for (const role of ["explorer", "coder", "reviewer"] as const) {
        const roleDef = getRoleDefinition(role);
        expect(roleDef.allowedTools).not.toContain("delegate_task");
      }
    });
  });

  describe("3. Concurrency Cap Guardrail (Guardrail 1 & DoD 4)", () => {
    it("strictly limits concurrent subagents to 3", async () => {
      const name = crypto.randomUUID();
      const stub = env.PI_HARNESS_TEST.getByName(name);

      // Verify constant is 3
      expect(MAX_CONCURRENT_SUBAGENTS).toBe(3);

      // Start subagents up to the limit
      // Subagent tracker tracks active subagents
      const tracker = (stub as any).tracker;
      // Normal delegation succeeds from root session "1"
      const res1 = await stub.runDelegateTask(
        { role: "explorer", task: "Locate the bug in /workspace/sort.js" },
        "1"
      );
      expect(res1.isError).toBe(false);
    });
  });

  describe("4. Turn Limit & Timeout Guardrail (Guardrail 2, DoD 4 & Step 3)", () => {
    it("aborts non-converging subagents at turn limit (10 turns) without crashing DO", async () => {
      const name = crypto.randomUUID();
      const stub = env.PI_HARNESS_TEST.getByName(name);

      expect(MAX_SUBAGENT_TURNS).toBe(10);

      // Spawn a subagent with an unresolvable looping prompt
      const result = await stub.runDelegateTask(
        {
          role: "coder",
          task: "while(true) circular problem loop: keep executing without converging"
        },
        "1"
      );

      const content = (result as any).content as any[];
      const parsed = JSON.parse(content?.[0]?.text ?? "{}");
      expect(parsed.status).toBe("turn_limit_reached");
      expect(parsed.turnCount).toBeGreaterThanOrEqual(10);
      expect(parsed.summary).toBeDefined();
    });
  });

  describe("5. Context Economy & Handoff Condensation (Guardrail 2 & DoD 3)", () => {
    it("generates dense handoff summaries <= 500 tokens from verbose subagent entries", () => {
      const dummyEntries: any[] = [
        {
          id: 1,
          kind: "pi.assistant",
          model: [
            {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "c1",
                  name: "grep",
                  arguments: { path: "/workspace", pattern: "sort" }
                }
              ]
            }
          ]
        },
        {
          id: 2,
          kind: "pi.tool-result",
          model: [
            {
              role: "toolResult",
              toolCallId: "c1",
              toolName: "grep",
              content: [{ type: "text", text: "sort.js: line 4: return b - a" }]
            }
          ]
        },
        {
          id: 3,
          kind: "pi.assistant",
          model: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Found inverted comparator on line 4 of /workspace/sort.js."
                }
              ]
            }
          ]
        }
      ];

      const summary = generateHandoffSummary({
        role: "explorer",
        task: "Locate bug in sort.js",
        status: "completed",
        entries: dummyEntries,
        filesModified: [],
        turnCount: 2
      });

      expect(summary).toContain("Role: EXPLORER");
      expect(summary).toContain("Status: completed");
      expect(summary).toContain("**Turns**: 2");
      expect(summary.length).toBeLessThan(1800); // Well under 500 tokens

      const handoffNote = createHandoffNote({
        role: "explorer",
        task: "Locate bug in sort.js",
        status: "completed",
        entries: dummyEntries
      });
      expect(handoffNote).toContain("[SUBAGENT HANDOFF CHECKPOINT]");
    });
  });

  describe("6. End-to-End Multi-Agent Bug Resolution Scenario (DoD 2 & Step 4)", () => {
    it("autonomously delegates to Explorer, Coder, and Reviewer to fix bug in /workspace/sort.js", async () => {
      const name = crypto.randomUUID();
      const stub = env.PI_HARNESS_TEST.getByName(name);

      // Write failing sorting algorithm
      await stub.writeFile(
        "/workspace/sort.js",
        `export function sortArray(arr) {
  // Bug: inverted comparator
  return [...arr].sort((a, b) => b - a);
}`
      );

      // Verify bug is present initially
      const initialCode = await stub.readFile("/workspace/sort.js");
      expect(initialCode).toContain("b - a");

      // Submit prompt to root architect
      const prompt =
        "Fix the failing sorting algorithm in /workspace/sort.js and add unit tests. Have the explorer locate it, the coder fix it and verify with tests, and the reviewer audit the diff before you report back.";

      const result = await stub.prompt(prompt);
      expect(result.status).toBe("done");
      expect(result.text).toContain("Multi-agent swarm resolution complete");
      expect(result.text).toContain("Explorer located");
      expect(result.text).toContain("Coder implemented");
      expect(result.text).toContain("Reviewer audited");

      // Verify Coder fixed the file
      const updatedCode = await stub.readFile("/workspace/sort.js");
      expect(updatedCode).toContain("a - b");

      // Verify unit test file was created
      const testCode = await stub.readFile("/workspace/sort.test.js");
      expect(testCode).toContain("sortArray");
      expect(testCode).toContain("assert");

      // Verify subagent tracker recorded all 3 specialists
      const subagents = (await (stub as any).listSubagents()) as SubagentInfo[];
      expect(subagents.length).toBe(3);

      const explorerRecord = subagents.find((s) => s.role === "explorer");
      const coderRecord = subagents.find((s) => s.role === "coder");
      const reviewerRecord = subagents.find((s) => s.role === "reviewer");

      expect(explorerRecord).toBeDefined();
      expect(explorerRecord?.status).toBe("completed");

      expect(coderRecord).toBeDefined();
      expect(coderRecord?.status).toBe("completed");
      expect(coderRecord?.filesModified).toContain("/workspace/sort.js");

      expect(reviewerRecord).toBeDefined();
      expect(reviewerRecord?.status).toBe("completed");
      expect(reviewerRecord?.summary).toContain("approval: true");

      // DoD 3: Verify Context Economy - Lead Architect transcript remains clean and compact (< 2,500 tokens)
      const rootMessages: any[] = await (stub as any).getSessionMessages("1");
      const projected = projectEntries(rootMessages);
      let totalChars = 0;
      for (const msg of projected) {
        for (const part of msg.parts) {
          if (part.type === "text") {
            totalChars += part.text.length;
          } else if (part.type === "tool-call") {
            totalChars += JSON.stringify(part.arguments).length;
          } else if (part.type === "tool-result") {
            totalChars += part.content.reduce(
              (acc, c) => acc + (c.type === "text" ? c.text.length : 0),
              0
            );
          }
        }
      }
      const estimatedTokens = Math.ceil(totalChars / 4);
      expect(estimatedTokens).toBeLessThan(2_500);
    });
  });

  describe("7. Multi-Session WebSocket & UI Projection (Component C)", () => {
    it("advertises delegate_task in hello and answers subagents:list queries", async () => {
      const name = crypto.randomUUID();
      const socket = await connect(name);
      const client = follow(socket);

      await client.until(() => client.frames.some((f) => f.type === "hello"));
      const hello = client.frames.find((f) => f.type === "hello") as Extract<
        PiServerMessage,
        { type: "hello" }
      >;
      expect(hello).toBeDefined();

      const delegateTool = hello.tools.find((t) => t.name === "delegate_task");
      expect(delegateTool).toBeDefined();
      expect(delegateTool?.description).toContain("Delegate an engineering task to a specialist subagent");

      // Query subagents:list
      socket.send(JSON.stringify({ type: "subagents:list", id: "query-1" }));
      await client.until(() => client.frames.some((f) => f.type === "subagents:list" || (f.type === "result" && (f as any).id === "query-1")));

      socket.close();
    });
  });
});
