import type { HookRegistration, ToolRegistration } from "@earendil-works/pi-durable";
import type { PiHarness } from "agents/harness/pi";

/**
 * pi's own wording when it settles an unsafe tool call that a reset cut off
 * (`pi.tool` recovery: it will not rerun the call). It reaches us only as
 * text inside the tool result, so this is how the app recognises it.
 */
const PI_INTERRUPTED = /Tool (\S+) was interrupted and may have partially run/;

/** The tool a result was interrupted in, from pi's result text; else undefined. */
export function interruptedTool(text: string): string | undefined {
  return PI_INTERRUPTED.exec(text)?.[1];
}

/** What the UI shows on the card of an interrupted call. */
export function interruptedNotice(tool: string): string {
  return `Interrupted: the session restarted while ${tool} was running`;
}

/**
 * One structured log line per interrupted call, so a reset shows up in
 * Workers Logs as the tool it killed, not only as a CPU-limit event.
 *
 * pi writes the interrupted result without running `afterTool`, and hooks
 * cannot read entries, so `afterTools` (which runs once the round is
 * terminal) reads the round's results through the harness. It never blocks
 * pi: the read runs after the hook returns.
 */
export function createInterruptLog(
  harness: () => PiHarness,
  log: (line: string) => void = console.log
): HookRegistration {
  return {
    task: "pi.generation",
    handlers: {
      afterTools(_assistant: unknown, results: readonly number[], api: { conversationId: number }) {
        const session = String(api.conversationId);
        void (async () => {
          const wanted = new Set(results.map(String));
          for (const entry of await harness().session(session).messages()) {
            if (!wanted.has(String(entry.id))) continue;
            const message = entry.model?.[0];
            if (message?.role !== "toolResult" || !message.isError) continue;
            const text = message.content.map((part) => ("text" in part ? part.text : "")).join("\n");
            const tool = interruptedTool(text);
            if (!tool) continue;
            log(
              JSON.stringify({
                event: "tool_interrupted",
                session,
                tool,
                callId: message.toolCallId,
                message: interruptedNotice(tool)
              })
            );
          }
        })().catch((error) => console.warn("Could not log interrupted tools", error));
      }
    }
  };
}

/** The extension that carries the hook; it adds no tools or sections. */
export function interruptLogExtension(
  harness: () => PiHarness,
  log?: (line: string) => void
) {
  return {
    name: "interrupt-log",
    hooks: [createInterruptLog(harness, log)],
    tools: [] as ToolRegistration[]
  };
}
