# Phase 2 Handoff: Model Context Protocol (MCP) & Ecosystem Tools Integration (`otto-pi`)

## 1. Executive Summary & Objective

**Project**: `otto-pi` ([GitHub Repository](https://github.com/vmlgtm/otto-pi) | [Live Edge Deployment](https://otto-pi.aspiring-nest.workers.dev/))  
**Target Milestone**: Phase 2 (Roadmap Phase 4) — **Model Context Protocol (MCP) & Ecosystem Tools**  
**Prerequisite**: Phase 1 (Isolated Code Execution & Sandboxing) completed or baseline filesystem operational.  
**Assignee Agent**: Autonomous Engineering Agent / Implementer  

### The Objective
Transform `otto-pi` from a **local sandbox agent** into a **connected engineering agent**. Equip `otto-pi` with:
1. **Model Context Protocol (MCP) Client Architecture**: Dynamic discovery and invocation of external MCP tools (GitHub, Sentry, Linear, Postgres, documentation servers).
2. **First-Class Git & GitHub Integration**: Capability to ingest GitHub issues, clone remote repositories directly into `/workspace`, create isolated Git branches, commit changes, and submit Pull Requests.
3. **Webhook Ingestion**: Secure endpoints to trigger autonomous triage and fix workflows from external events (e.g. GitHub webhook on issue opened, Sentry alert).

---

## 2. Technical Baseline & Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ Cloudflare Edge (Worker: otto-pi)                                      │
│                                                                        │
│  External Ingestion (Webhooks: GitHub / Sentry / Slack)                │
│       │                                                                │
│       ▼                                                                │
│  PiAgent (Durable Object, SQLite-backed)                               │
│    ├── PiHarness (@earendil-works/pi-durable)                          │
│    │     └── Model: Workers AI (@cf/qwen/qwen3.8-27b)                 │
│    │                                                                   │
│    ├── PiRegistry (src/workspace.ts & src/mcp.ts)                      │
│    │     ├── Local Tools: read, write, edit, ls, grep, exec (Phase 1)  │
│    │     ├── Native Git Tools: clone, checkout, branch, commit, push  │
│    │     └── MCP Client Proxy: dynamic tools from MCP servers          │
│    │                                                                   │
│    └── Workspace (@cloudflare/computer)                                │
│          ├── SQLite virtual filesystem at /workspace                   │
│          └── Git Client (@cloudflare/computer/git + @platformatic/vfs) │
└──────────────────────────┬─────────────────────────────────────────────┘
                           │ Authenticated HTTP / SSE / stdio
                           ▼
┌────────────────────────────────────────────────────────────────────────┐
│ External Ecosystem (MCP Servers & APIs)                                │
│  - GitHub API / GitHub MCP (Issues, Pull Requests, Reviews)            │
│  - Issue Trackers (Linear / Jira MCP)                                  │
│  - Observability (Sentry / Datadog MCP)                                │
└────────────────────────────────────────────────────────────────────────┘
```

### Key Dependencies & Infrastructure:
- `@modelcontextprotocol/sdk`: Client transport for connecting to remote MCP servers over HTTP/SSE.
- `@cloudflare/computer/git`: Integrated isomorphic-git client attached to `Workspace` on the Durable Object's SQLite storage.
- Cloudflare Secret Bindings: `env.GITHUB_TOKEN`, `env.GITHUB_APP_PRIVATE_KEY`, `env.MCP_SERVERS`.

---

## 3. Scope of Work

The implementing agent must implement the following three components:

### Component A: First-Class Git & GitHub PR Automation Tools
1. **Git Remote Tools in `src/workspace.ts`**:
   - Utilize `Workspace.git` (`createGitClient()` from `@cloudflare/computer/git` with `@platformatic/vfs`).
   - Register the following durable tools in `PiRegistry`:
     - `git_clone`: Clone a remote GitHub repository into `/workspace/<repo>`.
     - `git_checkout`: Switch or create a new feature branch (e.g. `otto/fix-issue-123`).
     - `git_status` & `git_diff`: Inspect staged/unstaged changes.
     - `git_commit`: Commit modified files with a structured commit message.
     - `git_push`: Push the branch to the remote origin using the injected credential.
2. **GitHub API Client Tools**:
   - `github_get_issue`: Fetch issue title, body, comments, and labels.
   - `github_create_pull_request`: Open a draft or ready PR linking the issue, describing changes, and summarizing test results.
   - `github_add_comment`: Post progress updates or triage questions on an issue.

### Component B: MCP Client Manager (`src/mcp.ts`)
1. Create a dynamic MCP tool adapter that connects `PiRegistry` with remote MCP servers:
   - Read configured MCP server endpoints from `env.MCP_SERVERS` (JSON config in Cloudflare Worker secrets).
   - Connect via `SSEServerTransport` or `StreamTransport` from `@modelcontextprotocol/sdk`.
   - Map each MCP tool definition (`name`, `description`, `inputSchema`) into a Pi-compatible `ToolRegistration`.
2. Tool namespacing: Prefix external MCP tools to prevent collision (e.g. `github__get_issue`, `sentry__get_issue`).

### Component C: Webhook Event Ingestion (`src/server.ts`)
1. Add a secure webhook receiver route `POST /api/webhooks/github`:
   - Validate HMAC signature (`X-Hub-Signature-256`) against `env.GITHUB_WEBHOOK_SECRET`.
   - On `issues.opened` or `issue_comment.created` (e.g., when tagged `@otto-pi fix`):
     - Provision or resolve a session Durable Object via `env.PiAgent.idFromName(issueKey)`.
     - Dispatch the initial triage prompt into `harness.submit(...)`.

---

## 4. Strict Guardrails

> [!CAUTION]
> ### 1. Secret Protection & Zero Token Leakage
> - **Never Inject Secrets into Transcripts**: API tokens (`GITHUB_TOKEN`, private keys) must NEVER be exposed in prompt text, tool input arguments, tool output strings, or WebSocket client messages.
> - **In-Host Credential Injection**: When `git_clone` or `git_push` runs, the auth header / token must be injected directly in worker runtime code inside the git transport headers, not constructed as plaintext by the LLM.
> - **Redaction Filter**: Implement an output sanitizer in `src/sockets.ts` that regex-masks any string matching GitHub token patterns (`ghp_`, `gho_`, `github_pat_`) before broadcasting events to WebSocket clients.

> [!WARNING]
> ### 2. Blast-Radius & Protected Branch Guardrails
> - **No Direct Pushes to Default Branches**: The agent is strictly forbidden from pushing to `main`, `master`, `release`, or `production`.
> - **Branch Name Enforcement**: All agent-created branches must follow the strict pattern: `otto/<issue-id>-<short-description>`.
> - **Draft Pull Requests First**: All PRs created by the agent must default to `draft: true` unless explicitly instructed with a human-in-the-loop override.
> - **No Force Pushes**: `git push --force` or `--force-with-lease` must be blocked at the tool implementation level.

> [!IMPORTANT]
> ### 3. Rate-Limiting & Cost Protection
> - **GitHub API Throttling**: Implement exponential backoff when handling GitHub API `403 rate limit exceeded` or `429 Too Many Requests`.
> - **Repo Size Clamping**: Clones must use `--depth 1` (shallow clone) by default to prevent filling SQLite storage with large git historical objects (`.git/objects`). Max repo size: 100 MB.
> - **Pagination Limits**: Issue and PR search queries must limit results to a maximum of 10 items per tool call.

> [!NOTE]
> ### 4. Replay Safety for External Side Effects
> - External mutations (`git_push`, `github_create_pull_request`, `github_add_comment`) are **non-idempotent**.
> - Register these tools with `replay: "interrupted"` on `PiRegistry`. If the Durable Object hibernates or restarts during a push or PR creation, it must NOT execute twice. Idempotency keys or state flags must be checked before calling remote APIs.

---

## 5. Definition of Done (DoD)

The phase is considered complete only when all the following criteria are met:

1. **Native Git Automation Operational**:
   - The agent can clone a public/private repo into `/workspace`, create a branch, write changes, commit with author signature, and push the branch.
2. **GitHub API Tools Registered & Working**:
   - `github_get_issue`, `github_create_pull_request`, and `github_add_comment` are registered in the catalog and callable by the agent.
3. **MCP Tool Bridge Functional**:
   - `src/mcp.ts` connects to at least one remote MCP server via HTTP/SSE, discovers its tools, and dynamically registers them into `PiRegistry`.
4. **End-to-End Autonomous Issue-to-PR Flow Verified**:
   - Given a GitHub issue URL, the agent autonomously:
     1. Fetches issue details and reproduces the bug.
     2. Modifies code in `/workspace`.
     3. Runs the test suite via Phase 1 sandbox (`exec`) until passing.
     4. Commits changes and pushes a feature branch.
     5. Opens a draft Pull Request with description and test proof.
5. **Security & Guardrail Verification**:
   - Pushes to `main` are rejected with a clear guardrail violation error.
   - Token patterns are absent from all WebSocket messages and logs.
   - Signature verification rejects unauthenticated webhook requests.
6. **Code Quality & Tests**:
   - Unit tests covering Git tools, MCP adapter, and secret scrubbing pass (`pnpm run test`).
   - `pnpm run typecheck` passes with 0 errors.
   - `pnpm run build` succeeds cleanly.

---

## 6. Verification Steps (Testing Plan)

### Step 1: Automated Local Test Suite
```bash
pnpm run typecheck
pnpm run test
```
*Expected Result*: All existing tests plus new unit tests for `src/mcp.ts` and `src/git.ts` pass with 100% success.

### Step 2: Secret Scrubbing Verification
Run the sanitization test suite:
```bash
# Verify that simulated tool outputs containing 'ghp_xxxx' are masked to 'ghp_[REDACTED]'
```
*Expected Result*: WebSocket broadcast never contains raw tokens.

### Step 3: End-to-End Autonomous Issue-to-PR Verification
Create a test issue in a test repository (e.g. `vmlgtm/otto-pi-playground` or a dummy branch) with the prompt:
> *"Resolve issue #1 on repo `vmlgtm/test-repo`: Fix typo in README.md. Create a branch, commit the fix, and open a draft PR."*

*Expected Result*:
1. Agent calls `github_get_issue` -> retrieves issue description.
2. Agent calls `git_clone` -> clones into `/workspace/test-repo`.
3. Agent calls `git_checkout` -> creates branch `otto/issue-1-fix-typo`.
4. Agent calls `edit` -> updates `README.md`.
5. Agent calls `git_commit` -> commits changes.
6. Agent calls `git_push` -> pushes to remote.
7. Agent calls `github_create_pull_request` -> returns PR URL.
8. Agent reports the created PR URL back to the user.

### Step 4: Protected Branch Rejection Test
Prompt the agent:
> *"Commit this change directly to `main` and force push."*

*Expected Result*:
Tool execution immediately aborts with: `GuardrailViolation: Direct pushes to protected branch 'main' are disabled`.

### Step 5: Webhook Trigger Test
Send a signed mock webhook payload:
```bash
curl -X POST "http://localhost:8787/api/webhooks/github" \
  -H "X-Hub-Signature-256: sha256=..." \
  -H "X-GitHub-Event: issues" \
  -d '{"action":"opened","issue":{"number":42,"title":"Test bug","body":"Please fix"}}'
```
*Expected Result*: HTTP 202 Accepted, Durable Object session initialized, and triage started.

---

## 7. Deliverables & PR Checklist

- [ ] `src/mcp.ts`: MCP Client manager and dynamic tool registration.
- [ ] `src/git-tools.ts`: Git operations (`clone`, `branch`, `commit`, `push`) over `@cloudflare/computer/git`.
- [ ] `src/github-tools.ts`: GitHub REST API tools (`get_issue`, `create_pr`).
- [ ] `src/sanitize.ts`: Credential masking filter for WebSocket outputs.
- [ ] `src/server.ts`: Webhook listener route with HMAC-SHA256 signature verification.
- [ ] Integration test suite in `src/tests/mcp.test.ts` and `src/tests/git.test.ts`.
- [ ] Git commit pushed to `vmlgtm/otto-pi` on branch `feat/phase-2-mcp-github-tools`.
