import type { Workspace } from "@cloudflare/computer";
import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";

const PROTECTED_BRANCHES = new Set(["main", "master", "release", "production"]);
const OTTO_BRANCH_REGEX = /^otto\/[a-zA-Z0-9_.-]+$/;

function normalizeDir(dir?: string): string {
  if (!dir) return "/workspace";
  const trimmed = dir.trim();
  if (trimmed === "/" || !trimmed.startsWith("/workspace")) {
    return "/workspace";
  }
  return trimmed;
}

function extractRepoName(url: string): string {
  try {
    const parts = url.split("/").filter(Boolean);
    const last = parts.at(-1)?.replace(/\.git$/, "");
    return last || "repo";
  } catch {
    return "repo";
  }
}

export function createGitTools(
  workspace: Workspace,
  env?: { GITHUB_TOKEN?: string }
): ToolRegistration[] {
  const cloneParameters = Type.Object({
    url: Type.String({ description: "Remote repository HTTPS URL (e.g. https://github.com/vmlgtm/repo.git)" }),
    dir: Type.Optional(Type.String({ description: "Target directory inside /workspace (e.g. /workspace/repo)" })),
    ref: Type.Optional(Type.String({ description: "Branch, tag, or commit to clone. Defaults to remote default branch." })),
    depth: Type.Optional(Type.Number({ description: "Shallow clone depth. Defaults to 1 (max 50)." }))
  });

  const checkoutParameters = Type.Object({
    dir: Type.Optional(Type.String({ description: "Working tree directory inside /workspace" })),
    branch: Type.String({ description: "Branch name to checkout or create (e.g. otto/issue-123-fix-typo)" }),
    create: Type.Optional(Type.Boolean({ description: "Create a new branch if true" }))
  });

  const statusParameters = Type.Object({
    dir: Type.Optional(Type.String({ description: "Working tree directory inside /workspace" }))
  });

  const diffParameters = Type.Object({
    dir: Type.Optional(Type.String({ description: "Working tree directory inside /workspace" })),
    ref: Type.Optional(Type.String({ description: "Ref to diff from (default HEAD)" })),
    to: Type.Optional(Type.String({ description: "Second ref to diff to (optional)" })),
    paths: Type.Optional(Type.Array(Type.String(), { description: "Filter diff to specific paths" }))
  });

  const commitParameters = Type.Object({
    dir: Type.Optional(Type.String({ description: "Working tree directory inside /workspace" })),
    message: Type.String({ description: "Structured commit message" }),
    author_name: Type.Optional(Type.String({ description: "Commit author name" })),
    author_email: Type.Optional(Type.String({ description: "Commit author email" })),
    paths: Type.Optional(Type.Array(Type.String(), { description: "Paths to stage before committing. Defaults to all changes." }))
  });

  const pushParameters = Type.Object({
    dir: Type.Optional(Type.String({ description: "Working tree directory inside /workspace" })),
    remote: Type.Optional(Type.String({ description: "Remote name, defaults to origin" })),
    branch: Type.Optional(Type.String({ description: "Branch to push. Defaults to current branch." })),
    force: Type.Optional(Type.Boolean({ description: "Force push (prohibited by guardrail)" }))
  });

  const cloneTool: ToolRegistration<typeof cloneParameters> = {
    name: "git_clone",
    description: "Clone a remote repository into /workspace. Defaults to shallow clone (depth: 1) with automatic credential injection.",
    parameters: cloneParameters,
    replay: "unsafe",
    async execute(args) {
      try {
        const repoName = extractRepoName(args.url);
        const targetDir = args.dir ? normalizeDir(args.dir) : `/workspace/${repoName}`;
        const depth = typeof args.depth === "number" && args.depth > 0 ? Math.min(args.depth, 50) : 1;

        // In-host credential injection: never expose token to LLM context
        const headers: Record<string, string> = {};
        if (env?.GITHUB_TOKEN && args.url.includes("github.com")) {
          headers["Authorization"] = `token ${env.GITHUB_TOKEN}`;
        }

        await workspace.git.clone({
          url: args.url,
          dir: targetDir,
          ref: args.ref,
          depth,
          headers: Object.keys(headers).length > 0 ? headers : undefined
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                dir: targetDir,
                ref: args.ref ?? "HEAD",
                depth
              })
            }
          ]
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: err instanceof Error ? err.message : String(err)
              })
            }
          ],
          isError: true
        };
      }
    }
  };

  const checkoutTool: ToolRegistration<typeof checkoutParameters> = {
    name: "git_checkout",
    description: "Checkout an existing branch or create a new feature branch adhering to 'otto/<issue-id>-<short-description>'.",
    parameters: checkoutParameters,
    replay: "unsafe",
    async execute(args) {
      try {
        const dir = normalizeDir(args.dir);
        const branch = args.branch.trim();

        if (args.create) {
          // Guardrail: Branch name enforcement
          if (!OTTO_BRANCH_REGEX.test(branch)) {
            return {
              content: [
                {
                  type: "text",
                  text: `GuardrailViolation: Branch name must follow the pattern 'otto/<issue-id>-<short-description>' (received: '${branch}')`
                }
              ],
              isError: true
            };
          }
          await workspace.git.branch({ dir, name: branch, checkout: true });
        } else {
          await workspace.git.checkout({ dir, ref: branch });
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, branch, dir })
            }
          ]
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: err instanceof Error ? err.message : String(err)
              })
            }
          ],
          isError: true
        };
      }
    }
  };

  const statusTool: ToolRegistration<typeof statusParameters> = {
    name: "git_status",
    description: "Inspect staged and unstaged changes in the repository.",
    parameters: statusParameters,
    replay: "safe",
    async execute(args) {
      try {
        const dir = normalizeDir(args.dir);
        const status = await workspace.git.status({ dir });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ dir, status })
            }
          ]
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: err instanceof Error ? err.message : String(err)
              })
            }
          ],
          isError: true
        };
      }
    }
  };

  const diffTool: ToolRegistration<typeof diffParameters> = {
    name: "git_diff",
    description: "Inspect unified diff of changes against HEAD or between refs.",
    parameters: diffParameters,
    replay: "safe",
    async execute(args) {
      try {
        const dir = normalizeDir(args.dir);
        const diff = await workspace.git.diff({
          dir,
          ref: args.ref,
          to: args.to,
          paths: args.paths
        });
        return {
          content: [
            {
              type: "text",
              text: diff || "No differences found."
            }
          ]
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: err instanceof Error ? err.message : String(err)
              })
            }
          ],
          isError: true
        };
      }
    }
  };

  const commitTool: ToolRegistration<typeof commitParameters> = {
    name: "git_commit",
    description: "Stage modified files and commit with a structured commit message.",
    parameters: commitParameters,
    replay: "unsafe",
    async execute(args) {
      try {
        const dir = normalizeDir(args.dir);
        await workspace.git.add({
          dir,
          paths: args.paths ?? ["."],
          all: !args.paths
        });

        const commitResult = await workspace.git.commit({
          dir,
          message: args.message,
          author: {
            name: args.author_name ?? "otto-pi[bot]",
            email: args.author_email ?? "otto-pi[bot]@users.noreply.github.com"
          }
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                oid: commitResult.oid,
                message: args.message,
                dir
              })
            }
          ]
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: err instanceof Error ? err.message : String(err)
              })
            }
          ],
          isError: true
        };
      }
    }
  };

  const pushTool: ToolRegistration<typeof pushParameters> = {
    name: "git_push",
    description: "Push local branch commits to the remote origin. Guardrails prevent direct pushes to protected branches.",
    parameters: pushParameters,
    replay: "unsafe",
    async execute(args) {
      try {
        const dir = normalizeDir(args.dir);

        // Determine branch to push
        let targetBranch = args.branch?.trim();
        if (!targetBranch) {
          try {
            targetBranch = await workspace.git.currentBranch({ dir });
          } catch {}
        }

        // Guardrail: Block direct pushes to default / protected branches
        if (targetBranch && PROTECTED_BRANCHES.has(targetBranch.toLowerCase())) {
          return {
            content: [
              {
                type: "text",
                text: `GuardrailViolation: Direct pushes to protected branch '${targetBranch}' are disabled`
              }
            ],
            isError: true
          };
        }

        // Guardrail: Block force pushes
        if (args.force) {
          return {
            content: [
              {
                type: "text",
                text: "GuardrailViolation: Force pushes are disabled"
              }
            ],
            isError: true
          };
        }

        if (!targetBranch) {
          return {
            content: [{ type: "text", text: "Error: Unable to determine current branch to push." }],
            isError: true
          };
        }

        // Guardrail: Enforcement of branch naming convention
        if (!targetBranch.startsWith("otto/")) {
          return {
            content: [
              {
                type: "text",
                text: `GuardrailViolation: Direct pushes to non-otto branch '${targetBranch}' are disabled. Branch name must start with 'otto/'`
              }
            ],
            isError: true
          };
        }

        // In-host credential injection
        const headers: Record<string, string> = {};
        if (env?.GITHUB_TOKEN) {
          headers["Authorization"] = `token ${env.GITHUB_TOKEN}`;
        }

        const pushRes = await workspace.git.push({
          dir,
          remote: args.remote ?? "origin",
          ref: targetBranch,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
          force: false
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: pushRes.ok,
                branch: targetBranch,
                refs: pushRes.refs
              })
            }
          ]
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: err instanceof Error ? err.message : String(err)
              })
            }
          ],
          isError: true
        };
      }
    }
  };

  return [cloneTool, checkoutTool, statusTool, diffTool, commitTool, pushTool];
}
