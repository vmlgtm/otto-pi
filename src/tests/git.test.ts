import { env } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubTools, fetchWithBackoff } from "../github-tools";
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

describe("Component A & DoD 1, 2, 4, 5: Git & GitHub Automation Tools with Security Guardrails", () => {
  let stub: any;

  beforeEach(async () => {
    const name = crypto.randomUUID();
    stub = env.PI_HARNESS_TEST.getByName(name);
    await stub.gitInit("/workspace/repo", "main");
    await stub.writeFile("/workspace/repo/README.md", "# Test Repo\n");
    await stub.runTool("git_commit", {
      dir: "/workspace/repo",
      message: "Initial commit"
    });
  });

  describe("Native Git Automation (DoD 1)", () => {
    it("inspects status and unified diff of modified files", async () => {
      // 1. Initial status
      const initialStatus = await stub.runTool("git_status", { dir: "/workspace/repo" });
      expect(initialStatus.isError).toBe(false);

      // 2. Modify README.md
      await stub.writeFile("/workspace/repo/README.md", "# Test Repo\nUpdated line.\n");

      // 3. Inspect diff
      const diffRes = await stub.runTool("git_diff", { dir: "/workspace/repo" });
      expect(diffRes.isError).toBe(false);
      const diffText = diffRes.content[0]?.text;
      expect(diffText).toContain("+Updated line.");
    });

    it("creates feature branch adhering to otto/<issue-id>-<short-description>", async () => {
      const checkoutRes = await stub.runTool("git_checkout", {
        dir: "/workspace/repo",
        branch: "otto/issue-1-fix-typo",
        create: true
      });
      expect(checkoutRes.isError).toBe(false);

      const branch = await stub.getGitCurrentBranch("/workspace/repo");
      expect(branch).toBe("otto/issue-1-fix-typo");
    });

    it("commits modified files with structured commit message and bot identity", async () => {
      await stub.writeFile("/workspace/repo/README.md", "# Test Repo\nFixing typo.\n");

      const commitRes = await stub.runTool("git_commit", {
        dir: "/workspace/repo",
        message: "fix: resolve typo in README"
      });

      expect(commitRes.isError).toBe(false);
      const parsed = JSON.parse(commitRes.content[0]?.text);
      expect(parsed.oid).toBeDefined();
      expect(parsed.message).toBe("fix: resolve typo in README");
    });
  });

  describe("Step 4 & DoD 5: Guardrail Enforcement (Protected Branch, Force Push, Branch Name)", () => {
    it("aborts when branch name does not match otto/<issue-id>-<short-description>", async () => {
      const invalidRes = await stub.runTool("git_checkout", {
        dir: "/workspace/repo",
        branch: "feat/some-random-branch",
        create: true
      });

      expect(invalidRes.isError).toBe(true);
      const text = invalidRes.content[0]?.text;
      expect(text).toContain("GuardrailViolation: Branch name must follow the pattern 'otto/<issue-id>-<short-description>'");
    });

    it("aborts when attempting force push (force: true)", async () => {
      const forceRes = await stub.runTool("git_push", {
        dir: "/workspace/repo",
        branch: "otto/issue-1-fix",
        force: true
      });

      expect(forceRes.isError).toBe(true);
      const text = forceRes.content[0]?.text;
      expect(text).toBe("GuardrailViolation: Force pushes are disabled");
    });

    it("aborts when attempting direct push to protected branch 'main'", async () => {
      const mainRes = await stub.runTool("git_push", {
        dir: "/workspace/repo",
        branch: "main"
      });

      expect(mainRes.isError).toBe(true);
      const text = mainRes.content[0]?.text;
      expect(text).toBe("GuardrailViolation: Direct pushes to protected branch 'main' are disabled");
    });

    it("aborts when attempting direct push to protected branch 'master' or 'release'", async () => {
      const masterRes = await stub.runTool("git_push", {
        dir: "/workspace/repo",
        branch: "master"
      });
      expect(masterRes.isError).toBe(true);
      expect(masterRes.content[0]?.text).toBe("GuardrailViolation: Direct pushes to protected branch 'master' are disabled");

      const releaseRes = await stub.runTool("git_push", {
        dir: "/workspace/repo",
        branch: "release"
      });
      expect(releaseRes.isError).toBe(true);
      expect(releaseRes.content[0]?.text).toBe("GuardrailViolation: Direct pushes to protected branch 'release' are disabled");
    });

    it("aborts when attempting direct push to non-otto branch", async () => {
      const nonOttoRes = await stub.runTool("git_push", {
        dir: "/workspace/repo",
        branch: "feature/auth-refactor"
      });

      expect(nonOttoRes.isError).toBe(true);
      expect(nonOttoRes.content[0]?.text).toContain(
        "GuardrailViolation: Direct pushes to non-otto branch 'feature/auth-refactor' are disabled. Branch name must start with 'otto/'"
      );
    });

    it("verifies WebSocket agent interaction for protected branch rejection test (Step 4)", async () => {
      const name = crypto.randomUUID();
      const socket = await connect(name);
      const client = follow(socket);

      await client.until(() => client.frames.some((f) => f.type === "events"));

      socket.send(
        JSON.stringify({
          type: "submit",
          id: "m-protected",
          input: "Commit this change directly to `main` and force push."
        })
      );

      await client.until(() =>
        client.view().messages.some(
          (m) =>
            m.role === "assistant" &&
            m.parts.some(
              (p) =>
                p.type === "text" &&
                p.text.includes("GuardrailViolation: Direct pushes to protected branch 'main' are disabled")
            )
        )
      );

      await client.until(() => !client.view().running);
      socket.close();
    });
  });

  describe("GitHub API Client Tools (DoD 2)", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("github_get_issue fetches issue details and caps comments at 10 items", async () => {
      const githubTools = createGitHubTools({ GITHUB_TOKEN: "ghp_mocktoken" });
      const getIssueTool = githubTools.find((t) => t.name === "github_get_issue")!;

      vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes("/comments")) {
          const comments = Array.from({ length: 15 }, (_, i) => ({
            id: i + 1,
            user: { login: `user${i + 1}` },
            body: `Comment ${i + 1}`,
            created_at: "2026-10-12T00:00:00Z"
          }));
          return new Response(JSON.stringify(comments), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            number: 42,
            title: "Fix bug in parser",
            body: "Parser throws on empty line",
            state: "open",
            html_url: "https://github.com/vmlgtm/test-repo/issues/42",
            labels: [{ name: "bug" }]
          }),
          { status: 200 }
        );
      });

      const res = await getIssueTool.execute(
        { repo: "vmlgtm/test-repo", issue_number: 42 },
        {} as any,
        {} as any
      );

      expect(res.isError).toBe(false);
      const data = JSON.parse((res.content![0] as any).text);
      expect(data.number).toBe(42);
      expect(data.title).toBe("Fix bug in parser");
      expect(data.labels).toEqual(["bug"]);
      expect(data.comments).toHaveLength(10);
      expect(data.comments[0].body).toBe("Comment 1");
    });

    it("github_create_pull_request defaults to draft: true and validates branch", async () => {
      const githubTools = createGitHubTools({ GITHUB_TOKEN: "ghp_mocktoken" });
      const createPrTool = githubTools.find((t) => t.name === "github_create_pull_request")!;

      // 1. Invalid branch rejection
      const invalidBranchRes = await createPrTool.execute(
        { repo: "vmlgtm/test-repo", title: "Fix bug", head: "patch-1" },
        {} as any,
        {} as any
      );
      expect(invalidBranchRes.isError).toBe(true);
      expect((invalidBranchRes.content![0] as any).text).toContain(
        "GuardrailViolation: Head branch 'patch-1' must follow the pattern 'otto/<issue-id>-<short-description>'"
      );

      // 2. Successful creation with draft: true default
      let sentBody: any;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url: any, init: any) => {
        sentBody = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            number: 10,
            html_url: "https://github.com/vmlgtm/test-repo/pull/10",
            title: sentBody.title,
            state: "open",
            draft: sentBody.draft
          }),
          { status: 201 }
        );
      });

      const validRes = await createPrTool.execute(
        {
          repo: "vmlgtm/test-repo",
          title: "fix: parser bug",
          head: "otto/issue-42-fix-parser",
          body: "Fixes #42 with unit test proof"
        },
        {} as any,
        {} as any
      );

      expect(validRes.isError).toBe(false);
      expect(sentBody.draft).toBe(true);
      const data = JSON.parse((validRes.content![0] as any).text);
      expect(data.number).toBe(10);
      expect(data.draft).toBe(true);
      expect(data.html_url).toBe("https://github.com/vmlgtm/test-repo/pull/10");
    });

    it("github_add_comment posts comment to issue", async () => {
      const githubTools = createGitHubTools({ GITHUB_TOKEN: "ghp_mocktoken" });
      const addCommentTool = githubTools.find((t) => t.name === "github_add_comment")!;

      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            id: 999,
            html_url: "https://github.com/vmlgtm/test-repo/issues/42#issuecomment-999",
            body: body.body
          }),
          { status: 201 }
        );
      });

      const res = await addCommentTool.execute(
        { repo: "vmlgtm/test-repo", issue_number: 42, body: "Triage completed, tests passing." },
        {} as any,
        {} as any
      );

      expect(res.isError).toBe(false);
      const data = JSON.parse((res.content![0] as any).text);
      expect(data.id).toBe(999);
      expect(data.body).toBe("Triage completed, tests passing.");
    });

    it("throttling: exponential backoff retries on 403 / 429 rate limit exceeded", async () => {
      let attempts = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        attempts++;
        if (attempts === 1) {
          return new Response("rate limit exceeded", { status: 429 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      const res = await fetchWithBackoff("https://api.github.com/test", {}, 2, 10);
      expect(res.status).toBe(200);
      expect(attempts).toBe(2);
    });
  });

  describe("End-to-End Autonomous Issue-to-PR Flow (DoD 4 & Verification Step 3)", () => {
    it("autonomously executes issue resolution, branch checkout, commit, push, and PR creation", async () => {
      const name = crypto.randomUUID();
      const testStub = env.PI_HARNESS_TEST.getByName(name);
      await testStub.gitInit("/workspace/test-repo", "main");
      await testStub.writeFile("/workspace/test-repo/README.md", "# Test Repo\n");
      await testStub.runTool("git_commit", {
        dir: "/workspace/test-repo",
        message: "Initial commit"
      });

      const socket = await connect(name);
      const client = follow(socket);

      await client.until(() => client.frames.some((f) => f.type === "events"));

      socket.send(
        JSON.stringify({
          type: "submit",
          id: "m-issue-pr",
          input: "Resolve issue #1 on repo vmlgtm/test-repo: Fix typo in README.md. Create a branch, commit the fix, and open a draft PR."
        })
      );

      await client.until(() =>
        client.view().messages.some(
          (m) =>
            m.role === "assistant" &&
            m.parts.some(
              (p) =>
                p.type === "text" &&
                p.text.includes("Pull Request created successfully: https://github.com/vmlgtm/test-repo/pull/1")
            )
        )
      );

      await client.until(() => !client.view().running);
      socket.close();
    });
  });
});
