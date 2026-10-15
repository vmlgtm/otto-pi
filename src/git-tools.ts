import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { posix } from "node:path";
import { head } from "./container-tools";
import { type RunResult, type Sandbox, WORKSPACE_ROOT } from "./sandbox";

const PROTECTED_BRANCHES = new Set(["main", "master", "release", "production"]);
const OTTO_BRANCH_REGEX = /^otto\/[a-zA-Z0-9_.-]+$/;
const BOT_NAME = "otto-pi[bot]";
const BOT_EMAIL = "otto-pi[bot]@users.noreply.github.com";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(value: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) };
}

function errorResult(error: unknown): ToolResult {
  return text(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), true);
}

function guardrail(message: string): ToolResult {
  return text(`GuardrailViolation: ${message}`, true);
}

/** A ref or path the model passes must not be read as an option. */
function assertNotOption(name: string, value: string | undefined): void {
  if (value !== undefined && value.startsWith("-")) throw new Error(`${name} must not start with '-' (got '${value}')`);
}

function failed(step: string, result: RunResult): Error {
  return new Error(`${step} failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim().slice(-2000)}`);
}

/** Status letters per path, from `git status --porcelain=v1`. */
export function parseStatus(porcelain: string): { path: string; index: string; worktree: string }[] {
  return porcelain
    .split("\n")
    .filter((line) => line.length > 3 && !line.startsWith("##"))
    .map((line) => ({ index: line[0], worktree: line[1], path: line.slice(3) }));
}

const dirParameter = Type.Optional(
  Type.String({ description: "Repository directory inside /workspace (default: the prepared repository)" })
);

const checkoutParameters = Type.Object({
  dir: dirParameter,
  branch: Type.String({ description: "Branch name to checkout or create (e.g. otto/issue-123-fix-typo)" }),
  create: Type.Optional(Type.Boolean({ description: "Create a new branch if true" }))
});

const statusParameters = Type.Object({ dir: dirParameter });

const diffParameters = Type.Object({
  dir: dirParameter,
  ref: Type.Optional(Type.String({ description: "Ref to diff from (default HEAD)" })),
  to: Type.Optional(Type.String({ description: "Second ref to diff to (optional)" })),
  paths: Type.Optional(Type.Array(Type.String(), { description: "Filter diff to specific paths" }))
});

const commitParameters = Type.Object({
  dir: dirParameter,
  message: Type.String({ description: "Structured commit message" }),
  author_name: Type.Optional(Type.String({ description: "Commit author name" })),
  author_email: Type.Optional(Type.String({ description: "Commit author email" })),
  paths: Type.Optional(Type.Array(Type.String(), { description: "Paths to stage before committing. Defaults to all changes." }))
});

const pushParameters = Type.Object({
  dir: dirParameter,
  remote: Type.Optional(Type.String({ description: "Remote name, defaults to origin" })),
  branch: Type.Optional(Type.String({ description: "Branch to push. Defaults to current branch." })),
  force: Type.Optional(Type.Boolean({ description: "Force push (prohibited by guardrail)" }))
});

/**
 * Git on the session's container, with the guardrails of the earlier
 * in-Worker tools: `otto/` branch names, no pushes to protected branches,
 * no force pushes. `bash` could run `git push` itself, so the real
 * enforcement is at the credential layer: the egress gateway adds the token
 * only to the one push `git_push` allows (`Sandbox.withPushGrant`).
 *
 * Cloning is `prepare_workspace`'s job, since it needs internet.
 */
export function createGitTools(sandbox: Sandbox): ToolRegistration[] {
  /** The repository directory: inside /workspace, default the prepared repo. */
  const repoDir = async (dir: string | undefined): Promise<string> => {
    const base = await sandbox.cwd();
    if (!dir?.trim()) return base;
    const resolved = posix.resolve(base, dir.trim());
    if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(`${WORKSPACE_ROOT}/`)) {
      throw new Error(`dir must be inside ${WORKSPACE_ROOT} (got '${dir}')`);
    }
    return resolved;
  };
  const git = (dir: string, args: string[], timeoutSeconds = 120) =>
    sandbox.run(["git", "-c", "core.quotepath=false", ...args], { cwd: dir, timeoutSeconds });

  const checkout: ToolRegistration<typeof checkoutParameters> = {
    name: "git_checkout",
    description: "Checkout an existing branch or create a new feature branch adhering to 'otto/<issue-id>-<short-description>'.",
    parameters: checkoutParameters,
    replay: "unsafe",
    executionMode: "sequential",
    async execute(args) {
      try {
        const dir = await repoDir(args.dir);
        const branch = args.branch.trim();
        if (args.create && !OTTO_BRANCH_REGEX.test(branch)) {
          return guardrail(
            `Branch name must follow the pattern 'otto/<issue-id>-<short-description>' (received: '${branch}')`
          );
        }
        assertNotOption("branch", branch);
        const result = await git(dir, args.create ? ["checkout", "-b", branch] : ["checkout", branch, "--"]);
        if (result.exitCode !== 0) throw failed("git checkout", result);
        return text(JSON.stringify({ success: true, branch, dir }));
      } catch (error) {
        return errorResult(error);
      }
    }
  };

  const status: ToolRegistration<typeof statusParameters> = {
    name: "git_status",
    description: "Inspect the current branch and the staged, unstaged and untracked changes in the repository.",
    parameters: statusParameters,
    replay: "safe",
    async execute(args) {
      try {
        const dir = await repoDir(args.dir);
        const result = await git(dir, ["status", "--porcelain=v1", "--branch"]);
        if (result.exitCode !== 0) throw failed("git status", result);
        const branch = /^## (?:No commits yet on )?([^.\s]+)/m.exec(result.stdout)?.[1];
        return text(JSON.stringify({ dir, branch, status: parseStatus(result.stdout) }));
      } catch (error) {
        return errorResult(error);
      }
    }
  };

  const diff: ToolRegistration<typeof diffParameters> = {
    name: "git_diff",
    description:
      "Inspect the unified diff of changes against HEAD (including new untracked files) or between two refs.",
    parameters: diffParameters,
    replay: "safe",
    async execute(args) {
      try {
        const dir = await repoDir(args.dir);
        const ref = args.ref?.trim() || "HEAD";
        assertNotOption("ref", ref);
        assertNotOption("to", args.to);
        const paths = args.paths ?? [];
        const tracked = await git(dir, ["diff", ref, ...(args.to ? [args.to] : []), "--", ...paths]);
        if (tracked.exitCode !== 0) throw failed("git diff", tracked);
        let output = tracked.stdout;
        if (!args.to) {
          // `git diff` leaves out files git does not track yet; a review must see them.
          const untracked = await git(dir, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths]);
          for (const file of untracked.stdout.split("\0").filter(Boolean).slice(0, 200)) {
            const added = await git(dir, ["diff", "--no-index", "--", "/dev/null", file]);
            output += added.stdout;
          }
        }
        return text(head(output) || "No differences found.");
      } catch (error) {
        return errorResult(error);
      }
    }
  };

  const commit: ToolRegistration<typeof commitParameters> = {
    name: "git_commit",
    description: "Stage modified files and commit with a structured commit message.",
    parameters: commitParameters,
    replay: "unsafe",
    executionMode: "sequential",
    async execute(args) {
      try {
        const dir = await repoDir(args.dir);
        const staged = await git(dir, args.paths ? ["add", "--", ...args.paths] : ["add", "-A"]);
        if (staged.exitCode !== 0) throw failed("git add", staged);
        const name = args.author_name ?? BOT_NAME;
        const email = args.author_email ?? BOT_EMAIL;
        // The repo's own hooks are not run here; run_checks verifies the change.
        const committed = await git(dir, [
          "-c",
          `user.name=${name}`,
          "-c",
          `user.email=${email}`,
          "commit",
          "--no-verify",
          "-m",
          args.message
        ]);
        if (committed.exitCode !== 0) throw failed("git commit", committed);
        const oid = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
        return text(JSON.stringify({ oid, message: args.message, dir }));
      } catch (error) {
        return errorResult(error);
      }
    }
  };

  const push: ToolRegistration<typeof pushParameters> = {
    name: "git_push",
    description:
      "Push local branch commits to the remote origin. Guardrails prevent direct pushes to protected branches.",
    parameters: pushParameters,
    replay: "unsafe",
    executionMode: "sequential",
    async execute(args) {
      try {
        const dir = await repoDir(args.dir);
        let branch = args.branch?.trim();
        if (!branch) {
          const current = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
          branch = current.exitCode === 0 ? current.stdout.trim() : undefined;
        }

        if (branch && PROTECTED_BRANCHES.has(branch.toLowerCase())) {
          return guardrail(`Direct pushes to protected branch '${branch}' are disabled`);
        }
        if (args.force) return guardrail("Force pushes are disabled");
        if (!branch || branch === "HEAD") return text("Error: Unable to determine current branch to push.", true);
        if (!branch.startsWith("otto/")) {
          return guardrail(
            `Direct pushes to non-otto branch '${branch}' are disabled. Branch name must start with 'otto/'`
          );
        }
        if (!OTTO_BRANCH_REGEX.test(branch)) {
          return guardrail(`Branch name must follow the pattern 'otto/<issue-id>-<short-description>' (received: '${branch}')`);
        }
        const remote = args.remote?.trim() || "origin";
        if (remote !== "origin") return guardrail(`Pushes go to 'origin' only (received: '${remote}')`);

        // The gateway adds the token to this one push, for this one branch.
        const result = await sandbox.withPushGrant(branch, () =>
          git(dir, ["-c", "credential.helper=", "push", "--porcelain", "origin", `refs/heads/${branch}:refs/heads/${branch}`], 300)
        );
        if (result.exitCode !== 0) throw failed("git push", result);
        return text(JSON.stringify({ success: true, branch, output: result.stdout.trim().slice(-2000) }));
      } catch (error) {
        return errorResult(error);
      }
    }
  };

  return [checkout, status, diff, commit, push];
}
