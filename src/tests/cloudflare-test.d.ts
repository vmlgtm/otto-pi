import type { PiHarnessTestObject } from "./worker";

declare global {
  namespace Cloudflare {
    interface Env {
      LOADER?: WorkerLoader;
      PI_HARNESS_TEST: DurableObjectNamespace<PiHarnessTestObject>;
    }
  }
}

export {};
