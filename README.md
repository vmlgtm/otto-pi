# otto-pi

A stateful, autonomous coding agent running on Cloudflare Workers, backed by SQLite-persisted Durable Objects.

`otto-pi` hosts [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi) inside a Cloudflare Durable Object. It combines persistent SQLite conversational state, a Linux container per session (Cloudflare Containers) for cloning repositories, installing dependencies and running their real test suites, real-time event streaming over WebSockets, and open-weights inference via Cloudflare Workers AI (`@cf/qwen/qwen3.8-27b`).

**Live Deployment**: [https://otto-pi.aspiring-nest.workers.dev/](https://otto-pi.aspiring-nest.workers.dev/)

---

## Core Capabilities

`otto-pi` is structured across four core implemented systems:

### 1. Container Shell & Self-Correction
* **A real Linux container per session**: `PiAgent` drives its own container through `ctx.container` (Sandbox SDK 1.0). `prepare_workspace` shallow-clones a configured repository into `/workspace/<name>` and installs its dependencies; the agent then runs the repository's real test runner with pi's `bash`, and edits files with pi's `read`, `write` and `edit` (on `ContainerEnv`, pi's `ExecutionEnv` for the container).
* **Self-correction loop**: The agent reproduces a bug with a failing test, fixes it, and shows the real test output before and after. `run_checks` runs the repository's configured test and lint commands for the Reviewer.
* **Strict Guardrails**: Internet only during clone and install (all egress goes through a Worker gateway), no credentials inside the container, 600-second cap per command (the whole process group is killed), 50 KB output kept in context, and the container stops 10 minutes after its last use.
* *Spec*: [docs/PHASE_4_CONTAINER_SANDBOX_HANDOFF.html](docs/PHASE_4_CONTAINER_SANDBOX_HANDOFF.html) (replaces the JavaScript-only `exec` of [Phase 1](docs/PHASE_1_HANDOFF.md)) · *Tests*: `src/tests/execution.test.ts`, `src/tests/sandbox.test.ts`, `src/tests/container-tools.test.ts`

### 2. Git Automation, GitHub PRs & Ecosystem Tools
* **Full Git Lifecycle**: `git_checkout`, `git_status`, `git_diff`, `git_commit`, and `git_push` run real git in the session's container. Cloning belongs to `prepare_workspace`.
* **GitHub Integration**: Fetches issues (`github_get_issue`), posts updates (`github_add_comment`), and opens draft Pull Requests (`github_create_pull_request`).
* **Security & Secret Scrubbing**: Automatic regex sanitization masks API tokens (`ghp_*`, `github_pat_*`) before broadcasting events over WebSockets. Direct pushes to `main`/`master` and force-pushes are blocked. The token never enters the container: the egress gateway adds it only to the one push `git_push` allowed, so `git push` typed into `bash` fails for lack of credentials.
* **Webhook Ingestion**: Secure `POST /api/webhooks/github` receiver with HMAC-SHA256 signature verification to trigger autonomous triage.
* *Spec*: [docs/PHASE_2_MCP_TOOLS_HANDOFF.md](docs/PHASE_2_MCP_TOOLS_HANDOFF.md) · *Tests*: `src/tests/git.test.ts`, `src/tests/sanitize.test.ts`, `src/tests/webhook.test.ts`

### 3. Multi-Agent Swarms via Pi Subagents
* **Specialist Role Separation**:
  - **Lead Architect** (Root Session): Breaks down issues, delegates work, and handles PR submissions.
  - **Explorer** (Read-Only): Locates relevant files and dependencies using `read`, `ls`, `grep`, `find`. Cannot modify code.
  - **Coder** (Container shell): Modifies files and verifies fixes by running real tests with `bash` and `run_checks`. Forbidden from pushing to remote.
  - **Reviewer** (Auditor): Audits `git_diff` and runs `run_checks` before signing off. No shell.
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
│   ├── Sandbox: ctx.container (one Linux container per session)       │
│   │    - ContainerEnv: pi's read, write, edit, bash on the container   │
│   │    - prepare_workspace, run_checks, ls, find, grep, git_*          │
│   ├── OttoEgress: every container request, token added on push only  │
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
│   ├── sandbox.ts                  # Container lifecycle, prepare_workspace, idle stop, snapshots
│   ├── container-env.ts            # ContainerEnv: pi's ExecutionEnv on the container
│   ├── container-tools.ts          # pi's coding tools, ls/find/grep, prepare_workspace, run_checks
│   ├── egress.ts                   # OttoEgress: the container's only way out; adds the push token
│   ├── repos.ts                    # Repositories Otto may prepare, with install/test commands
│   ├── interrupted.ts              # Interrupted-tool notice and tool_interrupted log line
│   ├── git-tools.ts                # Git operations (branch, status, diff, commit, push)
│   ├── github-tools.ts             # GitHub API tools (get_issue, create_pr, add_comment)
│   ├── mcp.ts                      # Model Context Protocol adapter & tool proxy
│   ├── sanitize.ts                 # Regex secret & token scrubber
│   ├── client.tsx                  # React frontend with session switching & streaming UI
│   ├── protocol.ts                 # Client/server WebSocket protocol types
│   ├── server.ts                   # PiAgent Durable Object and Worker entrypoint
│   ├── sockets.ts                  # WebSocket connection manager and event broadcaster
│   └── tests/
│       ├── execution.test.ts       # Shell execution, self-correction, output limits
│       ├── sandbox.test.ts         # Container lifecycle, egress phases, snapshots
│       ├── container-tools.test.ts # Search tools, bash limits, run_checks
│       ├── interrupted.test.ts     # A tool cut off by a reset ends in a visible error
│       ├── fake-container.ts       # ctx.container stand-in with an in-memory filesystem
│       ├── git.test.ts             # Git branch, commit, push guardrails, PR creation
│       ├── mcp.test.ts             # MCP client & tool proxying
│       ├── multi-agent.test.ts     # Role scoping, depth limits, swarm delegation (10 tests)
│       ├── sanitize.test.ts        # Credential scrubbing tests (8 tests)
│       ├── webhook.test.ts         # GitHub webhook signature verification (5 tests)
│       ├── sockets.test.ts         # WebSocket lifecycle and reconnects (3 tests)
│       ├── view.test.ts            # Event fold/reducer snapshot tests (1 test)
│       └── worker.ts               # Test worker fixture with mock LLM provider
├── container/                      # Workspace image: entrypoint and the otto-fs helper
├── scripts/                        # Podman wrappers for local container runs
├── Dockerfile                      # Workspace image (Node 24 + Node 22, git, sandbox-shim)
├── wrangler.jsonc                  # Cloudflare Worker configuration & bindings
└── vite.config.ts                  # Vite + Tailwind + Cloudflare plugin setup
```

---

## Local Development & Testing

### Prerequisites
- Node.js 20+
- `pnpm` 9+
- Cloudflare Wrangler CLI authenticated (`pnpm exec wrangler login`)
- A container engine: `pnpm start` and `pnpm run deploy` build the workspace image. With Docker, nothing else is needed. With Podman, use `scripts/dev-podman.sh` (see NOTES.md, "Podman, and this Mac's network").

### Setup & Run
```sh
pnpm install
pnpm run start            # Docker
./scripts/dev-podman.sh   # Podman
```

`.dev.vars` holds local secrets (`GITHUB_TOKEN`) and `DEV_ROUTES=1`, which enables `POST /api/dev/conformance` (pi's `ExecutionEnv` conformance suite against the real container) and `/api/dev/sandbox`. Never set `DEV_ROUTES` on the deployed Worker. `SANDBOX_SNAPSHOTS=on` lets `prepare_workspace` reuse an installed workspace per repository and commit.

### Test Suite
The test suite runs with `@cloudflare/vitest-pool-workers`:
```sh
# Typecheck
pnpm run typecheck

# Run full Vitest suite (no container engine needed: tests use a fake container)
pnpm run test
```

### Deployment
```sh
pnpm run deploy
```

---

## License

MIT. See [licenses/mit-earendil-pi.txt](licenses/mit-earendil-pi.txt).
