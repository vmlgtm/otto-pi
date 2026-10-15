import { posix } from "node:path";
import type { EgressProps } from "../egress";
import type { ContainerLike } from "../sandbox";

const HELPER = "/usr/local/lib/otto/otto-fs.mjs";

type Node = { kind: "file"; bytes: Uint8Array; mtimeMs: number; ino: number } | { kind: "directory"; mtimeMs: number; ino: number };

class FsError extends Error {
  constructor(
    readonly code: string,
    readonly path: string
  ) {
    super(`${code}: ${path}`);
  }
}

/**
 * An in-memory filesystem that answers the image's otto-fs helper protocol,
 * so ContainerEnv (and pi's read/write/edit on it) run for real in tests.
 * No symbolic links; enough for the tools, not a conformance target.
 */
export class MemFs {
  readonly nodes = new Map<string, Node>([
    ["/", { kind: "directory", mtimeMs: 0, ino: 1 }],
    ["/workspace", { kind: "directory", mtimeMs: 0, ino: 2 }],
    ["/tmp", { kind: "directory", mtimeMs: 0, ino: 3 }]
  ]);
  #ino = 10;
  #temp = 0;

  #get(path: string): Node {
    const node = this.nodes.get(path);
    if (!node) throw new FsError("not_found", path);
    return node;
  }

  #parentMustExist(path: string): void {
    const parent = posix.dirname(path);
    const node = this.nodes.get(parent);
    if (!node) throw new FsError("not_found", path);
    if (node.kind !== "directory") throw new FsError("not_directory", path);
  }

  mkdir(path: string, recursive = true): void {
    if (this.nodes.has(path)) {
      if (recursive && this.nodes.get(path)!.kind === "directory") return;
      throw new FsError("unknown", path);
    }
    if (recursive && path !== "/") this.mkdir(posix.dirname(path), true);
    this.#parentMustExist(path);
    this.nodes.set(path, { kind: "directory", mtimeMs: Date.now(), ino: this.#ino++ });
  }

  writeFile(path: string, content: string | Uint8Array, append = false): void {
    this.mkdir(posix.dirname(path), true);
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const existing = this.nodes.get(path);
    if (existing?.kind === "directory") throw new FsError("is_directory", path);
    const previous = append && existing?.kind === "file" ? existing.bytes : new Uint8Array();
    const next = new Uint8Array(previous.length + bytes.length);
    next.set(previous);
    next.set(bytes, previous.length);
    this.nodes.set(path, { kind: "file", bytes: next, mtimeMs: Date.now(), ino: existing?.ino ?? this.#ino++ });
  }

  readFile(path: string): string {
    const node = this.#get(path);
    if (node.kind !== "file") throw new FsError("is_directory", path);
    return new TextDecoder().decode(node.bytes);
  }

  #info(path: string) {
    const node = this.#get(path);
    return {
      name: posix.basename(path),
      path,
      kind: node.kind,
      size: node.kind === "file" ? node.bytes.length : 4096,
      mtimeMs: node.mtimeMs
    };
  }

  #children(path: string): string[] {
    const node = this.#get(path);
    if (node.kind !== "directory") throw new FsError("not_directory", path);
    const prefix = path === "/" ? "/" : `${path}/`;
    return [...this.nodes.keys()]
      .filter((key) => key !== path && key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
      .map((key) => key.slice(prefix.length));
  }

  handle(op: string, args: Record<string, any>, stdin: Uint8Array): unknown {
    switch (op) {
      case "stat":
        return this.#info(args.path);
      case "read": {
        const node = this.#get(args.path);
        if (node.kind !== "file") throw new FsError("is_directory", args.path);
        const bytes = args.offset === undefined ? node.bytes : node.bytes.subarray(args.offset, args.offset + args.length);
        return Buffer.from(bytes).toString("base64");
      }
      case "write":
        this.writeFile(args.path, stdin, args.append === true);
        return null;
      case "truncate": {
        const node = this.#get(args.path);
        if (node.kind !== "file") throw new FsError("is_directory", args.path);
        const next = new Uint8Array(args.size);
        next.set(node.bytes.subarray(0, args.size));
        node.bytes = next;
        return null;
      }
      case "flush":
        this.#get(args.path);
        return null;
      case "rename": {
        const moved = [...this.nodes.entries()].filter(([key]) => key === args.from || key.startsWith(`${args.from}/`));
        if (moved.length === 0) throw new FsError("not_found", args.from);
        for (const [key] of moved) this.nodes.delete(key);
        for (const [key, node] of moved) this.nodes.set(args.to + key.slice(args.from.length), node);
        return null;
      }
      case "mkdir":
        this.mkdir(args.path, args.recursive);
        return null;
      case "rm": {
        if (!this.nodes.has(args.path)) {
          if (args.force) return null;
          throw new FsError("not_found", args.path);
        }
        const removed = [...this.nodes.keys()].filter((key) => key === args.path || key.startsWith(`${args.path}/`));
        if (removed.length > 1 && !args.recursive) throw new FsError("is_directory", args.path);
        for (const key of removed) this.nodes.delete(key);
        return null;
      }
      case "list":
        return this.#children(args.path).map((name) => this.#info(posix.join(args.path, name)));
      case "names":
        return this.#children(args.path);
      case "lstatMany":
        return (args.names as string[])
          .map((name) => posix.join(args.dir, name))
          .filter((path) => this.nodes.has(path))
          .map((path) => this.#info(path));
      case "realpath":
        this.#get(args.path);
        return args.path;
      case "mkdtemp": {
        const dir = `/tmp/${args.prefix ?? "tmp-"}${this.#temp++}`;
        this.mkdir(dir);
        return dir;
      }
      case "openReader": {
        const node = this.#get(args.path);
        if (node.kind === "directory") throw new FsError("is_directory", args.path);
        const link = `/var/tmp/otto-readers/${this.#temp++}`;
        this.writeFile(link, node.bytes);
        return { link, info: this.#info(args.path) };
      }
      case "closeReader":
        this.nodes.delete(args.link);
        return null;
      case "watchscan":
        return {};
      default:
        throw new FsError("invalid", op);
    }
  }
}

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
  readonly fs = new MemFs();

  start(options?: ContainerStartupOptions): void {
    this.running = true;
    this.starts.push(options!);
  }

  async exec(cmd: string[], options?: ContainerExecOptions): Promise<ExecProcess> {
    if (!this.running) throw new Error("exec() cannot be called on a container that is not running.");
    const stdin = options?.stdin instanceof ReadableStream ? await new Response(options.stdin).bytes() : new Uint8Array();
    const reply = this.#helper(cmd, stdin) ?? this.#precheck(cmd) ?? this.#record(cmd, options);
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

  #record(cmd: string[], options?: ContainerExecOptions): FakeReply {
    this.execs.push({ argv: cmd, cwd: options?.cwd, egress: this.egress });
    const command = unwrap(cmd);
    if (command[0] === "git" && command[1] === "clone") this.fs.mkdir(command.at(-1)!);
    return this.reply(unwrap(cmd), options?.cwd);
  }

  /** The otto-fs helper, answered by the in-memory filesystem. */
  #helper(cmd: string[], stdin: Uint8Array): FakeReply | undefined {
    if (cmd[0] !== "node" || cmd[1] !== HELPER) return undefined;
    try {
      const value = this.fs.handle(cmd[2], cmd[3] ? JSON.parse(cmd[3]) : {}, stdin);
      return { stdout: `${JSON.stringify({ ok: true, value })}\n` };
    } catch (error) {
      const code = error instanceof FsError ? error.code : "unknown";
      const path = error instanceof FsError ? error.path : undefined;
      return { stdout: `${JSON.stringify({ ok: false, error: { code, message: String(error), path } })}\n` };
    }
  }

  /** ContainerEnv's cwd and program check before every command. */
  #precheck(cmd: string[]): FakeReply | undefined {
    if (cmd[0] !== "sh" || !cmd[2]?.startsWith('test -d "$1"')) return undefined;
    if (this.fs.nodes.get(cmd[4])?.kind !== "directory") return { exitCode: 101 };
    return cmd[5] === "missing-program" ? { exitCode: 102 } : {};
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
