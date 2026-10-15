import type { EgressProps } from "../egress";
import type { ContainerLike } from "../sandbox";

export type FakeExec = {
  readonly argv: readonly string[];
  readonly cwd?: string;
  /** The egress props in force when the command ran. */
  readonly egress: EgressProps | undefined;
};

export type FakeReply = { exitCode?: number; stdout?: string; stderr?: string };

function stream(text: string | undefined): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  });
}

/** The command without the `env ... timeout -k 5 <s>` wrapper the sandbox adds. */
export function unwrap(argv: readonly string[]): readonly string[] {
  const timeout = argv.indexOf("timeout");
  return argv[0] === "env" && timeout !== -1 ? argv.slice(timeout + 4) : argv;
}

/**
 * A stand-in for `ctx.container`: records every start, exec and egress
 * change, and answers commands from `reply`, which sees the command
 * without the sandbox's `env`/`timeout` wrapper.
 */
export class FakeContainer implements ContainerLike {
  running = false;
  readonly images = { workspace: "registry/workspace:test" };
  readonly starts: ContainerStartupOptions[] = [];
  readonly execs: FakeExec[] = [];
  readonly egressHistory: EgressProps[] = [];
  readonly snapshots: { id: string; name?: string }[] = [];
  egress: EgressProps | undefined;
  destroyed = 0;
  reply: (argv: readonly string[], cwd: string | undefined) => FakeReply = () => ({});

  start(options?: ContainerStartupOptions): void {
    this.running = true;
    this.starts.push(options!);
  }

  async exec(cmd: string[], options?: ContainerExecOptions): Promise<ExecProcess> {
    if (!this.running) throw new Error("exec() cannot be called on a container that is not running.");
    this.execs.push({ argv: cmd, cwd: options?.cwd, egress: this.egress });
    const reply = this.reply(unwrap(cmd), options?.cwd);
    const exitCode = reply.exitCode ?? 0;
    return {
      stdin: null,
      stdout: stream(reply.stdout),
      stderr: stream(reply.stderr),
      pid: 1,
      isPty: false,
      exitCode: Promise.resolve(exitCode),
      output: async () => ({
        stdout: new TextEncoder().encode(reply.stdout ?? "").buffer,
        stderr: new TextEncoder().encode(reply.stderr ?? "").buffer,
        exitCode
      }),
      kill() {},
      resize() {}
    } as ExecProcess;
  }

  async destroy(): Promise<void> {
    this.running = false;
    this.destroyed++;
  }

  monitor(): Promise<void> {
    return new Promise(() => {});
  }

  async setInactivityTimeout(): Promise<void> {}

  async interceptOutboundHttps(_addr: string, binding: Fetcher): Promise<void> {
    this.#setEgress(binding);
  }

  async interceptAllOutboundHttp(binding: Fetcher): Promise<void> {
    this.#setEgress(binding);
  }

  async snapshotContainer(options?: ContainerSnapshotOptions): Promise<ContainerSnapshot> {
    const snapshot = { id: `snap-${this.snapshots.length + 1}`, size: 1234, name: options?.name };
    this.snapshots.push(snapshot);
    return snapshot;
  }

  #setEgress(binding: Fetcher): void {
    const props = (binding as unknown as { props: EgressProps }).props;
    if (JSON.stringify(props) !== JSON.stringify(this.egress)) this.egressHistory.push(props);
    this.egress = props;
  }
}

/** `egress` for `SandboxOptions`: a fetcher that only carries its props. */
export function fakeEgress(props: EgressProps): Fetcher {
  return { props } as unknown as Fetcher;
}

/** Durable Object storage's get/put/delete over a Map. */
export function memoryStorage() {
  const map = new Map<string, unknown>();
  return {
    map,
    async get<T>(key: string): Promise<T | undefined> {
      return map.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      map.set(key, structuredClone(value));
    },
    async delete(key: string): Promise<boolean> {
      return map.delete(key);
    }
  } as unknown as Pick<DurableObjectStorage, "get" | "put" | "delete"> & { map: Map<string, unknown> };
}

export const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** Replies for a successful ufo prepare. */
export function ufoReplies(argv: readonly string[]): FakeReply {
  if (argv[0] === "git" && argv[1] === "ls-remote") return { stdout: `${COMMIT}\tHEAD\n` };
  if (argv[0] === "git" && argv[1] === "-C" && argv[3] === "rev-parse") return { stdout: `${COMMIT}\n` };
  if (argv[0] === "pnpm" && argv[1] === "install") return { stdout: "Packages: +397\ndone\n" };
  return {};
}
