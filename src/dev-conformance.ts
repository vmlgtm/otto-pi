import { createEnvConformance, type EnvConformanceAssertions } from "@earendil-works/pi-durable/testing";
import { ContainerEnv } from "./container-env";
import type { Sandbox } from "./sandbox";

function fail(message: string): never {
  throw new Error(message);
}

function show(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (item instanceof Uint8Array ? Array.from(item) : item));
}

function deepEqual(actual: unknown, expected: unknown): boolean {
  return show(actual) === show(expected);
}

function partial(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (actual === null || typeof actual !== "object") return false;
  return Object.entries(expected).every(([key, value]) => partial((actual as Record<string, unknown>)[key], value));
}

const assertions: EnvConformanceAssertions = {
  ok: (value, message) => (value ? undefined : fail(message ?? `expected truthy, got ${show(value)}`)),
  strictEqual: (actual, expected) =>
    Object.is(actual, expected) ? undefined : fail(`expected ${show(expected)}, got ${show(actual)}`),
  deepEqual: (actual, expected) =>
    deepEqual(actual, expected) ? undefined : fail(`expected ${show(expected)}, got ${show(actual)}`),
  partialDeepEqual: (actual, expected) =>
    partial(actual, expected) ? undefined : fail(`expected to contain ${show(expected)}, got ${show(actual)}`),
  greaterThan: (actual, expected) => (actual > expected ? undefined : fail(`expected ${actual} > ${expected}`)),
  rejects: async (operation, messageIncludes) => {
    try {
      await operation;
    } catch (error) {
      if (String(error).includes(messageIncludes)) return;
      fail(`rejected with ${String(error)}, expected "${messageIncludes}"`);
    }
    fail("expected a rejection");
  }
};

export type ConformanceReport = {
  readonly passed: number;
  readonly failed: number;
  readonly cases: readonly { name: string; ok: boolean; ms: number; error?: string }[];
};

/**
 * pi's own `ExecutionEnv` conformance suite against the real container,
 * each case in a fresh /workspace/conformance/<id>. DEV_ROUTES only.
 */
export async function runConformance(sandbox: Sandbox, filter?: string): Promise<ConformanceReport> {
  const cases = createEnvConformance({
    assertions,
    withEnv: async (use) => {
      const dir = `/workspace/conformance/${crypto.randomUUID()}`;
      await sandbox.run(["mkdir", "-p", dir]);
      try {
        await use(new ContainerEnv(sandbox, { id: "container:conformance", cwd: dir }));
      } finally {
        await sandbox.run(["rm", "-rf", dir]);
      }
    }
  });
  const results: { name: string; ok: boolean; ms: number; error?: string }[] = [];
  for (const testCase of cases) {
    if (filter && !testCase.name.includes(filter)) continue;
    const start = Date.now();
    try {
      await Promise.race([
        testCase.run(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("case timed out")), testCase.timeoutMs ?? 20_000)
        )
      ]);
      results.push({ name: testCase.name, ok: true, ms: Date.now() - start });
    } catch (error) {
      results.push({ name: testCase.name, ok: false, ms: Date.now() - start, error: String(error) });
    }
  }
  return {
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    cases: results
  };
}
