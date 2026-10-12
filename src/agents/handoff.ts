import type { EntryRecord } from "@earendil-works/pi-durable";
import { projectEntries, type PiMessage } from "../transcript";
import type { AgentRole } from "./roles";

export interface HandoffSummaryOptions {
  readonly role: AgentRole;
  readonly task: string;
  readonly status: "completed" | "turn_limit_reached" | "timed_out" | "error";
  readonly entries: readonly EntryRecord[];
  readonly filesModified?: readonly string[];
  readonly turnCount?: number;
  readonly errorMessage?: string;
  readonly lastText?: string;
}

const MAX_SUMMARY_CHARS = 1800; // ~450 tokens

/**
 * Extracts paths of all files modified (via write, edit) in a session's entries.
 */
export function extractFilesModified(entries: readonly EntryRecord[]): string[] {
  const messages = projectEntries(entries);
  const modified = new Set<string>();

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool-call") {
        if (part.name === "write" || part.name === "edit") {
          const args = part.arguments as any;
          if (args && typeof args.path === "string") {
            modified.add(args.path);
          }
        }
      }
    }
  }

  return Array.from(modified);
}

/**
 * Generates a dense, structured handoff summary (<= 500 tokens)
 * from subagent entries to prevent context window saturation in the lead orchestrator.
 */
export function generateHandoffSummary(options: HandoffSummaryOptions): string {
  const { role, task, status, entries, errorMessage, lastText } = options;
  const messages = projectEntries(entries);
  const filesModified = options.filesModified ?? extractFilesModified(entries);

  // Collect key assistant text and tool executions
  const assistantTexts: string[] = [];
  const toolActions: string[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.parts) {
        if (part.type === "text" && part.text.trim()) {
          assistantTexts.push(part.text.trim());
        } else if (part.type === "tool-call") {
          toolActions.push(`${part.name}`);
        }
      }
    } else if (msg.role === "tool") {
      for (const part of msg.parts) {
        if (part.type === "tool-result") {
          if (part.error) {
            toolActions.push(`${part.name} (failed)`);
          }
        }
      }
    }
  }

  // Derive findings/conclusion
  let conclusion = lastText || assistantTexts.at(-1) || "";
  if (errorMessage) {
    conclusion = conclusion ? `${conclusion}\nError: ${errorMessage}` : `Error: ${errorMessage}`;
  }

  // Build bullet points
  const lines: string[] = [];
  lines.push(`### Role: ${role.toUpperCase()} | Status: ${status}`);
  lines.push(`**Task**: ${task.length > 120 ? task.slice(0, 117) + "..." : task}`);
  if (options.turnCount !== undefined) {
    lines.push(`**Turns**: ${options.turnCount}`);
  }
  if (filesModified.length > 0) {
    lines.push(`**Files Modified**: ${filesModified.join(", ")}`);
  } else {
    lines.push(`**Files Modified**: None`);
  }

  if (toolActions.length > 0) {
    const summaryTools = toolActions.slice(-6).join(", ");
    lines.push(`**Actions Executed**: ${summaryTools}`);
  }

  if (conclusion) {
    // Truncate conclusion if needed to maintain token economy
    const trimmedConclusion = conclusion.length > 800 ? conclusion.slice(0, 797) + "..." : conclusion;
    lines.push(`**Summary**: ${trimmedConclusion}`);
  }

  let fullSummary = lines.join("\n");
  if (fullSummary.length > MAX_SUMMARY_CHARS) {
    fullSummary = fullSummary.slice(0, MAX_SUMMARY_CHARS - 20) + "\n[Summary truncated]";
  }

  return fullSummary;
}

/**
 * Creates a dense handoff note string suitable for passing to session.reset(handoffNote).
 */
export function createHandoffNote(options: HandoffSummaryOptions): string {
  const summary = generateHandoffSummary(options);
  return `[SUBAGENT HANDOFF CHECKPOINT]\n${summary}`;
}
