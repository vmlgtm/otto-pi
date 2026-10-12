import type { PiHarnessTestObject } from "./worker";

declare global {
  namespace Cloudflare {
    interface Env {
      LOADER?: WorkerLoader;
      PI_HARNESS_TEST: DurableObjectNamespace<PiHarnessTestObject>;
      GITHUB_TOKEN?: string;
      GITHUB_APP_PRIVATE_KEY?: string;
      GITHUB_WEBHOOK_SECRET?: string;
      MCP_SERVERS?: string;
    }
  }
}

export {};
