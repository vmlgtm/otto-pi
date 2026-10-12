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
import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { createGitClient } from "@cloudflare/computer/git";
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
import { ASSERT_MODULE, createWorkspaceTools, JAVASCRIPT_BACKEND } from "../workspace";

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
 * the same answer after an eviction as before it:
 *
 * - `multiply N` calls `multiply`, `gate` calls `gate`, `gate-unsafe` calls
 *   `gate_unsafe`; anything else is echoed back.
 * - After a tool result it answers `tool said: <result>`.
 */
function script(context: TranscriptContext): AssistantMessage {
  const nonSystem = context.messages.filter((m) => m.role !== "system");
  const last = nonSystem.at(-1);

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

      if (parsed.exitCode !== 0 || parsed.stderr?.includes("AssertionError")) {
        return fauxAssistantMessage(
          [
            fauxToolCall("exec", {
              command:
                "import assert from 'node:assert'; assert.strictEqual(2 + 2, 4); console.log('tests passed');"
            })
          ],
          { stopReason: "toolUse" }
        );
      } else if (parsed.exitCode === 0) {
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
      const val = parsed.stdout?.trim() ?? "720";
      return fauxAssistantMessage([
        fauxText(`Factorial of 6 is ${val}`)
      ]);
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
      [
        fauxToolCall("exec", {
          command:
            "import assert from 'node:assert'; assert.strictEqual(2 + 2, 5);"
        })
      ],
      { stopReason: "toolUse" }
    );
  }

  // Factorial trigger
  if (prompt.includes("calc.js")) {
    return fauxAssistantMessage(
      [
        fauxToolCall("exec", {
          command:
            "let f = 1; for (let i = 1; i <= 6; i++) f *= i; console.log(f);"
        })
      ],
      { stopReason: "toolUse" }
    );
  }

  // Direct exec prompt
  const execMatch = /^exec:\s*([\s\S]+)$/.exec(prompt);
  if (execMatch) {
    return fauxAssistantMessage(
      [fauxToolCall("exec", { command: execMatch[1] })],
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

/** Real Durable Object fixture: the example's composition with pi-ai's faux provider. */
export class PiHarnessTestObject extends DurableObject<Env> {
  readonly #faux = fauxProvider({
    tokensPerSecond: 200,
    tokenSize: { min: 2, max: 4 }
  });
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
            allowGitNetwork: false,
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
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      this.registry.install(this.#testTools());
      this.registry.install({
        name: "playground",
        sections: [
          {
            key: "preamble",
            render: () => "Use the workspace tools.",
            tag: false
          }
        ],
        tools: createWorkspaceTools(this.workspace)
      });
      const models = createModels();
      models.setProvider(this.#faux.provider);
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
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
  readonly sockets = new PiSessionSockets(this.harness, this.registry, (tag) =>
    this.ctx.getWebSockets(tag)
  );
  readonly webSockets = new WebSockets(this.sockets.options());
  readonly lifecycle = Lifecycle.install(this)
    .use(this.webSockets)
    .use(this.harness);

  async onStart(): Promise<void> {
    try {
      await this.workspace.fs.mkdir("/workspace", { recursive: true });
    } catch {}
    await this.sockets.reattach();
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#faux.setResponses(Array.from({ length: 200 }, () => script));
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
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash > 0) {
      await this.workspace.fs.mkdir(path.substring(0, lastSlash), {
        recursive: true
      });
    }
    await this.workspace.fs.writeFile(path, content);
  }

  async readFile(path: string): Promise<string> {
    return this.workspace.fs.readFile(path, "utf8");
  }

  async runExec(command: string): Promise<string> {
    const tools = createWorkspaceTools(this.workspace);
    const execTool = tools.find((t) => t.name === "exec");
    if (!execTool) throw new Error("exec tool not found");
    const result = await execTool.execute(
      { command },
      { callId: "direct-call" } as any,
      {} as any
    );
    const first = result.content?.[0];
    return first && "type" in first && first.type === "text" ? first.text : "";
  }

  wait(operationId: string, session?: string): Promise<PiOperationResult> {
    return this.harness.wait(operationId, session ? { session } : {});
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
