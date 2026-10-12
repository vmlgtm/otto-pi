import type { Workspace } from "@cloudflare/computer";
import {
  createPiTools,
  type CreatePiToolsOptions,
  type PiTool,
  type PiToolResultContent
} from "@cloudflare/computer/tools/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";

/** The id of the Workspace's one backend, which `exec` runs on. */
export const JAVASCRIPT_BACKEND = "javascript";

/**
 * Tools that can run again after an eviction cut them off. Reads and
 * searches have no effect, `write` replaces the whole file, and `delete`
 * succeeds on a missing path. `edit` would fail to find text it already
 * replaced, and `exec` runs arbitrary code, so pi hands the model an
 * interrupted result for those instead.
 */
const REPLAY_SAFE = new Set(["read", "ls", "find", "grep", "write", "delete"]);

/**
 * The shared `exec` description is written for a choice of shell backends.
 * This Workspace has one JavaScript backend, so say what that is instead.
 */
const EXEC_DESCRIPTION = `Run JavaScript in the workspace. \`command\` is the source of an ES module, run in a fresh sandboxed isolate with no network access. If the module default-exports a function, it is called with \`input\` and its return value comes back as \`result\`. console.log and console.error go to stdout and stderr. There is no shell, npm or package install: the only imports are these two, plus relative imports of .js files in the workspace.

- \`node:fs/promises\`: the workspace files, async only (readFile, writeFile, mkdir, rm, readdir, stat, lstat, access). readFile takes "utf8" for text.
- \`ws:git\`: git on the workspace, cloning over HTTPS through the host. Each \`dir\` is resolved against the module's working directory, defaults to it, and must stay inside /workspace, so pass the repository's directory. Its exports:

\`\`\`ts
function clone(options: {
  url: string; // HTTPS only
  dir?: string; // working tree to create
  ref?: string; // branch, tag or commit; default: the remote's default branch
  depth?: number; // shallow clone; default: full history
  paths?: string[]; // check out only these paths
  singleBranch?: boolean; // default true
  noTags?: boolean; // default true
}): Promise<void>;
function status(options?: { dir?: string }): Promise<
  { path: string; index: " " | "A" | "M" | "D"; worktree: " " | "A" | "M" | "D" | "?" }[]
>;
// A unified diff of \`ref\` (default HEAD) against the working tree, or against \`to\` when set.
function diff(options?: { dir?: string; ref?: string; to?: string; paths?: string[] }): Promise<string>;
// Newest first, from \`ref\` (default HEAD); \`depth\` caps the count.
function log(options?: { dir?: string; ref?: string; depth?: number }): Promise<
  {
    oid: string;
    message: string;
    tree: string;
    parent: string[];
    author: { name: string; email: string; timestamp: number; timezoneOffset: number }; // timestamp in seconds
    committer: { name: string; email: string; timestamp: number; timezoneOffset: number };
  }[]
>;
\`\`\`

Example:
import { clone, log } from "ws:git";
export default async function () {
  await clone({ url: "https://github.com/octocat/Hello-World", dir: "/workspace/hello", depth: 5 });
  return (await log({ dir: "/workspace/hello" })).map((c) => \`\${c.oid.slice(0, 7)} \${c.message.split("\\n")[0]}\`);
}

Prefer the read, write and edit tools for plain file changes.`;

const COMMAND_DESCRIPTION =
  "ES module source to run. Default-export a function to receive `input` and return a result.";

/** `exec`'s declaration, described for the JavaScript backend. */
function describeExec(tool: PiTool): PiTool {
  const properties = tool.parameters.properties ?? {};
  const command = properties.command;
  return {
    ...tool,
    description: EXEC_DESCRIPTION,
    parameters: {
      ...tool.parameters,
      properties: {
        ...properties,
        command:
          typeof command === "object" && command !== null
            ? { ...command, description: COMMAND_DESCRIPTION }
            : command
      }
    }
  };
}

/**
 * The Workspace tools from `@cloudflare/computer/tools/pi-ai`, as
 * pi-durable `ToolRegistration`s.
 *
 * `createPiTools` returns pi-ai declarations and one `execute` that runs a
 * call, for a hand-written agent loop. pi-durable runs the loop itself and
 * wants each tool to carry its own `execute`, so this pairs them up by
 * name. `execute` validates the arguments against the tool's schema and
 * reports failures as `isError` results rather than throwing.
 */
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2000;
const TRUNCATION_NOTICE = "\n\n[Output truncated at 50KB...]";

function isTimeoutMessage(msg: string): boolean {
  return /timed\s*out|timeout|unsettled|hung/i.test(msg);
}

function truncateOutput(text: string): string {
  if (!text) return "";

  if (text.includes("stdio truncated") || text.includes("[truncated,")) {
    return text
      .replace(/\.\.\.\[stdio truncated\]/g, TRUNCATION_NOTICE)
      .replace(/\n\n\[truncated, \d+ more bytes\]/g, TRUNCATION_NOTICE);
  }

  const lines = text.split("\n");
  let truncatedByLines = false;
  let truncatedText = text;

  if (lines.length > MAX_OUTPUT_LINES) {
    truncatedText = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
    truncatedByLines = true;
  }

  const encoded = new TextEncoder().encode(truncatedText);
  if (encoded.byteLength > MAX_OUTPUT_BYTES) {
    const decoded = new TextDecoder().decode(encoded.subarray(0, MAX_OUTPUT_BYTES));
    return decoded + TRUNCATION_NOTICE;
  }

  if (truncatedByLines) {
    return truncatedText + TRUNCATION_NOTICE;
  }

  return text;
}

export const ASSERT_MODULE = `
export class AssertionError extends Error {
  constructor(message, options = {}) {
    super(message || "Assertion failed");
    this.name = "AssertionError";
    this.code = "ERR_ASSERTION";
    if (options.actual !== undefined) this.actual = options.actual;
    if (options.expected !== undefined) this.expected = options.expected;
    if (options.operator !== undefined) this.operator = options.operator;
  }
}

export function ok(value, message) {
  if (!value) {
    throw new AssertionError(message || "AssertionError: Expected value to be truthy", { actual: value, expected: true, operator: "==" });
  }
}

export function strictEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) {
    throw new AssertionError(
      message || ("AssertionError: Expected values to be strictly equal: " + String(actual) + " !== " + String(expected)),
      { actual, expected, operator: "strictEqual" }
    );
  }
}

export function notStrictEqual(actual, expected, message) {
  if (Object.is(actual, expected)) {
    throw new AssertionError(
      message || ("AssertionError: Expected values not to be strictly equal: " + String(actual) + " === " + String(expected)),
      { actual, expected, operator: "notStrictEqual" }
    );
  }
}

export function equal(actual, expected, message) {
  if (actual != expected) {
    throw new AssertionError(
      message || ("AssertionError: Expected values to be equal: " + String(actual) + " != " + String(expected)),
      { actual, expected, operator: "equal" }
    );
  }
}

export function deepStrictEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new AssertionError(
      message || "AssertionError: Expected values to be deeply equal",
      { actual, expected, operator: "deepStrictEqual" }
    );
  }
}

export function fail(message) {
  throw new AssertionError(message || "AssertionError: Failed");
}

const assert = Object.assign(ok, {
  ok,
  strictEqual,
  notStrictEqual,
  equal,
  deepStrictEqual,
  fail,
  AssertionError
});

export default assert;
`;

export function wrapCommand(command: string): string {
  if (/\bexport\s+default\b/.test(command)) {
    return command;
  }

  const lines = command.split("\n");
  const imports: string[] = [];
  const body: string[] = [];
  let inMultiLineImport = false;
  let importBuffer: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (inMultiLineImport) {
      importBuffer.push(line);
      if (trimmed.includes("from ") || trimmed.endsWith(";") || trimmed.endsWith("}")) {
        imports.push(importBuffer.join("\n"));
        importBuffer = [];
        inMultiLineImport = false;
      }
      continue;
    }

    if (
      trimmed.startsWith("import ") &&
      !trimmed.includes("import(") &&
      !trimmed.includes("import.")
    ) {
      if (
        (trimmed.includes("from ") || trimmed.startsWith("import \"") || trimmed.startsWith("import '")) &&
        (trimmed.endsWith(";") || (!trimmed.includes("{") || trimmed.includes("}")))
      ) {
        imports.push(line);
      } else {
        inMultiLineImport = true;
        importBuffer = [line];
      }
      continue;
    }

    body.push(line);
  }

  if (importBuffer.length > 0) {
    imports.push(importBuffer.join("\n"));
  }

  const importSection = imports.length > 0 ? imports.join("\n") + "\n" : "";
  const bodySection = body.join("\n");

  return `${importSection}export default async function(input) {
  try {
${bodySection}
  } catch (err) {
    if (err instanceof Error && err.name && !err.message.startsWith(err.name)) {
      err.message = \`\${err.name}: \${err.message}\`;
    }
    throw err;
  }
};`;
}

function normalizeStderr(msg: string): string {
  if (isTimeoutMessage(msg)) {
    return "Execution timed out after 15000ms";
  }
  return truncateOutput(msg);
}

/**
 * The Workspace tools from `@cloudflare/computer/tools/pi-ai`, as
 * pi-durable `ToolRegistration`s.
 *
 * `createPiTools` returns pi-ai declarations and one `execute` that runs a
 * call, for a hand-written agent loop. pi-durable runs the loop itself and
 * wants each tool to carry its own `execute`, so this pairs them up by
 * name. `execute` validates the arguments against the tool's schema and
 * reports failures as `isError` results rather than throwing.
 */
export function createWorkspaceTools(
  workspace: Workspace,
  options: Omit<CreatePiToolsOptions, "workspace" | "shell"> = {}
): ToolRegistration[] {
  const hasJsBackend = workspace.runtime.isCallable(JAVASCRIPT_BACKEND);

  const { tools, execute } = createPiTools({
    ...options,
    workspace,
    ...(hasJsBackend
      ? {
          shell: {
            defaultBackend: JAVASCRIPT_BACKEND,
            backends: {
              [JAVASCRIPT_BACKEND]: {
                description: "Runs ES module source in a sandboxed isolate."
              }
            },
            maxBytes: MAX_OUTPUT_BYTES
          }
        }
      : {})
  });

  return tools.map((declared): ToolRegistration => {
    const tool = declared.name === "exec" ? describeExec(declared) : declared;
    return {
      name: tool.name,
      description: tool.description,
      // Plain JSON Schema: pi validates with TypeBox, which accepts it, but
      // computer's schema type is untyped, so `args` is too.
      parameters: tool.parameters,
      ...(tool.constrainedSampling
        ? { constrainedSampling: tool.constrainedSampling }
        : {}),
      replay: REPLAY_SAFE.has(tool.name) ? "safe" : "unsafe",
      async execute(args, api, context) {
        const start = Date.now();
        let content: PiToolResultContent[];
        let isError = false;

        const effectiveArgs =
          tool.name === "exec" && typeof (args as any)?.command === "string"
            ? { ...(args as any), command: wrapCommand((args as any).command) }
            : args;

        try {
          const res = await execute(
            { id: api.callId, name: tool.name, arguments: effectiveArgs },
            { abortSignal: context.abortSignal }
          );
          content = res.content;
          isError = res.isError;
        } catch (err) {
          const durationMs = Date.now() - start;
          const rawErr = err instanceof Error ? err.message : String(err);
          const errMsg = normalizeStderr(rawErr);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  exitCode: 1,
                  stdout: "",
                  stderr: errMsg,
                  durationMs
                })
              }
            ],
            isError: true
          };
        }

        const durationMs = Date.now() - start;

        if (tool.name === "exec") {
          const rawText = content
            .map((c) => (c.type === "text" ? c.text : ""))
            .join("\n");
          let structured: Record<string, unknown>;
          try {
            const parsed = JSON.parse(rawText);
            if (parsed && typeof parsed === "object") {
              let exitCode =
                typeof parsed.exitCode === "number"
                  ? parsed.exitCode
                  : isError
                    ? 1
                    : 0;
              let stdout = truncateOutput(
                typeof parsed.stdout === "string" ? parsed.stdout : ""
              );
              let stderr = typeof parsed.stderr === "string" ? parsed.stderr : "";

              if (parsed.error && !stderr) {
                stderr = String(parsed.error);
                exitCode = 1;
              }

              stderr = normalizeStderr(stderr);
              if (isTimeoutMessage(stderr)) {
                exitCode = 1;
              }

              structured = {
                exitCode,
                stdout,
                stderr,
                durationMs,
                ...(parsed.result !== undefined ? { result: parsed.result } : {})
              };
              isError = exitCode !== 0;
            } else {
              const stderr = normalizeStderr(rawText);
              structured = {
                exitCode: 1,
                stdout: "",
                stderr,
                durationMs
              };
              isError = true;
            }
          } catch {
            const stderr = normalizeStderr(rawText);
            structured = {
              exitCode: isError ? 1 : 0,
              stdout: isError ? "" : truncateOutput(rawText),
              stderr: isError ? stderr : "",
              durationMs
            };
          }

          return {
            content: [{ type: "text", text: JSON.stringify(structured) }],
            isError
          };
        }

        return { content, isError };
      }
    };
  });
}
