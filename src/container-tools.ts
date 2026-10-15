import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool
} from "@earendil-works/pi-durable/tools";
import { REPOS } from "./repos";
import { commandEnv, MAX_COMMAND_SECONDS, type RunResult, type Sandbox } from "./sandbox";

/** Credentials a command could look for. None is set in the container; this keeps it that way. */
const CREDENTIAL_VARIABLES = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GIT_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN"
];

/** Output cap for the tools in this file, as for every other tool. */
export const MAX_OUTPUT_BYTES = 50 * 1024;

/** Keep the end of `text` within `MAX_OUTPUT_BYTES`, saying how much was cut. */
export function tail(text: string, limit = MAX_OUTPUT_BYTES): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return text;
  return `[output truncated: first ${bytes.length - limit} bytes dropped]\n${new TextDecoder().decode(bytes.subarray(bytes.length - limit))}`;
}

/** Keep the start of `text` within `MAX_OUTPUT_BYTES`; searches lead with their best matches. */
export function head(text: string, limit = MAX_OUTPUT_BYTES): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return text;
  return `${new TextDecoder().decode(bytes.subarray(0, limit))}\n[output truncated at 50KB]`;
}

function failure(error: unknown) {
  return {
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
    isError: true
  };
}

const prepareParameters = Type.Object({
  url: Type.String({
    description: `HTTPS clone URL of the repository. Configured: ${Object.keys(REPOS).join(", ")}.`
  }),
  install: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Only to add a dependency to an already prepared repo: one package-manager command, e.g. ["pnpm", "add", "-D", "zod"]. Runs with internet on.'
    })
  )
});

const checksParameters = Type.Object({
  which: Type.Optional(
    Type.Union([Type.Literal("test"), Type.Literal("lint"), Type.Literal("all")], {
      description: "Which configured checks to run (default: all)."
    })
  )
});

function summarize(name: string, result: RunResult): string {
  const status = result.timedOut
    ? "timed out"
    : result.exitCode === 0
      ? "passed"
      : `failed (exit ${result.exitCode})`;
  return `## ${name}: ${status} in ${(result.durationMs / 1000).toFixed(1)} s\n${tail(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`, MAX_OUTPUT_BYTES / 2)}`;
}

/**
 * `prepare_workspace` and `run_checks`: the two tools that own the
 * repository's setup and its fixed checks. Cloning needs internet, so it
 * is not a model tool of its own; installs happen only here.
 */
export function createSandboxTools(sandbox: Sandbox): ToolRegistration[] {
  const prepare: ToolRegistration<typeof prepareParameters> = {
    name: "prepare_workspace",
    description:
      "Clone a configured repository into /workspace/<name> (shallow) and install its dependencies, with internet on only for this step. Call it once per session before reading or editing code; calling it again starts over from a fresh clone. With `install`, it instead runs one package-manager command in the prepared repo to add a dependency. Returns the directory, commit, timings and the repo's test and lint commands.",
    parameters: prepareParameters,
    replay: "unsafe",
    async execute(args) {
      try {
        if (args.install && args.install.length > 0) {
          const result = await sandbox.install(args.install);
          return {
            content: [{ type: "text", text: summarize(args.install.join(" "), result) }],
            isError: result.exitCode !== 0
          };
        }
        const result = await sandbox.prepare(args.url);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return failure(error);
      }
    }
  };

  const checks: ToolRegistration<typeof checksParameters> = {
    name: "run_checks",
    description:
      "Run the prepared repository's configured test and lint commands (fixed per repo, not chosen by the caller) and report each one's exit status and output tail.",
    parameters: checksParameters,
    replay: "unsafe",
    async execute(args) {
      try {
        const state = await sandbox.workspace();
        if (!state) throw new Error("No workspace is prepared. Call prepare_workspace first.");
        const config = Object.entries(REPOS).find(([url]) => url === state.url)?.[1];
        if (!config) throw new Error(`${state.url} is no longer configured.`);
        const which = args.which ?? "all";
        const planned: [string, readonly string[] | null][] = [];
        if (which !== "lint") planned.push(["test", config.test]);
        if (which !== "test") planned.push(["lint", config.lint]);
        const sections: string[] = [];
        let failed = false;
        for (const [name, argv] of planned) {
          if (!argv) {
            sections.push(`## ${name}: not configured for ${state.url}`);
            continue;
          }
          const result = await sandbox.run(argv, { cwd: state.dir, env: commandEnv(state.node) });
          failed ||= result.exitCode !== 0;
          sections.push(summarize(`${name} (${argv.join(" ")})`, result));
        }
        return { content: [{ type: "text", text: sections.join("\n\n") }], isError: failed };
      } catch (error) {
        return failure(error);
      }
    }
  };

  return [prepare, checks];
}

/**
 * pi's `read`, `write`, `edit` and `bash`, which run on the conversation's
 * `ExecutionEnv` (ContainerEnv). pi owns how they behave; this sets their
 * replay policy and the shell's limits.
 */
export function createCodingTools(sandbox: Sandbox): ToolRegistration[] {
  const bash = createBashTool({
    // Runs before every command: no credentials, and the repo's Node first on PATH.
    async prepare(execution) {
      for (const name of Object.keys(execution.env)) {
        if (/token|secret|password|private_key|credential/i.test(name)) delete execution.env[name];
      }
      for (const name of CREDENTIAL_VARIABLES) execution.env[name] = "";
      execution.env.GIT_TERMINAL_PROMPT = "0";
      Object.assign(execution.env, commandEnv((await sandbox.workspace())?.node));
    }
  });
  return [
    // Reads have no effect and `write` replaces the whole file, so both may rerun after a reset.
    { ...createReadTool(), replay: "safe" },
    { ...createWriteTool(), replay: "safe" },
    createEditTool(),
    {
      ...bash,
      description: `${bash.description} Runs in the prepared repository on a Linux container with Node, git, npm, pnpm and yarn. Internet is off: use prepare_workspace to install dependencies. Commands stop after ${MAX_COMMAND_SECONDS} seconds at most.`,
      // The environment caps every command at 600 s; say so in the arguments, so a
      // timeout reports the limit that applied.
      prepareArguments(args: unknown) {
        const input = (args ?? {}) as { command?: unknown; timeout?: unknown };
        const timeout = typeof input.timeout === "number" && input.timeout > 0 ? input.timeout : MAX_COMMAND_SECONDS;
        return { ...input, timeout: Math.min(timeout, MAX_COMMAND_SECONDS) } as { command: string; timeout?: number };
      }
    }
  ] as ToolRegistration[];
}

const lsParameters = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory to list (default: the repository root)" }))
});

const findParameters = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory to search (default: the repository root)" })),
  name: Type.Optional(Type.String({ description: "File name glob, e.g. '*.test.ts'" })),
  type: Type.Optional(Type.Union([Type.Literal("f"), Type.Literal("d")], { description: "f: files, d: directories" })),
  maxDepth: Type.Optional(Type.Number({ description: "Maximum directory depth (default 8)" }))
});

const grepParameters = Type.Object({
  pattern: Type.String({ description: "Pattern to search for (basic regex unless fixed is true)" }),
  path: Type.Optional(Type.String({ description: "File or directory to search (default: the repository root)" })),
  include: Type.Optional(Type.String({ description: "Only files matching this glob, e.g. '*.ts'" })),
  ignoreCase: Type.Optional(Type.Boolean()),
  fixed: Type.Optional(Type.Boolean({ description: "Treat the pattern as a fixed string" }))
});

/** Directories no search descends into. */
const SKIPPED = ["node_modules", ".git"];

/**
 * `ls`, `find` and `grep` for the Explorer, which must search without a
 * shell. Each runs a fixed argv (never shell text), read-only, with its
 * output cut at 50 KB.
 */
export function createSearchTools(sandbox: Sandbox): ToolRegistration[] {
  const run = async (argv: string[], okCodes: readonly number[]) => {
    try {
      const result = await sandbox.run(argv, { cwd: await sandbox.cwd(), timeoutSeconds: 60 });
      const failed = !okCodes.includes(result.exitCode);
      const text = failed ? result.stderr || result.stdout || `exit ${result.exitCode}` : result.stdout || "(no matches)";
      return { content: [{ type: "text" as const, text: head(text) }], isError: failed };
    } catch (error) {
      return failure(error);
    }
  };

  const ls: ToolRegistration<typeof lsParameters> = {
    name: "ls",
    description: "List a directory's entries with sizes and types.",
    parameters: lsParameters,
    replay: "safe",
    execute: (args) => run(["ls", "-la", "--", args.path ?? "."], [0])
  };

  const find: ToolRegistration<typeof findParameters> = {
    name: "find",
    description: "Find files or directories by name under a path, skipping node_modules and .git.",
    parameters: findParameters,
    replay: "safe",
    execute: (args) => {
      const depth = Math.max(1, Math.min(Math.floor(args.maxDepth ?? 8), 32));
      const argv = ["find", args.path ?? ".", "-maxdepth", String(depth)];
      for (const dir of SKIPPED) argv.push("-name", dir, "-prune", "-o");
      if (args.type) argv.push("-type", args.type);
      if (args.name) argv.push("-name", args.name);
      argv.push("-print");
      return run(argv, [0]);
    }
  };

  const grep: ToolRegistration<typeof grepParameters> = {
    name: "grep",
    description: "Search file contents recursively and print matching lines with file and line number, skipping node_modules and .git.",
    parameters: grepParameters,
    replay: "safe",
    execute: (args) => {
      const argv = ["grep", "-rnI", ...SKIPPED.map((dir) => `--exclude-dir=${dir}`)];
      if (args.ignoreCase) argv.push("-i");
      if (args.fixed) argv.push("-F");
      if (args.include) argv.push(`--include=${args.include}`);
      argv.push("--", args.pattern, args.path ?? ".");
      // grep exits 1 when nothing matched; that is an answer, not a failure.
      return run(argv, [0, 1]);
    }
  };

  return [ls, find, grep];
}
