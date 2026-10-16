import { DurableObject } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
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
import { interruptLogExtension } from "./interrupted";
import { Sandbox } from "./sandbox";
import { ContainerEnv } from "./container-env";
import {
  createCodingTools,
  createSandboxTools,
  createSearchTools,
  CREDENTIAL_VARIABLES
} from "./container-tools";

export { OttoEgress } from "./egress";

const MODEL_ID = "@cf/qwen/qwen3.8-27b";

/**
 * `OTTO_MODEL` picks a model outside Workers AI, as `<provider>/<id>`; only
 * `opencode/<id>` (OpenCode Zen, key in OPENCODE_API_KEY) is wired. Unset:
 * Workers AI's Qwen through the AI binding. OpenCode calls do not go through
 * AI Gateway, so its spend limits do not apply to them.
 */
function externalModel(spec: string | undefined): { provider: string; id: string } | undefined {
  const match = /^opencode\/(.+)$/.exec(spec?.trim() ?? "");
  return match ? { provider: "opencode", id: match[1] } : undefined;
}

const PREAMBLE =
  "You are an autonomous engineering assistant and lead architect. You coordinate specialist subagents ('explorer', 'coder', 'reviewer') via delegate_task. Work happens in a Linux container for this session: first call prepare_workspace with the repository's clone URL, which clones it into /workspace/<name> and installs its dependencies (internet is on only for that step). Then read, write and edit files, list (ls), find and grep them, and run real commands with bash: the repository's own test runner, git, node, npm, pnpm or yarn. Internet is off for bash; to add a dependency, call prepare_workspace again with an install command. run_checks runs the repository's configured test and lint commands. You have Git tools (git_checkout, git_status, git_diff, git_commit, git_push), GitHub integration tools (github_get_issue, github_create_pull_request, github_add_comment), and external MCP tools. Guardrails enforce that pushes to protected branches ('main', 'master', etc.) and force pushes are disabled; all PRs default to draft, and feature branches must follow 'otto/<issue-id>-<short-description>'. Only git_push can push: a push typed into bash has no credentials. Direct remote pushes are prohibited until the reviewer subagent has approved the changes. Verify every change by running the tests, never by reasoning about them, and show the real test output.";

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
  // The model every session uses: OTTO_MODEL when set, else Workers AI.
  readonly model = externalModel(this.env.OTTO_MODEL) ?? this.ai(MODEL_ID);
  // One container per session, started on first use (src/sandbox.ts).
  readonly sandbox = new Sandbox({
    container: () => this.ctx.container,
    storage: this.ctx.storage,
    egress: (props) => this.ctx.exports.OttoEgress({ props }),
    snapshots: this.env.SANDBOX_SNAPSHOTS === "on"
  });
  readonly registry = createRegistry();
  readonly tracker: SubagentTracker = new SubagentTracker(this.ctx.storage, {
    broadcastSubagentStart: (subagent) => this.sockets.broadcastSubagentStart(subagent),
    broadcastSubagentDone: (subagent) => this.sockets.broadcastSubagentDone(subagent)
  });
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const workspaceTools = [
        ...createCodingTools(this.sandbox),
        ...createSearchTools(this.sandbox),
        ...createSandboxTools(this.sandbox)
      ];
      const gitTools = createGitTools(this.sandbox);
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
        changedFiles: () => this.sandbox.changedFiles(),
        allTools,
        tracker: this.tracker,
        defaultModel: this.model
      });

      this.registry.install(interruptLogExtension(() => this.harness));
      this.registry.install({
        name: "playground",
        sections: [{ key: "preamble", render: () => PREAMBLE, tag: false }],
        tools: [delegateTaskTool, ...allTools]
      });

      // Provider keys come from the Worker's env (secrets), not process.env.
      const models = createModels({
        authContext: {
          env: async (name) => (this.env as unknown as Record<string, string | undefined>)[name],
          fileExists: async () => false
        }
      });
      models.setProvider(this.ai.provider);
      models.setProvider(opencodeProvider());
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          // pi's read, write, edit and bash run on the session's container.
          env: async (target) =>
            new ContainerEnv(this.sandbox, {
              id: `container:${this.ctx.id.toString()}`,
              cwd: target.cwd ?? (await this.sandbox.cwd()),
              unsetEnv: CREDENTIAL_VARIABLES
            }),
          settings: {
            retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 }
          },
          onReport: (error) => console.warn("pi report", error)
        },
        context
      );
    },
    defaults: { model: this.model, thinkingLevel: "low" }
  });

  // App glue, not the harness: how this app puts sessions on a socket.
  readonly sockets = new PiSessionSockets(
    this.harness,
    this.registry,
    (tag) => this.ctx.getWebSockets(tag),
    this.model,
    [
      this.env.GITHUB_TOKEN,
      this.env.GITHUB_APP_PRIVATE_KEY,
      this.env.GITHUB_WEBHOOK_SECRET,
      this.env.OPENCODE_API_KEY
    ],
    this.tracker
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.sandbox)
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

  /** DEV_ROUTES only: drive the sandbox directly, without the model. */
  async devSandbox(op: string, arg: string): Promise<unknown> {
    switch (op) {
      case "prepare":
        return this.sandbox.prepare(arg);
      case "run":
        return this.sandbox.run(JSON.parse(arg) as string[], { cwd: await this.sandbox.cwd() });
      case "status":
        return { running: this.ctx.container?.running ?? false, workspace: await this.sandbox.workspace() };
      case "stop":
        await this.sandbox.stop();
        return { running: this.ctx.container?.running ?? false };
      case "conformance":
        return (await import("./dev-conformance")).runConformance(this.sandbox, arg || undefined);
      case "abort":
        this.ctx.abort("dev: simulated reset");
        return null;
      default:
        throw new Error(`unknown op ${op}`);
    }
  }

  /** Host startup, after the harness has opened pi. */
  async onStart(): Promise<void> {
    await this.sockets.reattach();
    try {
      await this.harness.session().setModel(this.model);
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

    if (url.pathname === "/api/dev/conformance" && request.method === "POST" && env.DEV_ROUTES === "1") {
      const stub = env.PiAgent.get(env.PiAgent.idFromName(url.searchParams.get("name") ?? "conformance"));
      return Response.json(await stub.devSandbox("conformance", url.searchParams.get("filter") ?? ""));
    }

    if (url.pathname === "/api/dev/sandbox" && env.DEV_ROUTES === "1") {
      const stub = env.PiAgent.get(env.PiAgent.idFromName(url.searchParams.get("name") ?? "dev"));
      try {
        return Response.json(
          await stub.devSandbox(url.searchParams.get("op") ?? "status", url.searchParams.get("arg") ?? "")
        );
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
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
          const prompt = `Triage and resolve GitHub issue #${issue.number} on ${repo?.full_name ?? "the repository"}: "${issue.title}".\n\nIssue Description:\n${issue.body ?? "No description provided."}\n\nExecution steps:\n0. Call prepare_workspace with https://github.com/${repo?.full_name}.git.\n1. Deconstruct and delegate codebase inspection to explorer specialist.\n2. Delegate bug fix and test verification to coder specialist, with a failing test first and real test runs.\n3. Delegate blast radius and diff review to reviewer specialist.\n4. Once reviewer approves, commit changes, push feature branch otto/issue-${issue.number}-fix, and open a draft Pull Request.`;

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
