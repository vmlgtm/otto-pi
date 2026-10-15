import { LifecycleCapability, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";
import type { EgressProps } from "./egress";
import { findRepo, githubRepoName, REPOS, repoDir, type RepoConfig } from "./repos";

/** Where repositories are prepared, and every tool's root. */
export const WORKSPACE_ROOT = "/workspace";
/** No command runs longer than this, whatever the model asks for. */
export const MAX_COMMAND_SECONDS = 600;
/** The container stops this long after its last use. */
export const IDLE_STOP_MS = 10 * 60_000;
/** Output kept per stream by the host-side runner; the tail wins. */
const RUN_OUTPUT_BYTES = 256 * 1024;

const IDLE_JOB = "container-idle-stop";
const STATE_KEY = "sandbox:workspace";
const SNAPSHOT_PREFIX = "sandbox:snapshot:";
const NODE22_PATH = "/opt/node22/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);
const INSTALL_VERBS = new Set(["install", "i", "add", "ci"]);

/** The slice of `ctx.container` the sandbox uses, so tests can pass a fake. */
export type ContainerLike = Pick<
  Container,
  | "running"
  | "images"
  | "start"
  | "exec"
  | "destroy"
  | "monitor"
  | "setInactivityTimeout"
  | "interceptOutboundHttps"
  | "interceptAllOutboundHttp"
  | "snapshotContainer"
>;

export type Instance = RepoConfig["instance"];

/** The prepared repository, in DO storage so a restarted object knows it. */
export type WorkspaceState = {
  readonly url: string;
  readonly dir: string;
  readonly commit: string;
  readonly node: RepoConfig["node"];
  readonly instance: Instance;
  readonly preparedAt: number;
};

type SnapshotRecord = { readonly id: string; readonly size: number; readonly createdAt: number };

export type RunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
};

export type PrepareResult = {
  readonly repo: string;
  readonly dir: string;
  readonly commit: string;
  readonly instance: Instance;
  readonly snapshot: "off" | "restored" | "saved" | "failed";
  readonly timingsMs: Readonly<Record<string, number>>;
  readonly installTail: string;
  readonly test: readonly string[] | null;
  readonly lint: readonly string[] | null;
};

export type SandboxOptions = {
  /** `ctx.container`, read at each use. */
  readonly container: () => ContainerLike | undefined;
  readonly storage: Pick<DurableObjectStorage, "get" | "put" | "delete">;
  /** `ctx.exports.OttoEgress({ props })`. */
  readonly egress: (props: EgressProps) => Fetcher;
  /** `SANDBOX_SNAPSHOTS === "on"`: reuse an installed workspace per repo and commit. */
  readonly snapshots: boolean;
  readonly now?: () => number;
};

/** A container started by this object no longer holds the workspace a tool expects. */
export class WorkspaceLostError extends Error {
  constructor(state: WorkspaceState) {
    super(
      `The workspace container restarted and its files are gone (${state.url} was prepared at ${state.commit.slice(0, 12)}). ` +
        "Call prepare_workspace again, then redo any changes that were not pushed."
    );
    this.name = "WorkspaceLostError";
  }
}

function decodeTail(chunks: Uint8Array[], total: number): string {
  const bytes = new Uint8Array(Math.min(total, RUN_OUTPUT_BYTES));
  let offset = bytes.length;
  for (let i = chunks.length - 1; i >= 0 && offset > 0; i--) {
    const chunk = chunks[i];
    const take = Math.min(chunk.length, offset);
    bytes.set(chunk.subarray(chunk.length - take), offset - take);
    offset -= take;
  }
  const text = new TextDecoder().decode(bytes);
  return total > RUN_OUTPUT_BYTES ? `[${total - RUN_OUTPUT_BYTES} earlier bytes dropped]\n${text}` : text;
}

/** Read a stream to the end, keeping only its tail. */
async function collect(stream: ReadableStream | null): Promise<string> {
  if (!stream) return "";
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    chunks.push(chunk);
    kept += chunk.length;
    total += chunk.length;
    while (kept - (chunks[0]?.length ?? 0) >= RUN_OUTPUT_BYTES) kept -= chunks.shift()!.length;
  }
  return decodeTail(chunks, total);
}

/** The environment a command in this repo runs with: Node 22 first on PATH when configured. */
export function commandEnv(node: RepoConfig["node"] | undefined): Record<string, string> {
  return node === "22" ? { PATH: NODE22_PATH } : {};
}

/**
 * One container per session, driven through `ctx.container`, with every
 * request it makes going through `OttoEgress`.
 *
 * The container always starts with `enableInternet: false`. Internet for
 * clone and install comes from swapping the egress props to `setup` and
 * back to `locked`, so the installed workspace survives the switch (a
 * restart would lose it unless snapshots are on). It starts on first use,
 * not on connect, and stops `IDLE_STOP_MS` after its last use through a
 * Lifecycle job, with the platform inactivity timeout as a backstop.
 */
export class Sandbox extends LifecycleCapability {
  readonly #options: SandboxOptions;
  #started: Promise<ContainerLike> | undefined;
  #instance: Instance | undefined;
  /** Set when a prepared workspace was found gone; the next use reports it once. */
  #lost: WorkspaceState | undefined;

  constructor(options: SandboxOptions) {
    super("workspace-sandbox");
    this.#options = options;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  override async onStart(): Promise<void> {
    // The inactivity timeout belongs to the object instance, so a restart
    // (deploy, reset) must set it again for a container that kept running.
    const container = this.#options.container();
    if (container?.running) {
      await container.setInactivityTimeout(IDLE_STOP_MS + 5 * 60_000).catch(() => {});
    }
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome | void> {
    if (job.fn !== "idle-stop") return;
    console.log(JSON.stringify({ event: "container_idle_stop" }));
    await this.stop();
  }

  async workspace(): Promise<WorkspaceState | undefined> {
    return (await this.#options.storage.get<WorkspaceState>(STATE_KEY)) ?? undefined;
  }

  /** Working directory for tools: the prepared repo, else the workspace root. */
  async cwd(): Promise<string> {
    return (await this.workspace())?.dir ?? WORKSPACE_ROOT;
  }

  /** The running container, started and set up on first use. */
  async container(): Promise<ContainerLike> {
    this.#started ??= this.#start().catch((error) => {
      this.#started = undefined;
      throw error;
    });
    const container = await this.#started;
    if (this.#lost) {
      const lost = this.#lost;
      this.#lost = undefined;
      throw new WorkspaceLostError(lost);
    }
    await this.#touch();
    return container;
  }

  async #start(instance?: Instance, snapshot?: SnapshotRecord): Promise<ContainerLike> {
    const container = this.#options.container();
    if (!container) throw new Error("This Worker has no container binding (wrangler.jsonc containers).");
    const state = await this.workspace();

    if (container.running && !snapshot) {
      // Left by an earlier isolate of this object. Keep it if it answers.
      if (await this.#answers(container)) {
        this.#instance = instance ?? state?.instance;
        await this.#lock(container, state);
        await container.setInactivityTimeout(IDLE_STOP_MS + 5 * 60_000).catch(() => {});
        return container;
      }
      await container.destroy().catch(() => {});
    }

    const size = instance ?? state?.instance ?? "standard-1";
    container.start(
      snapshot
        ? { containerSnapshot: { id: snapshot.id }, enableInternet: false, instance: size }
        : { image: container.images.workspace, enableInternet: false, instance: size }
    );
    this.#instance = size;
    await this.#lock(container, state);
    await this.#waitReady(container);
    await this.#trustCa(container);
    await container.setInactivityTimeout(IDLE_STOP_MS + 5 * 60_000).catch(() => {});
    console.log(JSON.stringify({ event: "container_start", instance: size, snapshot: snapshot?.id ?? null }));

    if (state && !snapshot && !instance) {
      // A fresh container cannot hold the workspace that storage says exists.
      await this.#options.storage.delete(STATE_KEY);
      this.#lost = state;
    }
    return container;
  }

  async #answers(container: ContainerLike): Promise<boolean> {
    try {
      const probe = container.exec(["true"]).then((process) => process.exitCode);
      const timeout = new Promise<number>((resolve) => setTimeout(() => resolve(-1), 5000));
      return (await Promise.race([probe, timeout])) === 0;
    } catch {
      return false;
    }
  }

  async #waitReady(container: ContainerLike): Promise<void> {
    let failed: unknown;
    container.monitor().catch((error) => (failed = error));
    for (let attempt = 0; attempt < 120; attempt++) {
      if (failed) throw new Error(`The workspace container did not start: ${String(failed)}`);
      try {
        const process = await container.exec(["true"]);
        if ((await process.exitCode) === 0) return;
      } catch {
        // Not up yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("The workspace container did not become ready within 60 s.");
  }

  /** The egress CA exists only once the container runs; add it to the system bundle. */
  async #trustCa(container: ContainerLike): Promise<void> {
    const process = await container.exec([
      "sh",
      "-c",
      'test -f "$CF_CA" && cat "$CF_CA" >> /etc/ssl/certs/ca-certificates.crt'
    ]);
    if ((await process.exitCode) !== 0) {
      console.warn(JSON.stringify({ event: "container_ca_missing" }));
    }
  }

  async #egress(container: ContainerLike, props: EgressProps): Promise<void> {
    const handler = this.#options.egress(props);
    await container.interceptOutboundHttps("*", handler);
    await container.interceptAllOutboundHttp(handler);
  }

  async #lock(container: ContainerLike, state: WorkspaceState | undefined): Promise<void> {
    const repo = state ? githubRepoName(state.url) : undefined;
    await this.#egress(container, { phase: "locked", ...(repo ? { repo } : {}) });
  }

  async #touch(): Promise<void> {
    const due = this.#now() + IDLE_STOP_MS;
    const existing = this.lifecycleServices?.jobs.get(IDLE_JOB);
    if (existing && existing.time > due - 60_000) return;
    await this.lifecycleServices?.jobs.push({ id: IDLE_JOB, fn: "idle-stop", time: due });
  }

  /** Stop the container and forget it; the workspace record stays for the lost-workspace notice. */
  async stop(): Promise<void> {
    this.#started = undefined;
    this.#instance = undefined;
    await this.lifecycleServices?.jobs.cancel(IDLE_JOB);
    const container = this.#options.container();
    if (container?.running) await container.destroy().catch(() => {});
  }

  /** Start `argv` in the container, for callers that stream its output. */
  async spawn(argv: readonly string[], options: ContainerExecOptions = {}): Promise<ExecProcess> {
    const container = await this.container();
    return container.exec([...argv], options);
  }

  /**
   * Run `argv` without a shell, in `cwd`, killed with its process group after
   * `timeoutSeconds` (capped at 600). Output is buffered, keeping the tail.
   */
  async run(
    argv: readonly string[],
    options: { cwd?: string; timeoutSeconds?: number; env?: Record<string, string>; signal?: AbortSignal } = {}
  ): Promise<RunResult> {
    const container = await this.container();
    return this.#run(container, argv, options);
  }

  async #run(
    container: ContainerLike,
    argv: readonly string[],
    options: { cwd?: string; timeoutSeconds?: number; env?: Record<string, string>; signal?: AbortSignal } = {}
  ): Promise<RunResult> {
    const seconds = Math.min(options.timeoutSeconds ?? MAX_COMMAND_SECONDS, MAX_COMMAND_SECONDS);
    const env = Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`);
    const start = this.#now();
    const process = await container.exec(
      ["env", ...env, "timeout", "-k", "5", String(seconds), ...argv],
      { cwd: options.cwd ?? WORKSPACE_ROOT, ...(options.signal ? { signal: options.signal } : {}) }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      collect(process.stdout),
      collect(process.stderr),
      process.exitCode
    ]);
    const durationMs = this.#now() - start;
    return {
      exitCode,
      stdout,
      stderr,
      durationMs,
      timedOut: (exitCode === 124 || exitCode === 137) && durationMs >= seconds * 1000 - 1000
    };
  }

  /** Paths `git status` reports in the prepared repo; empty when nothing is prepared. */
  async changedFiles(): Promise<string[]> {
    const state = await this.workspace();
    if (!state) return [];
    const result = await this.run(["git", "-c", "core.quotepath=false", "status", "--porcelain=v1"], { cwd: state.dir, timeoutSeconds: 60 });
    return result.stdout
      .split("\n")
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3));
  }

  /**
   * Clone and install a configured repository, with internet only for that.
   * A repository that is not in `src/repos.ts` is refused.
   */
  async prepare(url: string): Promise<PrepareResult> {
    const found = findRepo(url);
    if (!found) {
      throw new Error(
        `Unknown repository ${url}. Otto can prepare only: ${Object.keys(REPOS).join(", ")}.`
      );
    }
    const { config } = found;
    const dir = repoDir(found.url);
    const timings: Record<string, number> = {};
    const time = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
      const start = this.#now();
      try {
        return await work();
      } finally {
        timings[name] = this.#now() - start;
      }
    };

    // A previous workspace in this session is replaced, so a lost one is moot.
    this.#lost = undefined;
    if (this.#instance !== undefined && this.#instance !== config.instance) await this.stop();
    if (this.#started === undefined) {
      this.#started = this.#start(config.instance);
    }
    let container = await time("start", () => this.#started!);
    this.#lost = undefined;
    await this.#touch();

    const env = commandEnv(config.node);
    const check = (step: string, result: RunResult) => {
      if (result.exitCode === 0) return result;
      const reason = result.timedOut ? `timed out after ${MAX_COMMAND_SECONDS} s` : `exited with ${result.exitCode}`;
      throw new Error(`${step} ${reason}:\n${(result.stderr || result.stdout).slice(-4000)}`);
    };

    let snapshot: PrepareResult["snapshot"] = this.#options.snapshots ? "saved" : "off";
    let installTail = "";
    let commit = "";
    await this.#egress(container, { phase: "setup" });
    try {
      const refs = check(
        "git ls-remote",
        await time("lsRemote", () =>
          this.#run(container, ["git", "ls-remote", found.url, config.ref ?? "HEAD"], { timeoutSeconds: 60 })
        )
      );
      commit = refs.stdout.split(/\s/)[0] ?? "";
      if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`git ls-remote returned no commit for ${config.ref ?? "HEAD"}`);

      const key = `${SNAPSHOT_PREFIX}${found.url}@${commit}`;
      const saved = this.#options.snapshots
        ? await this.#options.storage.get<SnapshotRecord>(key)
        : undefined;
      let restored = false;
      if (saved) {
        try {
          container = await time("restore", async () => {
            await this.stop();
            this.#started = this.#start(config.instance, saved);
            return this.#started;
          });
          const head = await this.#run(container, ["git", "-C", dir, "rev-parse", "HEAD"]);
          restored = head.exitCode === 0 && head.stdout.trim() === commit;
          if (!restored) throw new Error(`snapshot holds ${head.stdout.trim() || "no repo"}`);
          snapshot = "restored";
        } catch (error) {
          console.warn(JSON.stringify({ event: "snapshot_restore_failed", key, error: String(error) }));
          await this.#options.storage.delete(key);
          await this.stop();
          this.#started = this.#start(config.instance);
          container = await this.#started;
          snapshot = "failed";
        }
        await this.#egress(container, { phase: "setup" });
      }

      if (!restored) {
        await this.#run(container, ["rm", "-rf", dir]);
        check(
          "git clone",
          await time("clone", () =>
            this.#run(container, [
              "git",
              "clone",
              "--depth=1",
              ...(config.ref ? ["--branch", config.ref] : []),
              found.url,
              dir
            ])
          )
        );
        const install = check(
          config.install.join(" "),
          await time("install", () => this.#run(container, config.install, { cwd: dir, env }))
        );
        installTail = (install.stdout + install.stderr).slice(-2000);

        if (this.#options.snapshots) {
          try {
            const taken = await time("snapshot", () =>
              container.snapshotContainer({ name: `${githubRepoName(found.url) ?? "repo"}@${commit.slice(0, 12)}` })
            );
            await this.#options.storage.put(key, {
              id: taken.id,
              size: taken.size,
              createdAt: this.#now()
            } satisfies SnapshotRecord);
            timings.snapshotBytes = taken.size;
            snapshot = "saved";
          } catch (error) {
            console.warn(JSON.stringify({ event: "snapshot_failed", key, error: String(error) }));
            snapshot = "failed";
          }
        }
      }
    } finally {
      const repo = githubRepoName(found.url);
      await this.#egress(container, { phase: "locked", ...(repo ? { repo } : {}) });
    }

    const state: WorkspaceState = {
      url: found.url,
      dir,
      commit,
      node: config.node,
      instance: config.instance,
      preparedAt: this.#now()
    };
    await this.#options.storage.put(STATE_KEY, state);
    console.log(JSON.stringify({ event: "workspace_prepared", repo: found.url, commit, snapshot, timings }));
    return {
      repo: found.url,
      dir,
      commit,
      instance: config.instance,
      snapshot,
      timingsMs: timings,
      installTail,
      test: config.test,
      lint: config.lint
    };
  }

  /**
   * Add a dependency to the prepared repo: one package-manager install
   * command, the only time internet is on outside a fresh prepare.
   */
  async install(argv: readonly string[]): Promise<RunResult> {
    const state = await this.workspace();
    if (!state) throw new Error("No workspace is prepared. Call prepare_workspace with a repository URL first.");
    const [program, verb] = argv;
    if (!program || !PACKAGE_MANAGERS.has(program) || !verb || !INSTALL_VERBS.has(verb)) {
      throw new Error(
        `An install step must be npm, pnpm or yarn with install, i, add or ci (got ${JSON.stringify(argv)}).`
      );
    }
    const container = await this.container();
    const repo = githubRepoName(state.url);
    await this.#egress(container, { phase: "setup" });
    try {
      return await this.#run(container, argv, { cwd: state.dir, env: commandEnv(state.node) });
    } finally {
      await this.#egress(container, { phase: "locked", ...(repo ? { repo } : {}) });
    }
  }

  /**
   * Run `work` while the egress gateway lets one push through, with the
   * token, to `branch` of the prepared repo. Every other push still fails.
   */
  async withPushGrant<T>(branch: string, work: () => Promise<T>): Promise<T> {
    const state = await this.workspace();
    const repo = state ? githubRepoName(state.url) : undefined;
    if (!repo) throw new Error("Pushes need a prepared GitHub repository.");
    const container = await this.container();
    await this.#egress(container, { phase: "locked", repo, push: { repo, branch } });
    try {
      return await work();
    } finally {
      await this.#egress(container, { phase: "locked", repo });
    }
  }
}
