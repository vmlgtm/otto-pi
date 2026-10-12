# Phase 1 Handoff: Isolated Code Execution & Sandboxing (`otto-pi`)

## 1. Executive Summary & Objective

**Project**: `otto-pi` ([GitHub Repository](https://github.com/vmlgtm/otto-pi) | [Live Edge Deployment](https://otto-pi.aspiring-nest.workers.dev/))  
**Target Milestone**: Phase 1 — **Isolated Code Execution & Sandboxing**  
**Assignee Agent**: Autonomous Engineering Agent / Implementer  

### The Objective
Upgrade `otto-pi` from a **passive filesystem agent** (which can only `read`, `write`, `edit`, `delete`, `ls`, `find`, `grep` files in `/workspace`) to an **active execution agent** that can execute code, capture `stdout`/`stderr`, observe test failures, and execute a closed self-correction loop in an isolated, secure environment.

---

## 2. Technical Baseline & Current Architecture

Before making changes, the incoming agent must understand the baseline system:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Cloudflare Edge (Worker: otto-pi)                                      │
│                                                                        │
│  WebSocket Client (src/client.tsx)                                     │
│       │                                                                │
│       ▼                                                                │
│  PiAgent (Durable Object, SQLite-backed)                               │
│    ├── PiHarness (@earendil-works/pi-durable)                          │
│    │     └── Model: Workers AI (@cf/qwen/qwen3.8-27b)                 │
│    ├── Workspace (@cloudflare/computer)                                │
│    │     └── SQLite virtual filesystem at /workspace                   │
│    └── PiSessionSockets (src/sockets.ts)                              │
│          └── Event stream snapshot & commit batches                    │
└────────────────────────────────────────────────────────────────────────┘
```

### Current Key Files:
- `src/server.ts`: Instantiates `PiAgent` Durable Object, registers `Workspace`, `createRegistry()`, `PiHarness`, and `WebSockets`.
- `src/workspace.ts`: Registers durable filesystem tools with `replay: "safe"` tags. `WorkerJavaScriptBackend` is currently omitted/optional.
- `src/sockets.ts`: Manages WebSocket connections and automatically syncs session models.
- `wrangler.jsonc`: Cloudflare configuration for bindings (`env.AI`, `env.PiAgent`).
- `src/tests/`: Vitest test suite (`view.test.ts`, `sockets.test.ts`) running on `@cloudflare/vitest-pool-workers`.

---

## 3. Scope of Work

The implementing agent must implement **Option A** (preferred native) or **Option B** (container sandbox):

### Option A: Native Cloudflare Dynamic Worker Backend (JavaScript/TypeScript ES Modules)
1. Add `worker_loaders` binding to `wrangler.jsonc`:
   ```jsonc
   "worker_loaders": [{ "binding": "LOADER" }]
   ```
2. Enable `WorkerJavaScriptBackend` in `src/server.ts`:
   - Root: `/workspace`
   - Access: `"read-write"`
   - Network: `allowGitNetwork: false` (unless specific git operations)
3. Expose `exec` tool in `src/workspace.ts` that allows the model to execute ES modules that import `node:fs/promises`.
4. Ensure `exec` is marked with `replay: "interrupted"` (NOT `"safe"`), so Durable Object eviction crashes don't accidentally re-run non-idempotent code.

### Option B: Cloudflare Sandbox SDK / Container Runner (Polyglot: Node, Python, Bash)
If arbitrary shell commands (e.g. `python`, `pytest`, `npm test`) are required:
1. Integrate `@cloudflare/sandbox` into the Durable Object or Worker fetch route.
2. Provide a tool `bash` / `exec_command` that passes commands to the sandbox and streams stdout/stderr back.
3. Synchronize `/workspace` files into the sandbox working directory before execution.

---

## 4. Strict Guardrails

The implementing agent must enforce the following non-negotiable guardrails:

> [!CAUTION]
> ### 1. Sandboxing & Blast-Radius Isolation
> - **Zero Host Access**: The sandbox must NOT have access to the Durable Object's host memory, SQLite storage internals (`pi_*` tables), or environment secrets (`env.AI`, API tokens).
> - **Session Isolation**: Sessions must never share an execution environment. Session A cannot view or modify the workspace or processes of Session B.

> [!WARNING]
> ### 2. Resource & Execution Quotas
> - **Execution Timeout**: Enforce a strict execution deadline (default **15 seconds**, maximum **30 seconds**). If a process hangs (infinite loop, unresolving promise), the worker must terminate execution and return a timeout error (`Execution timed out after 15000ms`).
> - **Output Truncation**: Cap `stdout` and `stderr` to **50 KB (or 2,000 lines)**. Excess output must be truncated with a warning notice (`[Output truncated at 50KB...]`) to prevent LLM context window exhaustion and token blowout.
> - **Memory / Worker Limits**: Limit sandbox worker memory to avoid crashing the host Durable Object.

> [!IMPORTANT]
> ### 3. Network & Security Restrictions
> - **No Arbitrary Outbound Network Access**: The code execution backend must have outbound network access disabled (`network: "none"` or `allowNetwork: false`). The agent must not be able to perform SSRF attacks against Cloudflare internal metadata services, private VPCs, or malicious external endpoints.
> - **Filesystem Jail**: All read and write operations initiated by `exec` must be jailed inside `/workspace`. Paths outside (e.g. `/`, `../`, `../../etc`) must fail with access denied.

> [!NOTE]
> ### 4. Replay Safety & State Management
> - Durable Objects can hibernate or restart at any time. Non-idempotent executions (`exec`) must **never** be re-executed silently on reboot. Pi's `replay: "interrupted"` pattern must be respected so the model receives an interruption error and decides whether to retry.

---

## 5. Definition of Done (DoD)

The phase is considered complete only when all the following criteria are met:

1. **Tool Availability**:
   - The agent catalog sent over WebSocket includes an execution tool (e.g., `exec` or `run_code`) with a clear JSON Schema describing its input and behavior.
2. **Execution & Feedback Loop**:
   - The tool runs code in `/workspace`.
   - Returns structured results:
     ```json
     {
       "exitCode": 0,
       "stdout": "...",
       "stderr": "...",
       "durationMs": 142
     }
     ```
   - Standard output and error streams are correctly fed back into Pi's conversation transcript.
3. **Automated Self-Correction Verified**:
   - Given a deliberate error (e.g. a failing assertion or syntax error), the agent receives the error stacktrace in `stderr` and produces a subsequent patch that resolves the failure without human intervention.
4. **All Guardrails Enforced**:
   - Infinite loop scripts (e.g. `while(true) {}`) abort within 15 seconds.
   - Large output (>100KB) is cleanly truncated.
   - Filesystem escape attempts outside `/workspace` fail gracefully.
5. **Quality & Tests**:
   - Unit and integration tests added in `src/tests/` verifying `exec` execution, timeout handling, and output capture.
   - `pnpm run typecheck` passes with 0 errors.
   - `pnpm run test` (Vitest Pool Workers) passes 100%.
   - Build (`pnpm run build`) completes cleanly.

---

## 6. Verification Steps (Testing Plan)

The verifying agent or human reviewer must execute the following verification steps:

### Step 1: Automated Local Test Suite
Run local typechecking and tests:
```bash
pnpm run typecheck
pnpm run test
```
*Expected Result*: All tests pass, including newly added tests for execution and timeouts.

### Step 2: Verification of Tool Registration
Inspect the catalog received by the client upon WebSocket connection (`hello` event):
```bash
# Connect to WebSocket and check initial 'hello' payload
# Verify that 'exec' or 'run_code' is present with description
```

### Step 3: Happy Path Execution Test
Submit prompt:
> *"Write a script to `/workspace/calc.js` that calculates factorial of 6, run it with `exec`, and explain the result."*

*Expected Result*:
1. Agent calls `write` tool to create `/workspace/calc.js`.
2. Agent calls `exec` tool.
3. Output returns `stdout: "720"`.
4. Agent responds plainly: `Factorial of 6 is 720`.

### Step 4: Self-Correction Loop Test
Submit prompt:
> *"Write a test in `/workspace/math.test.js` that asserts add(2, 2) === 5. Run it, observe the error, fix the function to add(2, 2) === 4, and re-run until it passes."*

*Expected Result*:
1. First run outputs `AssertionError` in `stderr` with non-zero exit code.
2. Agent inspects `stderr`, updates the code via `edit` or `write`.
3. Agent re-runs `exec`.
4. Tests pass, and agent reports success.

### Step 5: Guardrail Stress Tests
1. **Timeout Test**: Submit script `while(true) {}` or `await new Promise(() => {})`.
   - *Expected*: Fails with timeout error after ≤15s, agent handles error gracefully without hanging the Durable Object.
2. **Output Bomb Test**: Submit script `for(let i=0; i<100000; i++) console.log("spam")`.
   - *Expected*: Output truncated at 50KB with truncation warning, client UI renders smoothly without crashing.
3. **Sandbox Escape Test**: Submit script attempting to access `process.env`, `DurableObjectStorage`, or read `/etc/passwd`.
   - *Expected*: Restricted / blocked by sandbox runtime.

---

## 7. Deliverables & PR Checklist

- [ ] Code changes in `src/workspace.ts`, `src/server.ts`, and `wrangler.jsonc`.
- [ ] Integration test suite in `src/tests/execution.test.ts`.
- [ ] Git commit pushed to `vmlgtm/otto-pi` on branch `feat/phase-1-sandboxed-execution`.
- [ ] Verification report detailing results of all 5 verification steps above.
