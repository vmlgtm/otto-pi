import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { ContainerEnv } from "../container-env";
import { createCodingTools, createSandboxTools, createSearchTools } from "../container-tools";
import { envArgs, Sandbox } from "../sandbox";
import { FakeContainer, fakeEgress, memoryStorage, ufoReplies, unwrap } from "./fake-container";

async function prepared(reply?: FakeContainer["reply"]) {
  const container = new FakeContainer();
  container.reply = ufoReplies;
  const sandbox = new Sandbox({ container: () => container, storage: memoryStorage(), egress: fakeEgress, snapshots: false });
  await sandbox.prepare("https://github.com/vmlgtm/ufo.git");
  if (reply) container.reply = reply;
  return { container, sandbox };
}

function tool(tools: ToolRegistration[], name: string): ToolRegistration {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
}

async function call(target: ToolRegistration, args: Record<string, unknown>) {
  const result = await target.execute(args as never, { callId: "t" } as never, BACKGROUND_CONTEXT as never);
  const text = (result.content ?? []).map((part) => ("text" in part ? part.text : "")).join("");
  return { text, isError: Boolean(result.isError) };
}

describe("the Explorer's search tools", () => {
  it("run grep as a fixed argv in the repo, and treat no matches as an answer", async () => {
    const { container, sandbox } = await prepared((argv) => (argv[0] === "grep" ? { exitCode: 1 } : {}));
    const grep = tool(createSearchTools(sandbox), "grep");
    const result = await call(grep, { pattern: "$(touch pwned)", include: "*.ts" });
    expect(result).toEqual({ text: "(no matches)", isError: false });
    const exec = container.execs.at(-1)!;
    expect(unwrap(exec.argv)).toEqual([
      "grep",
      "-rnI",
      "--exclude-dir=node_modules",
      "--exclude-dir=.git",
      "--include=*.ts",
      "--",
      "$(touch pwned)",
      "."
    ]);
    expect(exec.cwd).toBe("/workspace/ufo");
    expect(grep.replay).toBe("safe");
  });

  it("cut output at 50 KB", async () => {
    const { sandbox } = await prepared((argv) => (argv[0] === "find" ? { stdout: "x".repeat(80_000) } : {}));
    const result = await call(tool(createSearchTools(sandbox), "find"), { name: "*.ts", type: "f" });
    expect(new TextEncoder().encode(result.text).length).toBeLessThan(52 * 1024);
    expect(result.text).toContain("[output truncated at 50KB]");
  });

  it("prune node_modules and .git from find", async () => {
    const { container, sandbox } = await prepared();
    await call(tool(createSearchTools(sandbox), "find"), { path: "src", name: "*.ts", maxDepth: 99 });
    expect(unwrap(container.execs.at(-1)!.argv)).toEqual([
      "find", "src", "-maxdepth", "32",
      "-name", "node_modules", "-prune", "-o",
      "-name", ".git", "-prune", "-o",
      "-name", "*.ts", "-print"
    ]);
  });
});

describe("pi's coding tools on the container", () => {
  it("cap bash at 600 seconds whatever the model asks for", async () => {
    const { sandbox } = await prepared();
    const bash = tool(createCodingTools(sandbox), "bash");
    expect(bash.prepareArguments?.({ command: "ls" })).toEqual({ command: "ls", timeout: 600 });
    expect(bash.prepareArguments?.({ command: "ls", timeout: 86_400 })).toEqual({ command: "ls", timeout: 600 });
    expect(bash.prepareArguments?.({ command: "ls", timeout: 30 })).toEqual({ command: "ls", timeout: 30 });
  });

  it("run bash without credential variables, in the repo, through the environment's shell", async () => {
    const { sandbox } = await prepared();
    const seen: { command: unknown; options: unknown }[] = [];
    const env = {
      cwd: "/workspace/ufo",
      async exec(command: unknown, options: { onOutput?: (text: string, c: unknown, i: unknown) => void }) {
        seen.push({ command, options });
        options.onOutput?.("ok\n", BACKGROUND_CONTEXT, { stream: "stdout" });
        return { ok: true, value: { exitCode: 0 } };
      }
    };
    const bash = tool(createCodingTools(sandbox), "bash");
    await bash.execute(
      { command: "env", timeout: 600 } as never,
      { callId: "b", env, output() {}, diagnostic() {}, outputWindow: undefined } as never,
      BACKGROUND_CONTEXT as never
    );
    const options = seen[0]!.options as { cwd: string; env: Record<string, string>; timeout: number };
    expect(seen[0]!.command).toBe("env");
    expect(options.cwd).toBe("/workspace/ufo");
    expect(options.timeout).toBe(600);
    expect(options.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(options.env).not.toHaveProperty("GH_TOKEN");
    expect(options.env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("replay reads and whole-file writes, but never edits or shell commands", async () => {
    const { sandbox } = await prepared();
    const tools = createCodingTools(sandbox);
    expect(Object.fromEntries(tools.map((each) => [each.name, each.replay ?? "unsafe"]))).toEqual({
      read: "safe",
      write: "safe",
      edit: "unsafe",
      bash: "unsafe"
    });
  });
});

describe("run_checks", () => {
  it("runs the repo's configured test command, not one the model chose", async () => {
    const { container, sandbox } = await prepared((argv) =>
      argv[0] === "pnpm" && argv[1] === "exec" ? { stdout: "Tests  377 passed" } : {}
    );
    const result = await call(tool(createSandboxTools(sandbox), "run_checks"), { which: "test" });
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/^## test \(pnpm exec vitest run\): passed in/);
    expect(result.text).toContain("Tests  377 passed");
    expect(container.execs.at(-1)!.cwd).toBe("/workspace/ufo");
  });

  it("refuses to run before a workspace is prepared", async () => {
    const container = new FakeContainer();
    const sandbox = new Sandbox({ container: () => container, storage: memoryStorage(), egress: fakeEgress, snapshots: false });
    const result = await call(tool(createSandboxTools(sandbox), "run_checks"), {});
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining("Call prepare_workspace first") });
  });

  it("prepare_workspace refuses repositories that are not configured", async () => {
    const container = new FakeContainer();
    const sandbox = new Sandbox({ container: () => container, storage: memoryStorage(), egress: fakeEgress, snapshots: false });
    const result = await call(tool(createSandboxTools(sandbox), "prepare_workspace"), {
      url: "https://bitbucket.org/tata1mg/1mg_web.git"
    });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining("Unknown repository") });
  });
});

describe("ContainerEnv.exec", () => {
  it("wraps every command in a 600 s process-group timeout and reports missing programs as spawn errors", async () => {
    const { container, sandbox } = await prepared((argv) =>
      argv[0] === "sh" && argv[5] === "missing-program" ? { exitCode: 102 } : {}
    );
    const env = new ContainerEnv(sandbox, { id: "container:test", cwd: "/workspace/ufo" });
    const ran = await env.exec("npm test", { timeout: 5000 }, BACKGROUND_CONTEXT);
    expect(ran).toEqual({ ok: true, value: { exitCode: 0 } });
    expect(container.execs.at(-1)!.argv).toEqual(["env", ...envArgs(), "timeout", "-k", "5", "600", "bash", "-c", "npm test"]);
    const unsetting = new ContainerEnv(sandbox, { id: "container:test", cwd: "/workspace/ufo", unsetEnv: ["GITHUB_TOKEN"] });
    await unsetting.exec("env", undefined, BACKGROUND_CONTEXT);
    expect(container.execs.at(-1)!.argv.slice(0, 3)).toEqual(["env", "-u", "GITHUB_TOKEN"]);
    const missing = await env.exec(["missing-program"], undefined, BACKGROUND_CONTEXT);
    expect(missing.ok ? undefined : missing.error.code).toBe("spawn_error");
  });
});
