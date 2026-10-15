import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { REPOS } from "./repos";
import { commandEnv, type RunResult, type Sandbox } from "./sandbox";

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
