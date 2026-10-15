import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration, EntryRecord } from "@earendil-works/pi-durable";
import { ROOT_SESSION, type PiHarness, type PiModel, type PiPromptResponse } from "agents/harness/pi";
import {
  type AgentRole,
  getRoleDefinition,
  filterToolsForRole
} from "./roles";
import {
  extractFilesModified,
  generateHandoffSummary,
  createHandoffNote
} from "./handoff";
import type { SubagentInfo, SubagentStatus } from "../protocol";

const BACKGROUND_CONTEXT = Object.freeze({
  abortSignal: void 0,
  value: () => void 0,
  toString: () => "[Context pi-harness background]"
});

export const MAX_CONCURRENT_SUBAGENTS = 3;
export const MAX_SUBAGENT_TURNS = 10;
export const MAX_SUBAGENT_TIMEOUT_MS = 60_000;

export interface DelegateTaskInput {
  role: "explorer" | "coder" | "reviewer";
  task: string;
  mode?: "fresh" | "fork";
  context?: string;
  timeoutMs?: number;
}

export interface DelegateTaskResult {
  sessionId: string;
  role: "explorer" | "coder" | "reviewer";
  status: SubagentStatus;
  summary: string;
  filesModified: string[];
  turnCount: number;
}

export interface SubagentEventEmitter {
  broadcastSubagentStart(subagent: SubagentInfo): void;
  broadcastSubagentDone(subagent: SubagentInfo): void;
}

/**
 * Manages tracking, SQLite durability, and concurrency for subagents.
 */
export class SubagentTracker {
  readonly #activeSessions = new Set<string>();
  readonly #subagents = new Map<string, SubagentInfo>();
  readonly #storage?: any;
  readonly #emitter?: SubagentEventEmitter;

  constructor(storage?: any, emitter?: SubagentEventEmitter) {
    this.#storage = storage;
    this.#emitter = emitter;
    this.#initTable();
  }

  #initTable(): void {
    if (this.#storage?.sql) {
      try {
        this.#storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS subagent_tasks (
            session_id TEXT PRIMARY KEY,
            parent_session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            task TEXT NOT NULL,
            status TEXT NOT NULL,
            summary TEXT,
            files_modified TEXT,
            turn_count INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
        `);
      } catch (err) {
        console.warn("Could not create subagent_tasks table:", err);
      }
    }
  }

  getActiveCount(): number {
    return this.#activeSessions.size;
  }

  isAtCapacity(): boolean {
    return this.#activeSessions.size >= MAX_CONCURRENT_SUBAGENTS;
  }

  recordStart(info: SubagentInfo): void {
    this.#activeSessions.add(info.sessionId);
    this.#subagents.set(info.sessionId, info);

    if (this.#storage?.sql) {
      try {
        this.#storage.sql.exec(
          `INSERT OR REPLACE INTO subagent_tasks (
            session_id, parent_session_id, role, task, status, summary, files_modified, turn_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          info.sessionId,
          info.parentSessionId,
          info.role,
          info.task,
          info.status,
          info.summary ?? null,
          JSON.stringify(info.filesModified ?? []),
          info.turnCount ?? 0,
          info.createdAt,
          info.updatedAt
        );
      } catch (err) {
        console.warn("Could not persist subagent start in SQLite:", err);
      }
    }

    this.#emitter?.broadcastSubagentStart(info);
  }

  recordDone(info: SubagentInfo): void {
    this.#activeSessions.delete(info.sessionId);
    this.#subagents.set(info.sessionId, info);

    if (this.#storage?.sql) {
      try {
        this.#storage.sql.exec(
          `UPDATE subagent_tasks SET
            status = ?, summary = ?, files_modified = ?, turn_count = ?, updated_at = ?
          WHERE session_id = ?`,
          info.status,
          info.summary ?? null,
          JSON.stringify(info.filesModified ?? []),
          info.turnCount ?? 0,
          info.updatedAt,
          info.sessionId
        );
      } catch (err) {
        console.warn("Could not persist subagent completion in SQLite:", err);
      }
    }

    this.#emitter?.broadcastSubagentDone(info);
  }

  async list(parentSessionId?: string): Promise<SubagentInfo[]> {
    if (this.#storage?.sql) {
      try {
        const query = parentSessionId
          ? `SELECT * FROM subagent_tasks WHERE parent_session_id = ? ORDER BY created_at ASC`
          : `SELECT * FROM subagent_tasks ORDER BY created_at ASC`;
        const params = parentSessionId ? [parentSessionId] : [];
        const rows = this.#storage.sql.exec(query, ...params).toArray();
        return rows.map((r: any) => ({
          sessionId: r.session_id,
          parentSessionId: r.parent_session_id,
          role: r.role as any,
          task: r.task,
          status: r.status as any,
          summary: r.summary ?? undefined,
          filesModified: r.files_modified ? JSON.parse(r.files_modified) : [],
          turnCount: r.turn_count,
          createdAt: r.created_at,
          updatedAt: r.updated_at
        }));
      } catch {
        // Fallback to in-memory map
      }
    }

    const all = Array.from(this.#subagents.values());
    if (parentSessionId) {
      return all.filter((s) => s.parentSessionId === parentSessionId);
    }
    return all;
  }
}

export const DelegateTaskParameters = Type.Object({
  role: Type.Union(
    [
      Type.Literal("explorer"),
      Type.Literal("coder"),
      Type.Literal("reviewer")
    ],
    {
      description:
        "Specialist role: 'explorer' (read-only mapper), 'coder' (surgical edits & test runner), 'reviewer' (audit diffs & blast radius)"
    }
  ),
  task: Type.String({
    description: "Detailed, actionable task instruction for the specialist subagent"
  }),
  mode: Type.Optional(
    Type.Union([Type.Literal("fresh"), Type.Literal("fork")], {
      description:
        "Provisioning mode: 'fresh' (clean session) or 'fork' (inherits parent transcript). Defaults to 'fresh'."
    })
  ),
  context: Type.Optional(
    Type.String({
      description:
        "Dense technical context, file references, or findings passed from previous specialists"
    })
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description: "Maximum execution timeout in ms (capped at 60,000ms)"
    })
  )
});

export interface CreateDelegateTaskToolOptions {
  harness: PiHarness;
  /** Paths git reports as changed in the shared workspace; best effort. */
  changedFiles?: () => Promise<string[]>;
  allTools: readonly ToolRegistration[];
  tracker: SubagentTracker;
  defaultModel?: PiModel;
}

/**
 * Creates the core `delegate_task` tool for the Lead Architect orchestrator.
 */
export function createDelegateTaskTool(
  options: CreateDelegateTaskToolOptions
): ToolRegistration<typeof DelegateTaskParameters> {
  const { harness, changedFiles, allTools, tracker, defaultModel } = options;

  return {
    name: "delegate_task",
    description: `Delegate an engineering task to a specialist subagent ('explorer', 'coder', or 'reviewer'). The subagent operates with role-scoped tools and returns a dense summary. Enforces depth, turn, and concurrency limits.`,
    parameters: DelegateTaskParameters,
    replay: "safe",
    async execute(args, api) {
      const parentSessionId = String(api.conversationId ?? ROOT_SESSION);

      // Guardrail 1: Max Hierarchy Depth = 2 (Root Depth 0 -> Subagents Depth 1).
      // Subagents are strictly forbidden from spawning further subagents.
      if (parentSessionId !== ROOT_SESSION) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error:
                  "RecursionGuardrailViolation: Subagents (depth > 0) are strictly forbidden from spawning further subagents."
              })
            }
          ],
          isError: true
        };
      }

      // Guardrail 2: Concurrency Cap = Max 3 concurrent subagent sessions.
      if (tracker.isAtCapacity()) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `ConcurrencyLimitReached: Maximum ${MAX_CONCURRENT_SUBAGENTS} concurrent subagent sessions allowed.`
              })
            }
          ],
          isError: true
        };
      }

      const role = args.role as AgentRole;
      const roleDef = getRoleDefinition(role);
      const roleTools = filterToolsForRole(allTools, role);

      // 1. Provision child session
      const mode = args.mode ?? "fresh";
      let childSession;
      try {
        if (mode === "fork") {
          childSession = await harness.sessions.fork(parentSessionId);
        } else {
          childSession = await harness.sessions.create();
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Failed to provision subagent session: ${err instanceof Error ? err.message : String(err)}`
              })
            }
          ],
          isError: true
        };
      }

      const childSessionId = childSession.id;
      if (defaultModel) {
        try {
          await childSession.setModel(defaultModel);
        } catch (err) {
          console.warn("Could not set model on child session:", err);
        }
      }

      // 2. Configure child conversation registry and preamble
      try {
        const conversation = await harness.conversation(childSessionId);
        await conversation.configure(
          {
            tools: roleTools,
            instructions: roleDef.preamble
          },
          BACKGROUND_CONTEXT as any
        );
      } catch (err) {
        console.warn("Could not configure child conversation:", err);
      }

      const createdAt = Date.now();
      const subagentInfo: SubagentInfo = {
        sessionId: childSessionId,
        parentSessionId,
        role: args.role,
        task: args.task,
        status: "running",
        createdAt,
        updatedAt: createdAt
      };
      tracker.recordStart(subagentInfo);

      // Format prompt for subagent
      const promptText = args.context
        ? `[Context from Lead Architect]\n${args.context}\n\n[Assigned Task]\n${args.task}`
        : args.task;

      // 3. Enforce Turn Limit (max 10) and Wall-Clock Timeout (max 60s)
      const effectiveTimeoutMs = Math.min(
        args.timeoutMs ?? MAX_SUBAGENT_TIMEOUT_MS,
        MAX_SUBAGENT_TIMEOUT_MS
      );

      let turnCount = 0;
      let turnLimitReached = false;
      let timedOut = false;
      let promptResponse: PiPromptResponse | undefined;

      const eventsStream = await childSession.events();
      eventsStream.start(async (batch) => {
        for (const ev of batch) {
          if (ev.type === "turn_start") {
            turnCount++;
            if (turnCount >= MAX_SUBAGENT_TURNS) {
              turnLimitReached = true;
              void childSession.abort();
            }
          }
        }
      });

      const timer = setTimeout(() => {
        timedOut = true;
        void childSession.abort();
      }, effectiveTimeoutMs);

      try {
        promptResponse = await childSession.prompt(promptText);
      } catch (err) {
        console.warn("Child session prompt threw error:", err);
      } finally {
        clearTimeout(timer);
        try {
          await eventsStream.stop();
        } catch {}
      }

      // 4. Retrieve child session messages and post-process
      let entries: EntryRecord[] = [];
      try {
        entries = await childSession.messages();
      } catch {}

      // Calculate final turn count
      const assistantTurns = entries.filter(
        (e) => e.kind === "pi.assistant" || e.model?.[0]?.role === "assistant"
      ).length;
      const finalTurnCount = Math.max(turnCount, assistantTurns);

      // Determine final status
      let finalStatus: SubagentStatus = "completed";
      if (turnLimitReached || finalTurnCount >= MAX_SUBAGENT_TURNS) {
        finalStatus = "turn_limit_reached";
      } else if (timedOut) {
        finalStatus = "turn_limit_reached"; // Spec: subagent terminates after 10 turns or 60s reporting turn_limit_reached
      } else if (promptResponse?.status === "unanswered") {
        finalStatus = "turn_limit_reached";
      } else if (!promptResponse && !turnLimitReached && !timedOut) {
        finalStatus = "error";
      }

      // 5. Detect files modified
      let filesModified = extractFilesModified(entries);
      try {
        const gitModified = (await changedFiles?.()) ?? [];
        filesModified = Array.from(new Set([...filesModified, ...gitModified]));
      } catch {}

      // 6. Condense verbose logs into a dense handoff summary (<= 500 tokens)
      const summary = generateHandoffSummary({
        role,
        task: args.task,
        status: finalStatus,
        entries,
        filesModified,
        turnCount: finalTurnCount,
        lastText: promptResponse?.text
      });

      // 7. Reset child session with dense handoff note checkpoint
      try {
        const handoffNote = createHandoffNote({
          role,
          task: args.task,
          status: finalStatus,
          entries,
          filesModified,
          turnCount: finalTurnCount,
          lastText: promptResponse?.text
        });
        await childSession.reset(handoffNote);
      } catch (err) {
        console.warn("Could not checkpoint child session with reset:", err);
      }

      const completedInfo: SubagentInfo = {
        sessionId: childSessionId,
        parentSessionId,
        role: args.role,
        task: args.task,
        status: finalStatus,
        summary,
        filesModified,
        turnCount: finalTurnCount,
        createdAt,
        updatedAt: Date.now()
      };
      tracker.recordDone(completedInfo);

      const result: DelegateTaskResult = {
        sessionId: childSessionId,
        role: args.role,
        status: finalStatus,
        summary,
        filesModified,
        turnCount: finalTurnCount
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ],
        details: result as any
      };
    }
  };
}
