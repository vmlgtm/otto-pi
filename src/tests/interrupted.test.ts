import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PiSessionView } from "../view";

describe("a tool cut off by a reset", () => {
  it("ends in a visible interrupted error, not a running card", async () => {
    const name = crypto.randomUUID();
    const stub = env.PI_HARNESS_TEST.getByName(name);
    await stub.submit("gate-unsafe");
    await stub.gateStarted(1);

    // The CPU-limit reset in production: the isolate dies mid-tool.
    await abortAllDurableObjects();

    // pi will not rerun an unsafe tool; the wake alarm must still settle it.
    // A stub that saw the abort stays broken; the platform hands out a new one.
    const restarted = env.PI_HARNESS_TEST.getByName(name);
    let view: PiSessionView | undefined;
    for (let i = 0; i < 50; i++) {
      await runDurableObjectAlarm(restarted);
      view = JSON.parse(await restarted.snapshotView()) as PiSessionView;
      if (!view.running) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(view?.tools).toEqual([]);
    expect(view?.running).toBe(false);
    const result = view?.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool-result" && part.name === "gate_unsafe");
    expect(result).toMatchObject({
      error: true,
      interrupted: "Interrupted: the session restarted while gate_unsafe was running"
    });
    const logged = (await restarted.logs()).map((line) => JSON.parse(line));
    expect(logged).toContainEqual(
      expect.objectContaining({ event: "tool_interrupted", tool: "gate_unsafe", session: "1" })
    );
    // The gate ran once: pi did not replay it.
    expect(await restarted.gateStarted(1)).toBe(1);
  });
});
