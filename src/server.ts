import { DurableObject } from "cloudflare:workers";
import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { createGitClient } from "@cloudflare/computer/git";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { routeAgentRequest } from "agents";
import {
  PiHarness,
  type PiOperationResult,
  type PiReceipt,
  type PiWhenBusy
} from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { WebSockets } from "agents/websockets";
import { createGitTools } from "./git-tools";
import { createGitHubTools } from "./github-tools";
import { createMcpTools } from "./mcp";
import { PiSessionSockets } from "./sockets";
import { createDelegateTaskTool, SubagentTracker } from "./agents/orchestrator";
import { ASSERT_MODULE, createWorkspaceTools, JAVASCRIPT_BACKEND } from "./workspace";
import type { EgressProps } from "./egress";

export { OttoEgress } from "./egress";

const MODEL_ID = "@cf/qwen/qwen3.8-27b";

const PREAMBLE =
  "You are an autonomous engineering assistant and lead architect. You coordinate specialist subagents ('explorer', 'coder', 'reviewer') via delegate_task. You have a durable workspace at /workspace: read, write, edit, delete, list (ls), find and grep files there, and run JavaScript modules in it with exec. You have native Git tools (git_clone, git_checkout, git_status, git_diff, git_commit, git_push), GitHub integration tools (github_get_issue, github_create_pull_request, github_add_comment), and external MCP tools. Guardrails enforce that pushes to protected branches ('main', 'master', etc.) and force pushes are disabled; all PRs default to draft, and feature branches must follow 'otto/<issue-id>-<short-description>'. Direct remote pushes are prohibited until the reviewer subagent has approved the changes. Use tools whenever they can answer the request, verify changes with tests, and explain their results plainly.";

/**
 * Validates HMAC-SHA256 signature from GitHub webhook against secret.
 */
export async function verifyGitHubSignature(
  secret: string,
  headerSignature: string | null,
  rawBody: string
): Promise<boolean> {
  if (!headerSignature || !headerSignature.startsWith("sha256=")) {
    return false;
  }
  const expectedSig = headerSignature.slice("sha256=".length);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const computedSig = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (expectedSig.length !== computedSig.length) return false;
  let match = 0;
  for (let i = 0; i < expectedSig.length; i++) {
    match |= expectedSig.charCodeAt(i) ^ computedSig.charCodeAt(i);
  }
  return match === 0;
}

/** Playable pi session backed by one Durable Object. */
export class PiAgent extends DurableObject<Env> {
  // Workers AI and AI Gateway over the AI binding, as a pi-ai provider.
  readonly ai = createAI({ binding: this.env.AI });
  // A durable filesystem on the object's SQLite, beside pi's own tables.
  readonly workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    git: createGitClient(),
    backends: this.env.LOADER
      ? [
          new WorkerJavaScriptBackend({
            id: JAVASCRIPT_BACKEND,
            loader: this.env.LOADER,
            root: "/workspace",
            access: "read-write",
            allowGitNetwork: true,
            defaultTimeoutMs: 15_000,
            maxTimeoutMs: 30_000,
            egress: { mode: "none" },
            modules: {
              "node:assert": ASSERT_MODULE,
              assert: ASSERT_MODULE
            }
          })
        ]
      : []
  });
  readonly registry = createRegistry();
  readonly tracker: SubagentTracker = new SubagentTracker(this.ctx.storage, {
    broadcastSubagentStart: (subagent) => this.sockets.broadcastSubagentStart(subagent),
    broadcastSubagentDone: (subagent) => this.sockets.broadcastSubagentDone(subagent)
  });
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const workspaceTools = createWorkspaceTools(this.workspace);
      const gitTools = createGitTools(this.workspace, this.env);
      const gitHubTools = createGitHubTools(this.env);
      let mcpTools: any[] = [];
      try {
        mcpTools = await createMcpTools(this.env);
      } catch (err) {
        console.warn("Could not load MCP tools on startup:", err);
      }

      const allTools = [...workspaceTools, ...gitTools, ...gitHubTools, ...mcpTools];
      const delegateTaskTool = createDelegateTaskTool({
        harness: this.harness,
        workspace: this.workspace,
        allTools,
        tracker: this.tracker,
        defaultModel: this.ai(MODEL_ID)
      });

      this.registry.install({
        name: "playground",
        sections: [{ key: "preamble", render: () => PREAMBLE, tag: false }],
        tools: [delegateTaskTool, ...allTools]
      });

      const models = createModels();
      models.setProvider(this.ai.provider);
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          settings: {
            retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 }
          },
          onReport: (error) => console.warn("pi report", error)
        },
        context
      );
    },
    defaults: { model: this.ai(MODEL_ID), thinkingLevel: "low" }
  });

  // App glue, not the harness: how this app puts sessions on a socket.
  readonly sockets = new PiSessionSockets(
    this.harness,
    this.registry,
    (tag) => this.ctx.getWebSockets(tag),
    this.ai(MODEL_ID),
    [this.env.GITHUB_TOKEN, this.env.GITHUB_APP_PRIVATE_KEY, this.env.GITHUB_WEBHOOK_SECRET],
    this.tracker
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.harness);

  /** Submit a prompt directly to the Durable Object's session harness. */
  async submit(
    text: string,
    options: {
      whenBusy?: PiWhenBusy;
      session?: string;
      operationId?: string;
    } = {}
  ): Promise<PiReceipt> {
    return this.harness.submit(text, options);
  }

  /** Prompt the root session; the result without its transcript. */
  async prompt(text: string): Promise<PiOperationResult> {
    const { messages: _messages, ...result } = await this.harness.prompt(text);
    return result;
  }

  /** Phase 4 spike (DEV_ROUTES only): clone and install ufo through the egress gateway. */
  async spike(step: string): Promise<unknown> {
    const container = this.ctx.container;
    if (!container) return { error: "no ctx.container" };
    const log: unknown[] = [];
    const t = Date.now();
    const run = async (argv: string[], cwd = "/workspace") => {
      const start = Date.now();
      const proc = await container.exec(argv, { cwd });
      const out = await proc.output();
      const dec = new TextDecoder();
      const entry = {
        argv: argv.join(" "),
        exitCode: out.exitCode,
        ms: Date.now() - start,
        stdout: dec.decode(out.stdout).slice(-1500),
        stderr: dec.decode(out.stderr).slice(0, 700) + " ... " + dec.decode(out.stderr).slice(-700)
      };
      log.push(entry);
      return entry;
    };
    const egress = (props: EgressProps) =>
      (this.ctx.exports as any).OttoEgress({ props }) as Fetcher;
    if (step === "status") {
      return { running: container.running, inspect: await container.inspect() };
    }
    if (step === "abort") {
      this.ctx.abort("spike: simulated reset");
    }
    if (step === "probe") {
      const proc = await container.exec(["sh", "-c", "wc -l < /workspace/bg.log; date"]);
      const out = await proc.output();
      return { running: container.running, out: new TextDecoder().decode(out.stdout) };
    }
    if (step === "bg") {
      await container.exec(["sh", "-c", "rm -f /workspace/bg.log; nohup setsid sh -c 'for i in $(seq 1 300); do date >> /workspace/bg.log; sleep 1; done' >/dev/null 2>&1 &"]);
      return { started: true };
    }
    if (step === "snapshot") {
      try {
        const t0 = Date.now();
        const snap = await container.snapshotContainer({ name: "spike" });
        return { snap, ms: Date.now() - t0 };
      } catch (error) {
        return { snapshotError: String(error) };
      }
    }
    if (step.startsWith("restore:")) {
      const t0 = Date.now();
      if (container.running) await container.destroy().catch(() => {});
      container.start({ containerSnapshot: { id: step.slice(8) }, enableInternet: false });
      for (let i = 0; i < 120; i++) {
        try {
          const proc = await container.exec(["sh", "-c", "ls /workspace/ufo/node_modules | wc -l"]);
          const out = await proc.output();
          return { ms: Date.now() - t0, modules: new TextDecoder().decode(out.stdout) };
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      return { error: "restore timed out" };
    }
    if (step === "stop") {
      await container.destroy();
      return { running: container.running };
    }
    if (!container.running) {
      container.start({ image: container.images.workspace, enableInternet: false, instance: "standard-1" });
      log.push({ started: Date.now() - t });
    }
    let exited: unknown;
    container.monitor().then(
      () => (exited = { exited: "ok" }),
      (error) => (exited = { exited: String(error), stack: error?.stack })
    );
    const step_ = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        log.push({ ok: name, at: Date.now() - t });
      } catch (error) {
        log.push({ failed: name, error: String(error), stack: (error as Error)?.stack });
        throw Object.assign(new Error("spike"), { log });
      }
    };
    try {
      await step_("interceptHttps", () => container.interceptOutboundHttps("*", egress({ phase: "setup" })));
      await step_("interceptHttp", () => container.interceptAllOutboundHttp(egress({ phase: "setup" })));
    } catch {
      return { log, running: container.running };
    }
    for (let i = 0; i < 60; i++) {
      try {
        await run(["true"]);
        break;
      } catch (error) {
        if (exited) return { exited, log, running: container.running };
        if (i === 59) return { error: String(error), log, running: container.running };
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    log.push({ ready: Date.now() - t });
    await run(["sh", "-c", "ls -la /etc/cloudflare/certs/ 2>&1; cp $CF_CA /usr/local/share/ca-certificates/cf.crt && update-ca-certificates 2>&1 | tail -1"]);
    if (step === "clone" || step === "all") {
      await run(["rm", "-rf", "/workspace/ufo"]);
      await run(["npm", "--version"]);
      await run(["git", "clone", "--depth=1", "https://github.com/vmlgtm/ufo.git", "/workspace/ufo"]);
    }
    if (step === "install" || step === "all") {
      await run(["pnpm", "install", "--frozen-lockfile"], "/workspace/ufo");
    }
    if (step === "test" || step === "all") {
      await container.interceptOutboundHttps("*", egress({ phase: "locked", repo: "vmlgtm/ufo" }));
      await container.interceptAllOutboundHttp(egress({ phase: "locked", repo: "vmlgtm/ufo" }));
      await run(["pnpm", "exec", "vitest", "run"], "/workspace/ufo");
      await run(["sh", "-c", "curl -sS -m 10 https://registry.npmjs.org/ -o /dev/null -w '%{http_code}' 2>&1; echo; git push origin HEAD:refs/heads/otto/spike 2>&1 | tail -3"], "/workspace/ufo");
      await run(["sh", "-c", "env | grep -i -E 'token|auth|secret' || echo no-credential-env"]);
    }
    await run(["sh", "-c", "du -sh /workspace/ufo 2>/dev/null; free -m | head -2"]);
    return { totalMs: Date.now() - t, log };
  }

  /** Host startup, after the harness has opened pi. */
  async onStart(): Promise<void> {
    try {
      await this.workspace.fs.mkdir("/workspace", { recursive: true });
    } catch {}
    await this.sockets.reattach();
    try {
      await this.harness.session().setModel(this.ai(MODEL_ID));
    } catch (error) {
      console.warn("Could not set default model onStart", error);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/session") {
      // A fresh session id for the client to open its WebSocket against.
      return Response.json({ session: crypto.randomUUID() });
    }

    if (url.pathname === "/api/dev/spike" && env.DEV_ROUTES === "1") {
      const stub = env.PiAgent.get(env.PiAgent.idFromName(url.searchParams.get("name") ?? "spike"));
      return Response.json(await stub.spike(url.searchParams.get("step") ?? "all"));
    }

    // Component C: Secure Webhook Receiver Route
    if (url.pathname === "/api/webhooks/github" && request.method === "POST") {
      const signature = request.headers.get("X-Hub-Signature-256");
      const event = request.headers.get("X-GitHub-Event") ?? "ping";
      const rawBody = await request.text();

      // Guardrail: Validate HMAC signature
      if (!env.GITHUB_WEBHOOK_SECRET) {
        return Response.json({ error: "Webhook secret not configured" }, { status: 401 });
      }

      const isValid = await verifyGitHubSignature(env.GITHUB_WEBHOOK_SECRET, signature, rawBody);
      if (!isValid) {
        return Response.json({ error: "Invalid signature" }, { status: 401 });
      }

      let payload: any;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
      }

      if (event === "ping") {
        return Response.json({ status: "pong" });
      }

      const agentNamespace = env.PiAgent ?? (env as any).PI_HARNESS_TEST;

      // Handle issues.opened or issues.reopened
      if (event === "issues" && (payload.action === "opened" || payload.action === "reopened")) {
        const issue = payload.issue;
        const repo = payload.repository;
        const issueKey = `${repo?.full_name || "repo"}-${issue?.number || crypto.randomUUID()}`;

        if (agentNamespace) {
          const stub = agentNamespace.get(agentNamespace.idFromName(issueKey));
          const prompt = `Triage and resolve GitHub issue #${issue.number} on ${repo?.full_name ?? "the repository"}: "${issue.title}".\n\nIssue Description:\n${issue.body ?? "No description provided."}\n\nExecution steps:\n1. Deconstruct and delegate codebase inspection to explorer specialist.\n2. Delegate bug fix and test verification to coder specialist in /workspace.\n3. Delegate blast radius and diff review to reviewer specialist.\n4. Once reviewer approves, commit changes, push feature branch otto/issue-${issue.number}-fix, and open a draft Pull Request.`;

          try {
            await stub.submit(prompt);
          } catch (err) {
            console.warn("Could not dispatch triage prompt immediately:", err);
          }
        }

        return Response.json({ status: "accepted", session: issueKey }, { status: 202 });
      }

      // Handle issue_comment.created (e.g. tagged @otto-pi fix)
      if (event === "issue_comment" && payload.action === "created") {
        const comment = payload.comment;
        const issue = payload.issue;
        const repo = payload.repository;
        const body = comment?.body ?? "";

        if (body.includes("@otto-pi fix") || body.includes("@otto-pi")) {
          const issueKey = `${repo?.full_name || "repo"}-${issue?.number || crypto.randomUUID()}`;

          if (agentNamespace) {
            const stub = agentNamespace.get(agentNamespace.idFromName(issueKey));
            const prompt = `Autonomous instruction from issue comment on #${issue.number} (${repo?.full_name}):\n"${body}"\n\nPlease coordinate your swarm (explorer, coder, reviewer) to execute the requested fix, verify with tests, audit diff, commit, push, and open or update a draft PR.`;

            try {
              await stub.submit(prompt);
            } catch (err) {
              console.warn("Could not dispatch comment prompt immediately:", err);
            }
          }

          return Response.json({ status: "accepted", session: issueKey }, { status: 202 });
        }
      }

      return Response.json({ status: "ignored", event, action: payload.action });
    }

    try {
      return (
        (await routeAgentRequest(request, env, { cors: true })) ??
        new Response("Not found", { status: 404 })
      );
    } catch (error) {
      console.error("Pi playground request failed", error);
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }
} satisfies ExportedHandler<Env>;
