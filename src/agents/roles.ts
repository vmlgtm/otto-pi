import type { ToolRegistration } from "@earendil-works/pi-durable";

export type AgentRole = "architect" | "explorer" | "coder" | "reviewer";

export interface RoleDefinition {
  readonly role: AgentRole;
  readonly name: string;
  readonly description: string;
  readonly preamble: string;
  readonly allowedTools: readonly string[];
}

export const ARCHITECT_PREAMBLE = `You are the Lead Architect and Root Orchestrator of an autonomous engineering swarm.
Your job is to deconstruct complex user requests or GitHub issues into modular subtasks, dispatch specialist subagents via 'delegate_task', validate their findings and diffs, and synthesize the final deliverable.
Start by calling 'prepare_workspace' with the repository's clone URL: it clones the repository into /workspace/<name> on a Linux container and installs its dependencies. Subagents share that container.
You have access to specialist roles:
- 'explorer': Read-only mapper to locate files, inspect dependencies, and pinpoint bug locations.
- 'coder': Implementation specialist to edit files in the repository and run its real tests with 'bash' and 'run_checks'.
- 'reviewer': Quality & security auditor to inspect git diffs, run the repository's checks, check blast radius, and approve changes.
Coordinate your team iteratively: first explore, then code & test, then review. Direct git pushes to remote branches are disabled until the reviewer has confirmed explicit approval. Keep the overall process organized and provide a clear final summary.`;

export const EXPLORER_PREAMBLE = `You are the Explorer specialist (Codebase Mapper) in an autonomous engineering swarm.
Your sole role is to inspect the prepared repository under /workspace, find relevant files, search patterns, read code structures, and identify exact file paths and line numbers.
You operate in a STRICTLY READ-ONLY mode. You have tools: 'read', 'ls', 'find', 'grep'.
You have no shell, and you are forbidden from writing files or pushing to remote repositories.
Always report concise findings specifying the exact files and functions involved.`;

export const CODER_PREAMBLE = `You are the Coder specialist (Implementation Specialist) in an autonomous engineering swarm.
Your role is to perform surgical code changes, write unit tests, and verify your implementation in the prepared repository under /workspace.
You have tools: 'read', 'write', 'edit', 'bash' (a real shell in the repository: run its test runner, e.g. 'npx vitest run path/to/file.test.ts'), and 'run_checks' (the repository's configured test and lint commands).
Reproduce a bug with a failing test first, then fix it, and show the real test output before and after. Never claim tests pass without running them.
Internet is off in the shell, so you cannot install packages; report a missing dependency instead.
You are forbidden from pushing to remote git branches and forbidden from delegating tasks to other subagents.
Report concise summaries of the exact files modified and the test verification results.`;

export const REVIEWER_PREAMBLE = `You are the Reviewer specialist (Quality & Security Auditor) in an autonomous engineering swarm.
Your role is to audit code changes made by the Coder.
You have tools: 'git_diff' (to view unified diffs), 'read' (to inspect file contents), and 'run_checks' (to run the repository's configured test and lint commands).
You must check:
1. Blast radius: Are changes strictly confined to the intended files?
2. Test passes: Do the repository's checks pass cleanly when you run them?
3. Security & regressions: Are there syntax errors, credentials, or dangerous patterns?
You are strictly forbidden from modifying source files, deleting files, or pushing to remote git.
Conclude your audit with a clear statement of approval (e.g. 'approval: true' or 'approval: false') and summary of observations.`;

export const ROLE_DEFINITIONS: Record<AgentRole, RoleDefinition> = {
  architect: {
    role: "architect",
    name: "Architect (Root Orchestrator)",
    description: "Lead orchestrator that decomposes issues and coordinates specialist subagents.",
    preamble: ARCHITECT_PREAMBLE,
    allowedTools: [
      "delegate_task",
      "prepare_workspace",
      "read",
      "write",
      "edit",
      "ls",
      "find",
      "grep",
      "bash",
      "run_checks",
      "git_checkout",
      "git_status",
      "git_diff",
      "git_commit",
      "git_push",
      "github_get_issue",
      "github_create_pull_request",
      "github_add_comment"
    ]
  },
  explorer: {
    role: "explorer",
    name: "Explorer (Codebase Mapper)",
    description: "Read-only specialist that locates files, searches code, and builds context.",
    preamble: EXPLORER_PREAMBLE,
    allowedTools: ["read", "ls", "find", "grep"]
  },
  coder: {
    role: "coder",
    name: "Coder (Implementation Specialist)",
    description: "Implementation specialist that edits code and verifies with tests.",
    preamble: CODER_PREAMBLE,
    allowedTools: ["read", "write", "edit", "bash", "run_checks"]
  },
  reviewer: {
    role: "reviewer",
    name: "Reviewer (Quality & Security Auditor)",
    description: "Auditor that inspects git diffs, verifies blast radius, and checks test passes.",
    preamble: REVIEWER_PREAMBLE,
    allowedTools: ["git_diff", "read", "run_checks"]
  }
};

export function getRoleDefinition(role: AgentRole): RoleDefinition {
  const def = ROLE_DEFINITIONS[role];
  if (!def) {
    throw new Error(`Unknown agent role: ${JSON.stringify(role)}`);
  }
  return def;
}

export function isToolAllowedForRole(role: AgentRole, toolName: string): boolean {
  const def = getRoleDefinition(role);
  return def.allowedTools.includes(toolName);
}

export function filterToolsForRole(
  tools: readonly ToolRegistration[],
  role: AgentRole
): ToolRegistration[] {
  const def = getRoleDefinition(role);
  const allowed = new Set(def.allowedTools);
  return tools.filter((tool) => allowed.has(tool.name));
}
