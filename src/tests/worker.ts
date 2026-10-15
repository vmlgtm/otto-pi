import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  Type,
  type AssistantMessage,
  type Message,
  type TranscriptContext
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  type AgentEvent,
  type Extension,
  type ToolRegistration
} from "@earendil-works/pi-durable";
import { DurableObject } from "cloudflare:workers";
import {
  PiHarness,
  type PiOperationResult,
  type PiReceipt,
  type PiWhenBusy
} from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { PiSessionSockets } from "../sockets";
import { EMPTY_VIEW, reduceEvents } from "../view";
import { ContainerEnv } from "../container-env";
import {
  createCodingTools,
  createSandboxTools,
  createSearchTools,
  CREDENTIAL_VARIABLES
} from "../container-tools";
import { createGitTools } from "../git-tools";
import { Sandbox } from "../sandbox";
import { FakeContainer, fakeEgress, type FakeReply } from "./fake-container";
import { createGitHubTools } from "../github-tools";
import { createDelegateTaskTool, SubagentTracker } from "../agents/orchestrator";
import { interruptLogExtension } from "../interrupted";
import { type AgentRole, getRoleDefinition, filterToolsForRole } from "../agents/roles";

const RELEASE_KEY = "test:gate:release";
const GATE_RUNS_KEY = "test:gate:runs";

function textOf(content: Message["content"] | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      "text" in part && typeof part.text === "string" ? part.text : ""
    )
    .join("");
}

/**
 * The faux model's script, derived from the transcript alone so it gives
 * the same answer after an eviction as before it.
 */
function script(context: TranscriptContext): AssistantMessage {
  const nonSystem = context.messages.filter((m) => m.role !== "system");
  const last = nonSystem.at(-1);

  // Multi-Agent Swarm: Failing sorting algorithm scenario
  const hasSortPrompt = context.messages.some(
    (m) =>
      m.role === "user" &&
      (textOf(m.content).includes("failing sorting algorithm in /workspace/sort.js") ||
        textOf(m.content).includes("sorting algorithm in `/workspace/sort.js`"))
  );
  if (hasSortPrompt) {
    const delegateResults = context.messages.filter(
      (m) => m.role === "toolResult"
    );
    if (last?.role === "toolResult") {
      if (delegateResults.length === 1) {
        return fauxAssistantMessage(
          [
            fauxToolCall("delegate_task", {
              role: "coder",
              task: "Fix the comparator bug in /workspace/sort.js and add unit tests",
              context: "Bug found in /workspace/sort.js line 4"
            })
          ],
          { stopReason: "toolUse" }
        );
      } else if (delegateResults.length === 2) {
        return fauxAssistantMessage(
          [
            fauxToolCall("delegate_task", {
              role: "reviewer",
              task: "Audit git diff in /workspace and verify test passes and blast radius",
              context: "sort.js and sort.test.js modified"
            })
          ],
          { stopReason: "toolUse" }
        );
      } else if (delegateResults.length === 3) {
        return fauxAssistantMessage([
          fauxText(
            "Multi-agent swarm resolution complete: Explorer located the comparator bug, Coder implemented fix and unit tests, and Reviewer audited diff with approval: true. Sorting algorithm is verified and working."
          )
        ]);
      }
    } else {
      return fauxAssistantMessage(
        [
          fauxToolCall("delegate_task", {
            role: "explorer",
            task: "Locate the bug in /workspace/sort.js"
          })
        ],
        { stopReason: "toolUse" }
      );
    }
  }

  // Subagent: Explorer task for sort.js
  const hasExplorerSortPrompt = context.messages.some(
    (m) =>
      m.role === "user" &&
      textOf(m.content).includes("Locate the bug in /workspace/sort.js")
  );
  if (hasExplorerSortPrompt) {
    if (last?.role === "toolResult") {
      return fauxAssistantMessage([
        fauxText(
          "Bug located in /workspace/sort.js on line 4: incorrect comparator returning b - a instead of a - b."
        )
      ]);
    } else {
      return fauxAssistantMessage(
        [fauxToolCall("read", { path: "/workspace/sort.js" })],
        { stopReason: "toolUse" }
      );
    }
  }

  // Subagent: Coder task for sort.js
  const hasCoderSortPrompt = context.messages.some(
    (m) =>
      m.role === "user" &&
      textOf(m.content).includes("Fix the comparator bug in /workspace/sort.js")
  );
  if (hasCoderSortPrompt) {
    const coderToolResults = context.messages.filter(
      (m) => m.role === "toolResult"
    );
    if (last?.role === "toolResult") {
      if (coderToolResults.length === 1) {
        return fauxAssistantMessage(
          [
            fauxToolCall("write", {
              path: "/workspace/sort.test.js",
              content:
                "import { sortArray } from '/workspace/sort.js'; import assert from 'node:assert'; assert.deepStrictEqual(sortArray([3,1,2]), [1,2,3]); console.log('tests passed');"
            })
          ],
          { stopReason: "toolUse" }
        );
      } else if (coderToolResults.length === 2) {
        return fauxAssistantMessage(
          [
            fauxToolCall("bash", { command: "node /workspace/sort.test.js" })
          ],
          { stopReason: "toolUse" }
        );
      } else if (coderToolResults.length === 3) {
        return fauxAssistantMessage([
          fauxText(
            "Fixed sorting bug in /workspace/sort.js and verified unit tests pass 100%."
          )
        ]);
      }
    } else {
      return fauxAssistantMessage(
        [
          fauxToolCall("write", {
            path: "/workspace/sort.js",
            content:
              "export function sortArray(arr) { return [...arr].sort((a, b) => a - b); }"
          })
        ],
        { stopReason: "toolUse" }
      );
    }
  }

  // Subagent: Reviewer task for sort.js
  const hasReviewerSortPrompt = context.messages.some(
    (m) =>
      m.role === "user" &&
      textOf(m.content).includes("Audit git diff in /workspace")
  );
  if (hasReviewerSortPrompt) {
    if (last?.role === "toolResult") {
      return fauxAssistantMessage([
        fauxText(
          "Audit complete: Diff is surgical and confined to sort.js and sort.test.js. Unit tests pass with zero regressions. approval: true"
        )
      ]);
    } else {
      return fauxAssistantMessage(
        [fauxToolCall("git_diff", { dir: "/workspace" })],
        { stopReason: "toolUse" }
      );
    }
  }

  // Subagent / Coder: Infinite loop / circular problem simulation
  const hasLoopPrompt = context.messages.some(
    (m) =>
      m.role === "user" &&
      (textOf(m.content).includes("circular problem") ||
        textOf(m.content).includes("while(true)") ||
        textOf(m.content).includes("infinite-loop"))
  );
  if (hasLoopPrompt) {
    // Continue executing tools without converging
    return fauxAssistantMessage(
      [fauxToolCall("read", { path: "/workspace/dummy.txt" })],
      { stopReason: "toolUse" }
    );
  }

  // Self-correction loop: math.test.js
  const hasUserMathPrompt = context.messages.some(
    (m) => m.role === "user" && textOf(m.content).includes("math.test.js")
  );
  if (hasUserMathPrompt) {
    if (last?.role === "toolResult") {
      const resultText = textOf(last.content);
      let parsed: any = {};
      try {
        parsed = JSON.parse(resultText);
      } catch {}

      void parsed;
      if (last.isError && resultText.includes("AssertionError")) {
        return fauxAssistantMessage(
          [fauxToolCall("bash", { command: "node -e \"assert.strictEqual(2 + 2, 4)\" && echo 'tests passed'" })],
          { stopReason: "toolUse" }
        );
      } else if (!last.isError) {
        return fauxAssistantMessage([
          fauxText("Self-correction loop successful: tests pass after fixing assertion.")
        ]);
      }
    }
  }

  // Factorial loop: calc.js
  const hasUserFactorialPrompt = context.messages.some(
    (m) => m.role === "user" && textOf(m.content).includes("calc.js")
  );
  if (hasUserFactorialPrompt) {
    if (last?.role === "toolResult") {
      const resultText = textOf(last.content);
      let parsed: any = {};
      try {
        parsed = JSON.parse(resultText);
      } catch {}
      void parsed;
      const val = resultText.trim().split("\n")[0] || "720";
      return fauxAssistantMessage([
        fauxText(`Factorial of 6 is ${val}`)
      ]);
    }
  }

  // Step 4: Protected branch rejection trigger
  const hasProtectedBranchPrompt = context.messages.some(
    (m) =>
      m.role === "user" &&
      (textOf(m.content).includes("directly to `main`") ||
        textOf(m.content).includes("directly to main"))
  );
  if (hasProtectedBranchPrompt) {
    if (last?.role === "toolResult") {
      const resText = textOf(last.content);
      return fauxAssistantMessage([
        fauxText(
          resText.includes("GuardrailViolation")
            ? resText
            : "GuardrailViolation: Direct pushes to protected branch 'main' are disabled"
        )
      ]);
    }
  }

  // Step 3: End-to-end issue-to-PR flow
  const hasIssueToPrPrompt = context.messages.some(
    (m) => m.role === "user" && textOf(m.content).includes("Resolve issue #1 on repo")
  );
  if (hasIssueToPrPrompt) {
    const toolResults = context.messages.filter((m) => m.role === "toolResult");
    const count = toolResults.length;
    if (last?.role === "toolResult") {
      if (count === 1) {
        return fauxAssistantMessage(
          [fauxToolCall("prepare_workspace", { url: "https://github.com/vmlgtm/ufo.git" })],
          { stopReason: "toolUse" }
        );
      } else if (count === 2) {
        return fauxAssistantMessage(
          [fauxToolCall("git_checkout", { branch: "otto/issue-1-fix-typo", create: true })],
          { stopReason: "toolUse" }
        );
      } else if (count === 3) {
        return fauxAssistantMessage(
          [fauxToolCall("write", { path: "/workspace/ufo/README.md", content: "# Test Repo\nFixed typo in README.\n" })],
          { stopReason: "toolUse" }
        );
      } else if (count === 4) {
        return fauxAssistantMessage(
          [fauxToolCall("git_commit", { message: "fix: correct typo in README" })],
          { stopReason: "toolUse" }
        );
      } else if (count === 5) {
        return fauxAssistantMessage(
          [fauxToolCall("git_push", { branch: "otto/issue-1-fix-typo" })],
          { stopReason: "toolUse" }
        );
      } else if (count === 6) {
        return fauxAssistantMessage(
          [
            fauxToolCall("github_create_pull_request", {
              repo: "vmlgtm/test-repo",
              title: "fix: correct typo in README.md",
              head: "otto/issue-1-fix-typo",
              draft: true
            })
          ],
          { stopReason: "toolUse" }
        );
      } else if (count === 7) {
        return fauxAssistantMessage([
          fauxText("Pull Request created successfully: https://github.com/vmlgtm/test-repo/pull/1")
        ]);
      }
    }
  }

  if (last?.role === "toolResult") {
    return fauxAssistantMessage([
      fauxText(
        `${last.isError ? "tool failed" : "tool said"}: ${textOf(last.content)}`
      )
    ]);
  }

  const prompt = last?.role === "user" ? textOf(last.content) : "";

  // Self-correction trigger
  if (prompt.includes("math.test.js")) {
    return fauxAssistantMessage(
      [fauxToolCall("bash", { command: "node -e \"assert.strictEqual(2 + 2, 5)\"" })],
      { stopReason: "toolUse" }
    );
  }

  // Factorial trigger
  if (prompt.includes("calc.js")) {
    return fauxAssistantMessage(
      [fauxToolCall("bash", { command: "node /workspace/calc.js" })],
      { stopReason: "toolUse" }
    );
  }

  // Protected branch prompt trigger
  if (prompt.includes("directly to `main`") || prompt.includes("directly to main")) {
    return fauxAssistantMessage(
      [fauxToolCall("git_push", { dir: "/workspace/repo", branch: "main", force: true })],
      { stopReason: "toolUse" }
    );
  }

  // Issue-to-PR prompt trigger
  if (prompt.includes("Resolve issue #1 on repo")) {
    return fauxAssistantMessage(
      [fauxToolCall("github_get_issue", { repo: "vmlgtm/test-repo", issue_number: 1 })],
      { stopReason: "toolUse" }
    );
  }

  // Nested delegation attempt from prompt
  if (prompt.includes("attempt nested delegation")) {
    return fauxAssistantMessage(
      [fauxToolCall("delegate_task", { role: "coder", task: "nested delegation" })],
      { stopReason: "toolUse" }
    );
  }

  // Direct shell prompt
  const bashMatch = /^bash:\s*([\s\S]+)$/.exec(prompt);
  if (bashMatch) {
    return fauxAssistantMessage(
      [fauxToolCall("bash", { command: bashMatch[1] })],
      { stopReason: "toolUse" }
    );
  }

  const multiply = /^multiply (\d+)$/.exec(prompt);
  if (multiply) {
    return fauxAssistantMessage(
      [fauxToolCall("multiply", { value: Number(multiply[1]) })],
      { stopReason: "toolUse" }
    );
  }
  if (prompt === "gate" || prompt === "gate-unsafe") {
    return fauxAssistantMessage(
      [fauxToolCall(prompt === "gate" ? "gate" : "gate_unsafe", {})],
      { stopReason: "toolUse" }
    );
  }
  return fauxAssistantMessage([fauxText(`echo: ${prompt}`)]);
}

const TEST_COMMIT = "0123456789abcdef0123456789abcdef01234567";

/**
 * What the fake container answers for commands that are not file
 * operations: just enough git, package-manager and node behaviour for the
 * scripted scenarios. File operations go to its in-memory filesystem.
 */
function commandReply(argv: readonly string[], container: FakeContainer): FakeReply {
  const [program, ...rest] = argv;
  const script = program === "bash" && rest[0] === "-c" ? rest[1] ?? "" : "";
  if (program === "git") {
    const verb = rest.find((arg) => !arg.startsWith("-") && !arg.includes("="));
    switch (verb) {
      case "ls-remote":
        return { stdout: `${TEST_COMMIT}\tHEAD\n` };
      case "rev-parse":
        return { stdout: rest.includes("--abbrev-ref") ? "otto/issue-1-fix-typo\n" : `${TEST_COMMIT}\n` };
      case "diff":
        return { stdout: "diff --git a/sort.js b/sort.js\n-  return [...arr].sort((a, b) => b - a);\n+  return [...arr].sort((a, b) => a - b);\n" };
      default:
        return {};
    }
  }
  if (script.includes("2 + 2, 5")) {
    return { exitCode: 1, stderr: "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n4 !== 5\n" };
  }
  if (script.includes("2 + 2, 4")) return { stdout: "tests passed\n" };
  if (script === "node /workspace/calc.js") return { stdout: "720\n" };
  if (script === "node /workspace/sort.test.js") {
    return container.fs.readFile("/workspace/sort.js").includes("a - b")
      ? { stdout: "tests passed\n" }
      : { exitCode: 1, stderr: "AssertionError: [3,2,1] !== [1,2,3]\n" };
  }
  const repeat = /^yes \| head -c (\d+)$/.exec(script);
  if (repeat) return { stdout: "y\n".repeat(Number(repeat[1]) / 2) };
  return {};
}

/** Real Durable Object fixture: the example's composition with pi-ai's faux provider. */
export class PiHarnessTestObject extends DurableObject<Env> {
  readonly #faux = fauxProvider({
    tokensPerSecond: 200,
    tokenSize: { min: 2, max: 4 }
  });
  /** The session's container: an in-memory filesystem plus scripted command replies. */
  readonly container = new FakeContainer();
  readonly sandbox = new Sandbox({
    container: () => this.container,
    storage: this.ctx.storage,
    egress: fakeEgress,
    snapshots: false
  });
  readonly registry = createRegistry();
  /** Structured log lines the app emitted, for assertions. */
  readonly logLines: string[] = [];
  readonly tracker: SubagentTracker = new SubagentTracker(this.ctx.storage, {
    broadcastSubagentStart: (s) => this.sockets.broadcastSubagentStart(s),
    broadcastSubagentDone: (s) => this.sockets.broadcastSubagentDone(s)
  });
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      this.registry.install(this.#testTools());
      this.registry.install(
        interruptLogExtension(
          () => this.harness,
          (line) => this.logLines.push(line)
        )
      );
      const allTools = this.#allTools();

      const delegateTaskTool = createDelegateTaskTool({
        harness: this.harness,
        changedFiles: () => this.sandbox.changedFiles(),
        allTools,
        tracker: this.tracker,
        defaultModel: this.#faux.getModel()
      });

      this.registry.install({
        name: "playground",
        sections: [
          {
            key: "preamble",
            render: () => "Use the workspace tools.",
            tag: false
          }
        ],
        tools: [
          delegateTaskTool,
          ...allTools
        ]
      });
      const models = createModels();
      models.setProvider(this.#faux.provider);
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          env: async (target) =>
            new ContainerEnv(this.sandbox, {
              id: "container:test",
              cwd: target.cwd ?? (await this.sandbox.cwd()),
              unsetEnv: CREDENTIAL_VARIABLES
            }),
          settings: {
            retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }
          },
          onReport: (error) => console.warn("pi report", error)
        },
        context
      );
    },
    defaults: { model: this.#faux.getModel() }
  });
  readonly sockets = new PiSessionSockets(
    this.harness,
    this.registry,
    (tag) => this.ctx.getWebSockets(tag),
    this.#faux.getModel(),
    undefined,
    this.tracker
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.sandbox)
    .use(this.harness);

  async onStart(): Promise<void> {
    await this.sockets.reattach();
  }

  /** Every model tool, as PiAgent composes them (MCP aside). */
  #allTools(): ToolRegistration[] {
    return [
      ...createCodingTools(this.sandbox),
      ...createSearchTools(this.sandbox),
      ...createSandboxTools(this.sandbox),
      ...createGitTools(this.sandbox),
      ...createGitHubTools(this.env)
    ];
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#faux.setResponses(Array.from({ length: 500 }, () => script));
    this.container.reply = (argv) => commandReply(argv, this.container);
  }

  /** Prompt the root session; the result without its transcript. */
  async prompt(text: string): Promise<PiOperationResult> {
    const { messages: _messages, ...result } = await this.harness.prompt(text);
    return result;
  }

  submit(
    text: string,
    options: {
      whenBusy?: PiWhenBusy;
      session?: string;
      operationId?: string;
    } = {}
  ): Promise<PiReceipt> {
    return this.harness.submit(text, options);
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.container.fs.writeFile(path, content);
  }

  async readFile(path: string): Promise<string> {
    return this.container.fs.readFile(path);
  }

  /** Every command the container ran, without the sandbox's env/timeout wrapper. */
  async commands(): Promise<string[]> {
    return this.container.execs.map((exec) => exec.argv.join(" "));
  }

  async runTool(name: string, args: Record<string, unknown>): Promise<{ content: any[]; isError?: boolean }> {
    const tool = this.#allTools().find((t) => t.name === name);
    if (!tool) throw new Error(`Tool ${name} not found`);
    const result = await tool.execute(args, { callId: "test-call" } as any, {} as any);
    return {
      content: result.content ?? [],
      isError: Boolean(result.isError)
    };
  }

  async runDelegateTask(args: any, callerSessionId = "1"): Promise<{ content: any[]; isError?: boolean }> {
    const delegateTaskTool = createDelegateTaskTool({
      harness: this.harness,
      changedFiles: () => this.sandbox.changedFiles(),
      allTools: this.#allTools(),
      tracker: this.tracker,
      defaultModel: this.#faux.getModel()
    });

    const result = await delegateTaskTool.execute(
      args,
      { callId: "test-delegate", conversationId: callerSessionId as any } as any,
      {} as any
    );

    return {
      content: result.content ?? [],
      isError: Boolean(result.isError)
    };
  }

  async listSubagents(): Promise<any[]> {
    return this.tracker.list();
  }

  async getSessionMessages(sessionId = "1"): Promise<any[]> {
    return this.harness.session(sessionId).messages();
  }

  wait(operationId: string, session?: string): Promise<PiOperationResult> {
    return this.harness.wait(operationId, session ? { session } : {});
  }

  /** Structured log lines, waiting up to a second for at least one. */
  async logs(): Promise<string[]> {
    for (let i = 0; i < 50 && this.logLines.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return [...this.logLines];
  }

  /** Resolve once the gate tool has started `runs` times. */
  async gateStarted(runs: number): Promise<number> {
    for (let i = 0; i < 200; i++) {
      const count = (await this.ctx.storage.get<number>(GATE_RUNS_KEY)) ?? 0;
      if (count >= runs) return count;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("The gate tool never started");
  }

  async release(): Promise<void> {
    await this.ctx.storage.put(RELEASE_KEY, true);
  }

  /** Watch the root session's events until a run ends. */
  async watch(): Promise<{ view: string; types: string[] }> {
    const stream = await this.harness.session().events();
    let view = reduceEvents(EMPTY_VIEW, [stream.snapshot]);
    const types: string[] = ["snapshot"];
    await new Promise<void>((resolve) => {
      stream.start(async (events: readonly AgentEvent[]) => {
        types.push(...events.map((event) => event.type));
        view = reduceEvents(view, events);
        if (events.some((event) => event.type === "run_end")) resolve();
      });
    });
    await stream.stop();
    // JSON, so the RPC type stays shallow for the test's type checker.
    return { view: JSON.stringify(view), types };
  }

  /** The view folded from a fresh snapshot, as a client joining now sees it. */
  async snapshotView(): Promise<string> {
    const stream = await this.harness.session().events();
    await stream.stop();
    return JSON.stringify(reduceEvents(EMPTY_VIEW, [stream.snapshot]));
  }

  /** The fixture's tools and preamble, as one pi extension. */
  #testTools(): Extension {
    const storage = this.ctx.storage;
    const gate = (
      name: string,
      replay: "safe" | "unsafe"
    ): ToolRegistration<typeof NoParameters> => ({
      name,
      description: "Wait until the test releases it.",
      parameters: NoParameters,
      replay,
      async execute(_args, api, context) {
        const runs = ((await storage.get<number>(GATE_RUNS_KEY)) ?? 0) + 1;
        await storage.put(GATE_RUNS_KEY, runs);
        api.output(`run ${runs}\n`);
        while (!(await storage.get<boolean>(RELEASE_KEY))) {
          context.abortSignal?.throwIfAborted();
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return {
          content: [{ type: "text", text: `released after ${runs} runs` }]
        };
      }
    });
    return {
      name: "test-tools",
      sections: [
        {
          key: "preamble",
          render: () => "Use the supplied test tools.",
          tag: false
        }
      ],
      tools: [
        multiplyTool(),
        gate("gate", "safe"),
        gate("gate_unsafe", "unsafe")
      ]
    };
  }
}

const NoParameters = Type.Object({});
const MultiplyParameters = Type.Object({ value: Type.Number() });

/** Multiplies by three. */
function multiplyTool(): ToolRegistration<typeof MultiplyParameters> {
  return {
    name: "multiply",
    description: "Multiply by three.",
    parameters: MultiplyParameters,
    replay: "safe",
    async execute({ value }) {
      return {
        content: [{ type: "text", text: String(value * 3) }],
        details: { result: value * 3 }
      };
    }
  };
}

export default { fetch: () => new Response("Not found", { status: 404 }) };
