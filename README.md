# otto-pi

A stateful, autonomous coding agent running on Cloudflare Workers, backed by SQLite-persisted Durable Objects.

`otto-pi` hosts [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi) inside a Cloudflare Durable Object. It combines persistent SQLite conversational state, an embedded virtual filesystem (`/workspace`), real-time event streaming over WebSockets, and open-weights inference via Cloudflare Workers AI (`@cf/qwen/qwen3.8-27b`).

**Live Deployment**: [https://otto-pi.aspiring-nest.workers.dev/](https://otto-pi.aspiring-nest.workers.dev/)

---

## Core Capabilities

`otto-pi` is structured across three core implemented systems:

### 1. Sandboxed Code Execution & Self-Correction
* **Closed-loop execution**: Exposes an isolated `exec` tool that runs code inside `/workspace`, capturing `stdout`, `stderr`, and exit codes.
* **Self-correction loop**: The agent observes test failures or runtime exceptions in `stderr`, edits the code, and re-runs until passing.
* **Strict Guardrails**: Hard 15-second execution timeout on hanging promises/loops, 50 KB output truncation to prevent context blowup, and filesystem confinement.
* *Spec*: [docs/PHASE_1_HANDOFF.md](docs/PHASE_1_HANDOFF.md) · *Tests*: `src/tests/execution.test.ts`

### 2. Git Automation, GitHub PRs & Ecosystem Tools
* **Full Git Lifecycle**: Native tools for `git_clone`, `git_checkout`, `git_status`, `git_diff`, `git_commit`, and `git_push` over `@cloudflare/computer/git`.
* **GitHub Integration**: Fetches issues (`github_get_issue`), posts updates (`github_add_comment`), and opens draft Pull Requests (`github_create_pull_request`).
* **Security & Secret Scrubbing**: Automatic regex sanitization masks API tokens (`ghp_*`, `github_pat_*`) before broadcasting events over WebSockets. Direct pushes to `main`/`master` and force-pushes are blocked.
* **Webhook Ingestion**: Secure `POST /api/webhooks/github` receiver with HMAC-SHA256 signature verification to trigger autonomous triage.
* *Spec*: [docs/PHASE_2_MCP_TOOLS_HANDOFF.md](docs/PHASE_2_MCP_TOOLS_HANDOFF.md) · *Tests*: `src/tests/git.test.ts`, `src/tests/sanitize.test.ts`, `src/tests/webhook.test.ts`

### 3. Multi-Agent Swarms via Pi Subagents
* **Specialist Role Separation**:
  - **Lead Architect** (Root Session): Breaks down issues, delegates work, and handles PR submissions.
  - **Explorer** (Read-Only): Locates relevant files and dependencies using `read`, `ls`, `grep`, `find`. Cannot modify code.
  - **Coder** (Sandbox): Modifies files and verifies fixes via `exec`. Forbidden from pushing to remote.
  - **Reviewer** (Auditor): Audits `git_diff` and checks blast radius before signing off.
* **Session Branching**: Uses `harness.sessions.fork()` and `harness.sessions.create()` to branch conversations in SQLite without polluting the parent transcript.
* **Context Condensation**: Subagents compress verbose trial-and-error logs into structured summaries (`≤ 500 tokens`) before reporting back.
* **Concurrency & Depth Limits**: Max hierarchy depth of 2 (subagents cannot spawn subagents), max 3 concurrent child sessions, and a 10-turn limit per subagent.
* *Spec*: [docs/PHASE_3_MULTI_AGENT_HANDOFF.md](docs/PHASE_3_MULTI_AGENT_HANDOFF.md) · *Tests*: `src/tests/multi-agent.test.ts`

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ Client (Browser)                                                       │
│  - React + Kumo UI                                                     │
│  - WebSocket client with automatic snapshot recovery                   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ WebSockets (/agents/pi-agent/<id>)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Cloudflare Worker (otto-pi)                                            │
│                                                                        │
│  PiAgent (Durable Object instance per session)                         │
│   ├── Storage: SQLite database on Durable Object storage               │
│   ├── Inference: Workers AI binding (`@cf/qwen/qwen3.8-27b`)           │
│   ├── Harness: PiHarness (@earendil-works/pi-durable)                   │
│   │    - Task queues, recovery, retry policy, and AgentEvent streams   │
│   │    - Multi-session branching (create, fork, reset handoffs)        │
│   ├── Workspace: @cloudflare/computer at `/workspace`                  │
│   │    - SQLite-backed virtual POSIX filesystem                        │
│   │    - Tools: read, write, edit, delete, ls, find, grep, exec, git   │
│   ├── Multi-Agent Orchestrator: SubagentTracker                        │
│   │    - Spawns Explorer, Coder, Reviewer with scoped registries       │
│   └── Sockets: PiSessionSockets                                        │
│        - Dispatches submit, abort, reset                               │
│        - Secret-scrubbed AgentEvent diff streaming to clients          │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Authenticated Git / HTTP
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ External Services                                                      │
│  - GitHub API (Issues, PRs, Webhooks)                                  │
│  - Remote Git Repositories                                             │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
├── docs/
│   ├── PHASE_1_HANDOFF.md          # Execution sandbox & guardrails specification
│   ├── PHASE_2_MCP_TOOLS_HANDOFF.md# Git, GitHub & MCP tools specification
│   └── PHASE_3_MULTI_AGENT_HANDOFF.md # Multi-agent swarms & role specification
├── src/
│   ├── agents/
│   │   ├── roles.ts                # Role definitions (Architect, Explorer, Coder, Reviewer)
│   │   ├── orchestrator.ts         # Multi-session delegator & SubagentTracker
│   │   └── handoff.ts              # Context condensation & summary generator
│   ├── git-tools.ts                # Git operations (clone, branch, commit, push, diff)
│   ├── github-tools.ts             # GitHub API tools (get_issue, create_pr, add_comment)
│   ├── mcp.ts                      # Model Context Protocol adapter & tool proxy
│   ├── sanitize.ts                 # Regex secret & token scrubber
│   ├── client.tsx                  # React frontend with session switching & streaming UI
│   ├── protocol.ts                 # Client/server WebSocket protocol types
│   ├── server.ts                   # PiAgent Durable Object and Worker entrypoint
│   ├── sockets.ts                  # WebSocket connection manager and event broadcaster
│   ├── workspace.ts                # Tool registry and filesystem bindings
│   └── tests/
│       ├── execution.test.ts       # Code execution, timeouts, and self-correction (8 tests)
│       ├── git.test.ts             # Git clone, branch, commit, push, PR creation (14 tests)
│       ├── mcp.test.ts             # MCP client & tool proxying
│       ├── multi-agent.test.ts     # Role scoping, depth limits, swarm delegation (10 tests)
│       ├── sanitize.test.ts        # Credential scrubbing tests (8 tests)
│       ├── webhook.test.ts         # GitHub webhook signature verification (5 tests)
│       ├── sockets.test.ts         # WebSocket lifecycle and reconnects (3 tests)
│       ├── view.test.ts            # Event fold/reducer snapshot tests (1 test)
│       └── worker.ts               # Test worker fixture with mock LLM provider
├── wrangler.jsonc                  # Cloudflare Worker configuration & bindings
└── vite.config.ts                  # Vite + Tailwind + Cloudflare plugin setup
```

---

## Local Development & Testing

### Prerequisites
- Node.js 20+
- `pnpm` 9+
- Cloudflare Wrangler CLI authenticated (`pnpm exec wrangler login`)

### Setup & Run
```sh
pnpm install
pnpm run start
```

### Test Suite (54 Tests)
The test suite runs with `@cloudflare/vitest-pool-workers`:
```sh
# Typecheck
pnpm run typecheck

# Run full Vitest suite (all 8 test files)
pnpm run test
```

### Deployment
```sh
pnpm run deploy
```

---

## License

MIT. See [licenses/mit-earendil-pi.txt](licenses/mit-earendil-pi.txt).
