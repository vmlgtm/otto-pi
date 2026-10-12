# otto-pi

A stateful coding agent running on Cloudflare Workers, backed by SQLite-persisted Durable Objects.

`otto-pi` hosts [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi) inside a Cloudflare Durable Object. It provides persistent conversational sessions, an isolated virtual filesystem (`/workspace`), real-time event streaming over WebSockets, and open-weights inference via Cloudflare Workers AI (`@cf/qwen/qwen3.8-27b`).

**Live Deployment**: [https://otto-pi.aspiring-nest.workers.dev/](https://otto-pi.aspiring-nest.workers.dev/)

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
│   │    - Manages task queue, recovery, retry policy, and events        │
│   │    - Heartbeat lifecycle alarm wakes the DO during active runs     │
│   ├── Workspace: @cloudflare/computer at `/workspace`                  │
│   │    - SQLite-backed virtual POSIX filesystem                        │
│   │    - Tools: read, write, edit, delete, ls, find, grep              │
│   └── Sockets: PiSessionSockets                                        │
│        - Dispatches submit, abort, reset                               │
│        - Streams AgentEvent diffs to connected clients                 │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Roadmap & Architecture Handoffs

The project evolution is specified across three implementation handoff documents:

| Phase | Specification | Status | Key Deliverable |
| :--- | :--- | :--- | :--- |
| **Phase 1** | [docs/PHASE_1_HANDOFF.md](docs/PHASE_1_HANDOFF.md) | Ready for Execution | Sandboxed code execution (`exec`), `stdout`/`stderr` capture, 15s timeouts, self-correction loop |
| **Phase 2** | [docs/PHASE_2_MCP_TOOLS_HANDOFF.md](docs/PHASE_2_MCP_TOOLS_HANDOFF.md) | Ready for Execution | Model Context Protocol (MCP) client, Git clone/branch/commit tools, GitHub PR automation, webhook triage |
| **Phase 3** | [docs/PHASE_3_MULTI_AGENT_HANDOFF.md](docs/PHASE_3_MULTI_AGENT_HANDOFF.md) | Ready for Execution | Multi-agent swarms via `harness.sessions.fork()`, role separation (Architect, Explorer, Coder, Reviewer), context condensation |

---

## Project Structure

```
├── docs/
│   ├── PHASE_1_HANDOFF.md          # Execution sandbox & guardrails specification
│   ├── PHASE_2_MCP_TOOLS_HANDOFF.md# MCP & GitHub tools specification
│   └── PHASE_3_MULTI_AGENT_HANDOFF.md # Multi-agent swarms & role specification
├── src/
│   ├── client.tsx                  # React frontend with session switching & streaming UI
│   ├── protocol.ts                 # Client/server WebSocket protocol types
│   ├── server.ts                   # PiAgent Durable Object and Worker entrypoint
│   ├── sockets.ts                  # WebSocket connection manager and event broadcaster
│   ├── transcript.ts               # Pi entry record projection for display
│   ├── use-pi-session.ts           # React hook for session state & WebSocket lifecycle
│   ├── view.ts                     # AgentEvent stream reducer
│   ├── workspace.ts                # Filesystem tools registration
│   └── tests/
│       ├── sockets.test.ts         # WebSocket lifecycle and reconnect tests
│       ├── view.test.ts            # Event fold/reducer snapshot tests
│       └── worker.ts               # Test worker fixture with mock LLM provider
├── wrangler.jsonc                  # Cloudflare Worker configuration & bindings
└── vite.config.ts                  # Vite + Tailwind + Cloudflare plugin setup
```

---

## Local Development

### Prerequisites
- Node.js 20+
- `pnpm` 9+
- Cloudflare Wrangler CLI authenticated (`pnpm exec wrangler login`)

### Setup & Run
```sh
# Install dependencies
pnpm install

# Start local dev server (Vite + Cloudflare Workers preview)
pnpm run start
```

### Running Tests
The test suite runs against `@cloudflare/vitest-pool-workers`:
```sh
# Typecheck
pnpm run typecheck

# Run Vitest suite
pnpm run test
```

### Deployment
Deploy to Cloudflare Workers:
```sh
pnpm run deploy
```

---

## License

MIT. See [licenses/mit-earendil-pi.txt](licenses/mit-earendil-pi.txt).
