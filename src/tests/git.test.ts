import { env } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitTools, parseStatus } from "../git-tools";
import { createGitHubTools, fetchWithBackoff } from "../github-tools";
import { Sandbox } from "../sandbox";
import { FakeContainer, fakeEgress, memoryStorage, ufoReplies, unwrap } from "./fake-container";

/** git tools on a fake container with ufo prepared; `reply` answers git commands. */
async function gitOnFake(reply: (argv: readonly string[]) => { exitCode?: number; stdout?: string; stderr?: string } = () => ({})) {
  const container = new FakeContainer();
  container.reply = ufoReplies;
  const sandbox = new Sandbox({ container: () => container, storage: memoryStorage(), egress: fakeEgress, snapshots: false });
  await sandbox.prepare("https://github.com/vmlgtm/ufo.git");
  container.reply = (argv) => {
    const git = argv[0] === "git" ? argv.filter((arg, i) => !(i > 0 && (arg === "-c" || argv[i - 1] === "-c"))) : argv;
    return reply(git);
  };
  const tools = createGitTools(sandbox);
  const run = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === name)!;
    const result = await tool.execute(args as never, { callId: "g" } as never, {} as never);
    return { text: (result.content ?? []).map((part: any) => part.text).join(""), isError: Boolean(result.isError) };
  };
  const last = () => unwrap(container.execs.at(-1)!.argv);
  return { container, run, last, tools };
}
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
    stub = env.PI_HARNESS_TEST.getByName(crypto.randomUUID());
  });

  describe("Native Git Automation (DoD 1), over real git in the container", () => {
    it("inspects status and the unified diff, including files git does not track yet", async () => {
      const { run, container } = await gitOnFake((argv) => {
        if (argv[1] === "status") return { stdout: "## otto/issue-1-fix\n M README.md\n?? notes.md\n" };
        if (argv[1] === "ls-files") return { stdout: "notes.md\0" };
        if (argv[1] === "diff" && argv.includes("--no-index")) return { exitCode: 1, stdout: "+++ b/notes.md\n+new file\n" };
        if (argv[1] === "diff") return { stdout: "--- a/README.md\n+++ b/README.md\n+Updated line.\n" };
        return {};
      });
      const status = await run("git_status", {});
      expect(JSON.parse(status.text)).toEqual({
        dir: "/workspace/ufo",
        branch: "otto/issue-1-fix",
        status: [
          { index: " ", worktree: "M", path: "README.md" },
          { index: "?", worktree: "?", path: "notes.md" }
        ]
      });
      const diff = await run("git_diff", {});
      expect(diff.isError).toBe(false);
      expect(diff.text).toContain("+Updated line.");
      expect(diff.text).toContain("+new file");
      const commands = container.execs.map((exec) => unwrap(exec.argv).join(" "));
      expect(commands).toContain("git -c core.quotepath=false diff HEAD --");
      expect(commands).toContain("git -c core.quotepath=false diff --no-index -- /dev/null notes.md");
    });

    it("creates feature branch adhering to otto/<issue-id>-<short-description>", async () => {
      const { run, last } = await gitOnFake();
      const result = await run("git_checkout", { branch: "otto/issue-1-fix-typo", create: true });
      expect(result.isError).toBe(false);
      expect(last()).toEqual(["git", "-c", "core.quotepath=false", "checkout", "-b", "otto/issue-1-fix-typo"]);
    });

    it("commits modified files with structured commit message and bot identity", async () => {
      const { run, container } = await gitOnFake((argv) =>
        argv[1] === "rev-parse" ? { stdout: "abc123\n" } : {}
      );
      const result = await run("git_commit", { message: "fix: resolve typo in README" });
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.text)).toEqual({ oid: "abc123", message: "fix: resolve typo in README", dir: "/workspace/ufo" });
      const commit = container.execs.map((exec) => unwrap(exec.argv)).find((argv) => argv.includes("commit"))!;
      expect(commit).toEqual([
        "git", "-c", "core.quotepath=false",
        "-c", "user.name=otto-pi[bot]",
        "-c", "user.email=otto-pi[bot]@users.noreply.github.com",
        "commit", "--no-verify", "-m", "fix: resolve typo in README"
      ]);
    });

    it("reads a relative dir as relative to /workspace, as the earlier tools did", async () => {
      const { run, container } = await gitOnFake();
      await run("git_checkout", { branch: "otto/issue-1-fix", create: true, dir: "ufo" });
      await run("git_status", { dir: "." });
      expect(container.execs.slice(-2).map((exec) => exec.cwd)).toEqual(["/workspace/ufo", "/workspace/ufo"]);
    });

    it("keeps git inside /workspace and refuses refs that read as options", async () => {
      const { run } = await gitOnFake();
      expect((await run("git_status", { dir: "/etc" })).text).toContain("dir must be inside /workspace");
      expect((await run("git_status", { dir: "../etc" })).text).toContain("dir must be inside /workspace");
      expect((await run("git_diff", { ref: "--output=/tmp/x" })).text).toContain("must not start with '-'");
    });

    it("pushes with a one-branch grant from the egress gateway, then takes it back", async () => {
      let grant: unknown;
      const { run, container, last } = await gitOnFake((argv) => {
        if (argv[1] === "push") grant = container.egress;
        return {};
      });
      const result = await run("git_push", { branch: "otto/issue-1-fix" });
      expect(result.isError).toBe(false);
      expect(last()).toEqual([
        "git", "-c", "core.quotepath=false", "-c", "credential.helper=",
        "push", "--porcelain", "origin", "refs/heads/otto/issue-1-fix:refs/heads/otto/issue-1-fix"
      ]);
      expect(grant).toEqual({ phase: "locked", repo: "vmlgtm/ufo", push: { repo: "vmlgtm/ufo", branch: "otto/issue-1-fix" } });
      expect(container.egress).toEqual({ phase: "locked", repo: "vmlgtm/ufo" });
    });

    it("parses porcelain status lines", () => {
      expect(parseStatus("## main\nA  src/new.ts\n D gone.ts\n")).toEqual([
        { index: "A", worktree: " ", path: "src/new.ts" },
        { index: " ", worktree: "D", path: "gone.ts" }
      ]);
    });

    it("no longer offers git_clone: prepare_workspace owns cloning", async () => {
      const { tools } = await gitOnFake();
      expect(tools.map((t) => t.name)).toEqual(["git_checkout", "git_status", "git_diff", "git_commit", "git_push"]);
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
      const commands: string[] = await testStub.commands();
      expect(commands.some((c) => c.includes("git clone --depth=1 https://github.com/vmlgtm/ufo.git /workspace/ufo"))).toBe(true);
      expect(commands.some((c) => c.includes("push --porcelain origin refs/heads/otto/issue-1-fix-typo"))).toBe(true);
      expect(await testStub.readFile("/workspace/ufo/README.md")).toContain("Fixed typo");
      socket.close();
    });
  });
});
