# Phase 3 Handoff: Multi-Agent Swarms via Pi Subagents (`otto-pi`)

## 1. Executive Summary & Objective

**Project**: `otto-pi` ([GitHub Repository](https://github.com/vmlgtm/otto-pi) | [Live Edge Deployment](https://otto-pi.aspiring-nest.workers.dev/))  
**Target Milestone**: Phase 3 — **Multi-Agent Swarms & Pi Subagents Collaboration**  
**Prerequisites**: Phase 1 (Execution Sandbox) and Phase 2 (MCP & Ecosystem Tools) completed.  
**Assignee Agent**: Autonomous Engineering Agent / Implementer  

### The Objective
Evolve `otto-pi` from a **single solo worker** into a **coordinated multi-agent engineering team**. Leverage `PiHarness` session primitives (`harness.sessions.fork()`, `harness.sessions.create()`, `session.reset(handoff)`) to delegate complex engineering tasks across specialized roles (Architect, Explorer, Coder, Reviewer). Prevent context window saturation and hallucinations by confining verbose logs and exploration to branched subagent transcripts and passing structured handoff summaries back to the lead orchestrator.

---

## 2. Technical Baseline & Architecture

```
                               ┌────────────────────────┐
                               │   User / Webhook       │
                               └───────────┬────────────┘
                                           │
                                           ▼
                               ┌────────────────────────┐
                               │ Lead Architect Agent   │
                               │ (Root Session: "1")    │
                               └─────┬────────────┬─────┘
                                     │            │
                      fork / create  │            │  fork / create
                                     ▼            ▼
                      ┌─────────────────┐      ┌─────────────────┐
                      │ Explorer Agent  │      │   Coder Agent   │
                      │ (Read-Only)     │      │ (Sandboxed DO)  │
                      │ - grep, find    │      │ - write, edit   │
                      │ - read_file     │      │ - exec (tests)  │
                      └────────┬────────┘      └────────┬────────┘
                               │                        │
                      handoff  │                        │ diff & test result
                      summary  └───────────┬────────────┘
                                           │
                                           ▼
                               ┌────────────────────────┐
                               │ Reviewer/Auditor Agent │
                               │ - blast radius check   │
                               │ - git_diff inspection  │
                               │ - security audit       │
                               └───────────┬────────────┘
                                           │ approval / sign-off
                                           ▼
                               Lead PR Submission & Final Report
```

### Pi Harness Multi-Session Capabilities:
- `this.harness.sessions.create()`: Spawns a clean top-level conversation session inside the Durable Object's SQLite storage.
- `this.harness.sessions.fork(fromSessionId)`: Forks an existing conversation, inheriting history up to the latest entry without mutating the source transcript.
- `session.reset(handoffNote)`: Purges conversational cruft and starts a fresh checkpoint with a dense handoff context.
- `session.events()`: Streams real-time event updates to the client for individual subagent sessions.

---

## 3. Scope of Work

The implementing agent must implement the following three components:

### Component A: Specialist Role Definitions & Tool Scoping (`src/agents/roles.ts`)
Define distinct agent roles with strictly scoped permissions and system prompt preambles:

1. **Architect (Root Orchestrator)**:
   - *Role*: Deconstructs issues into a task dependency graph, provisions subagents, validates results, and interfaces with the user/GitHub.
   - *Tools*: `delegate_task`, `github_create_pull_request`, `github_add_comment`.
2. **Explorer (Codebase Mapper)**:
   - *Role*: Locates relevant files, identifies dependencies, and builds technical context.
   - *Tools (Read-Only)*: `read`, `ls`, `find`, `grep`. Forbidden from modifying files or running commands.
3. **Coder (Implementation Specialist)**:
   - *Role*: Surgical edits and automated test fixes in `/workspace`.
   - *Tools*: `read`, `write`, `edit`, `exec` (from Phase 1). Forbidden from pushing to remote Git.
4. **Reviewer (Quality & Security Auditor)**:
   - *Role*: Inspects git diffs, verifies test passes, checks blast radius, and flags security regressions.
   - *Tools*: `git_diff`, `read`, `exec` (lint/typecheck only). Forbidden from modifying source files or pushing.

### Component B: Subagent Orchestration Tool (`src/agents/orchestrator.ts`)
Expose a core tool on the Root Orchestrator:
```typescript
interface DelegateTaskInput {
  role: "explorer" | "coder" | "reviewer";
  task: string;
  mode: "fresh" | "fork";
  context?: string;
  timeoutMs?: number;
}
```
When invoked:
1. Provisions a child session via `this.harness.sessions.fork(currentId)` or `this.harness.sessions.create()`.
2. Installs role-specific tools and system preamble on the session registry.
3. Submits the prompt to the child session and waits for settlement (`session.prompt(task)`).
4. Calls `session.reset(handoff)` if necessary to condense verbose trial-and-error logs into an actionable summary.
5. Returns structured JSON to the Architect:
   ```json
   {
     "sessionId": "pi-sub-42",
     "role": "coder",
     "status": "completed",
     "summary": "Fixed bug in auth.ts; verified 4/4 unit tests pass",
     "filesModified": ["src/auth.ts"],
     "turnCount": 4
   }
   ```

### Component C: Multi-Session WebSocket & UI Projection (`src/sockets.ts` & `src/client.tsx`)
1. Extend WebSocket protocol to announce active subagent sessions (`subagents:list`, `subagent:start`, `subagent:done`).
2. Add a subagent tab / timeline view in the UI:
   - Allows the user to observe the Architect delegating work, inspect child session event streams, and see diffs generated by the Coder.

---

## 4. Strict Guardrails

> [!CAUTION]
> ### 1. Recursion Depth & Subagent Hierarchy Limits
> - **Max Hierarchy Depth = 2**: Root Architect (Depth 0) may spawn Subagents (Depth 1). Subagents are strictly forbidden from spawning further subagents. The `delegate_task` tool must NOT be installed on child session registries.
> - **Concurrency Cap**: Maximum **3 concurrent subagent sessions** active at any given moment within a Durable Object to prevent SQLite lock contention and CPU starvation.

> [!WARNING]
> ### 2. Token Budget & Turn Limits
> - **Max Turn Limit**: Each subagent run is capped at a maximum of **10 conversational turns** (tool rounds). If a subagent does not converge within 10 turns, it is forcefully aborted and returns its current partial state with `status: "turn_limit_reached"`.
> - **Timeout Cap**: Hard wall-clock timeout of **60 seconds per subagent operation**.
> - **Context Condensation Rule**: Transcripts of subagents are never dumped verbatim into the parent context. Only dense structured summaries (`≤ 500 tokens`) are returned to the Architect.

> [!IMPORTANT]
> ### 3. Privilege Escalation & Side-Effect Isolation
> - **Read-Only Lock on Explorers**: The Explorer role must have zero write capability. Tool execution must fail if file writes are attempted.
> - **No Remote Pushes from Subagents**: Neither the Explorer, Coder, nor Reviewer may call `git_push` or external mutating APIs. Only the Lead Architect may commit and push once the Reviewer has issued an explicit approval.
> - **Workspace Sandboxing**: Subagents share the single `/workspace` filesystem within the session's Durable Object, but file locks or Git branch worktrees must ensure the Reviewer does not review while the Coder is actively editing.

> [!NOTE]
> ### 4. Replay Safety & State Durability
> - All child session IDs and task linkages must be persisted in SQLite. If the Durable Object hibernates mid-delegation, `onStart()` must re-attach watchers and resume pending child tasks without duplicating prompt submissions.

---

## 5. Definition of Done (DoD)

The phase is considered complete only when all the following criteria are met:

1. **Role Separation Enforced**:
   - Distinct roles (`explorer`, `coder`, `reviewer`) have isolated tool registries and preambles.
   - Verification confirms Explorer cannot write, Coder cannot push to remote, and Reviewer cannot modify source code.
2. **Autonomous Swarm Pipeline Verified**:
   - An end-to-end task is solved cooperatively:
     1. Architect receives task and calls `delegate_task(role: "explorer")`.
     2. Explorer locates the bug and reports the file and function.
     3. Architect calls `delegate_task(role: "coder")`.
     4. Coder modifies the file and runs tests via sandbox `exec` until passing.
     5. Architect calls `delegate_task(role: "reviewer")`.
     6. Reviewer audits `git_diff`, verifies blast radius, and gives `approval: true`.
     7. Architect opens draft PR and presents the final summary to the user.
3. **Context Economy Proven**:
   - The Root Architect transcript remains clean and compact (< 2,500 tokens total), despite child agents running dozens of grep and execution commands.
4. **All Guardrails Enforced**:
   - Attempts to spawn subagents from within subagents are rejected.
   - Infinite loops or stuck subagents abort cleanly at 10 turns without crashing the host Durable Object.
5. **Test Suite & Build**:
   - Integration tests in `src/tests/multi-agent.test.ts` pass with 100% success.
   - `pnpm run typecheck` and `pnpm run build` succeed with 0 errors.

---

## 6. Verification Steps (Testing Plan)

### Step 1: Automated Local Test Suite
```bash
pnpm run typecheck
pnpm run test
```
*Expected Result*: All existing tests plus new multi-agent lifecycle tests pass cleanly.

### Step 2: Privilege Boundary Verification
Simulate an Explorer agent attempting to call `write`:
```typescript
// Test that explorer registry rejects mutating tools
```
*Expected Result*: Tool not found / access denied error.

### Step 3: Turn-Limit & Timeout Guardrail Verification
Spawn a Coder subagent with an unresolvable prompt (e.g. `while(true)` or circular problem):
*Expected Result*: Subagent terminates after 10 turns or 60s, reporting `status: "turn_limit_reached"`, and the parent Architect handles the failure gracefully.

### Step 4: End-to-End Multi-Agent Bug Resolution Scenario
Submit prompt to `otto-pi`:
> *"Fix the failing sorting algorithm in `/workspace/sort.js` and add unit tests. Have the explorer locate it, the coder fix it and verify with tests, and the reviewer audit the diff before you report back."*

*Expected Result*:
1. Root Architect dispatches `explorer` -> returns exact line with bug.
2. Root Architect dispatches `coder` -> updates file, runs `exec` to verify tests pass.
3. Root Architect dispatches `reviewer` -> audits git diff, confirms no unintended files were changed.
4. Root Architect responds with the final resolution summary.
5. Context inspection verifies subagent log noise was condensed and did not bloat the root transcript.

---

## 7. Deliverables & PR Checklist

- [ ] `src/agents/roles.ts`: Role definitions, system prompts, and tool registries.
- [ ] `src/agents/orchestrator.ts`: `delegate_task` implementation using `harness.sessions`.
- [ ] `src/agents/handoff.ts`: Context summarization and handoff note generator.
- [ ] `src/sockets.ts`: Multi-session event routing for WebSocket client.
- [ ] `src/client.tsx`: Subagent progress timeline indicator in the web UI.
- [ ] Integration test suite in `src/tests/multi-agent.test.ts`.
- [ ] Git commit pushed to `vmlgtm/otto-pi` on branch `feat/phase-3-multi-agent-swarms`.
