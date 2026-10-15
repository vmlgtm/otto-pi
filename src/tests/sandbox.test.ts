import { describe, expect, it } from "vitest";
import { parseReceivePackCommands, repoOfPath } from "../egress";
import { normalizeRepoUrl, findRepo, repoDir } from "../repos";
import { Sandbox, WorkspaceLostError } from "../sandbox";
import {
  COMMIT,
  FakeContainer,
  fakeEgress,
  memoryStorage,
  ufoReplies,
  unwrap
} from "./fake-container";

function setup(options: { snapshots?: boolean; storage?: ReturnType<typeof memoryStorage> } = {}) {
  const container = new FakeContainer();
  container.reply = ufoReplies;
  const storage = options.storage ?? memoryStorage();
  const sandbox = new Sandbox({
    container: () => container,
    storage,
    egress: fakeEgress,
    snapshots: options.snapshots ?? false
  });
  return { container, storage, sandbox };
}

const commands = (container: FakeContainer) => container.execs.map((exec) => unwrap(exec.argv).join(" "));

describe("the sandbox lifecycle", () => {
  it("starts lazily with internet off and every request through the egress gateway", async () => {
    const { container, sandbox } = setup();
    expect(container.starts).toEqual([]);
    await sandbox.run(["true"]);
    expect(container.starts).toEqual([
      { image: "registry/workspace:test", enableInternet: false, instance: "standard-1" }
    ]);
    expect(container.egress).toEqual({ phase: "locked" });
  });

  it("clones and installs with internet on, then locks egress to the repo", async () => {
    const { container, sandbox, storage } = setup();
    const result = await sandbox.prepare("https://github.com/vmlgtm/ufo");
    expect(result).toMatchObject({
      repo: "https://github.com/vmlgtm/ufo.git",
      dir: "/workspace/ufo",
      commit: COMMIT,
      instance: "standard-1",
      snapshot: "off"
    });
    const clone = container.execs.find((exec) => unwrap(exec.argv)[1] === "clone")!;
    const install = container.execs.find((exec) => unwrap(exec.argv)[0] === "pnpm")!;
    expect(unwrap(clone.argv)).toEqual([
      "git",
      "clone",
      "--depth=1",
      "https://github.com/vmlgtm/ufo.git",
      "/workspace/ufo"
    ]);
    expect(clone.egress).toEqual({ phase: "setup" });
    expect(install.egress).toEqual({ phase: "setup" });
    expect(install.cwd).toBe("/workspace/ufo");
    expect(container.egress).toEqual({ phase: "locked", repo: "vmlgtm/ufo" });
    expect(await storage.get("sandbox:workspace")).toMatchObject({ dir: "/workspace/ufo", commit: COMMIT });
    expect(await sandbox.cwd()).toBe("/workspace/ufo");
  });

  it("refuses a repository that is not configured", async () => {
    const { container, sandbox } = setup();
    await expect(sandbox.prepare("https://github.com/tata1mg/1mg_web.git")).rejects.toThrow(
      /Unknown repository/
    );
    expect(container.starts).toEqual([]);
  });

  it("locks egress again when the install fails", async () => {
    const { container, sandbox } = setup();
    container.reply = (argv) =>
      argv[0] === "pnpm" ? { exitCode: 1, stderr: "ERR_PNPM_OUTDATED_LOCKFILE" } : ufoReplies(argv);
    await expect(sandbox.prepare("https://github.com/vmlgtm/ufo.git")).rejects.toThrow(
      /pnpm install --frozen-lockfile exited with 1:\nERR_PNPM_OUTDATED_LOCKFILE/
    );
    expect(container.egress).toEqual({ phase: "locked", repo: "vmlgtm/ufo" });
  });

  it("caps every command at 600 seconds and kills its process group", async () => {
    const { container, sandbox } = setup();
    await sandbox.run(["sleep", "1"], { timeoutSeconds: 9999 });
    expect(container.execs.at(-1)?.argv).toEqual(["env", "timeout", "-k", "5", "600", "sleep", "1"]);
  });

  it("allows only package-manager installs with internet, and only after a prepare", async () => {
    const { container, sandbox } = setup();
    await expect(sandbox.install(["pnpm", "add", "zod"])).rejects.toThrow(/No workspace is prepared/);
    await sandbox.prepare("https://github.com/vmlgtm/ufo.git");
    await expect(sandbox.install(["bash", "-c", "curl evil"])).rejects.toThrow(/must be npm, pnpm or yarn/);
    await expect(sandbox.install(["pnpm", "exec", "curl"])).rejects.toThrow(/must be npm, pnpm or yarn/);
    await sandbox.install(["pnpm", "add", "-D", "zod"]);
    const add = container.execs.at(-1)!;
    expect(unwrap(add.argv)).toEqual(["pnpm", "add", "-D", "zod"]);
    expect(add.egress).toEqual({ phase: "setup" });
    expect(container.egress).toEqual({ phase: "locked", repo: "vmlgtm/ufo" });
  });

  it("grants one push for one branch, then takes it back", async () => {
    const { container, sandbox } = setup();
    await sandbox.prepare("https://github.com/vmlgtm/ufo.git");
    let during: unknown;
    await sandbox.withPushGrant("otto/issue-1-fix", async () => {
      during = container.egress;
    });
    expect(during).toEqual({
      phase: "locked",
      repo: "vmlgtm/ufo",
      push: { repo: "vmlgtm/ufo", branch: "otto/issue-1-fix" }
    });
    expect(container.egress).toEqual({ phase: "locked", repo: "vmlgtm/ufo" });
  });

  it("reports a workspace lost to a container restart once, then works again", async () => {
    const storage = memoryStorage();
    await setup({ storage }).sandbox.prepare("https://github.com/vmlgtm/ufo.git");
    // A restarted object with a new, empty container.
    const { sandbox } = setup({ storage });
    await expect(sandbox.run(["ls"])).rejects.toBeInstanceOf(WorkspaceLostError);
    await expect(sandbox.workspace()).resolves.toBeUndefined();
    await expect(sandbox.run(["ls"])).resolves.toMatchObject({ exitCode: 0 });
  });

  it("keeps a container that survived the restart and still answers", async () => {
    const storage = memoryStorage();
    const first = setup({ storage });
    await first.sandbox.prepare("https://github.com/vmlgtm/ufo.git");
    const sandbox = new Sandbox({
      container: () => first.container,
      storage,
      egress: fakeEgress,
      snapshots: false
    });
    await expect(sandbox.run(["ls"])).resolves.toMatchObject({ exitCode: 0 });
    expect(first.container.starts).toHaveLength(1);
    expect(first.container.egress).toEqual({ phase: "locked", repo: "vmlgtm/ufo" });
  });

  it("saves a snapshot per commit and restores it instead of installing", async () => {
    const storage = memoryStorage();
    const first = setup({ snapshots: true, storage });
    expect((await first.sandbox.prepare("https://github.com/vmlgtm/ufo.git")).snapshot).toBe("saved");
    expect(first.container.snapshots).toEqual([{ id: "snap-1", size: 1234, name: `vmlgtm/ufo@${COMMIT.slice(0, 12)}` }]);

    const second = setup({ snapshots: true, storage });
    const result = await second.sandbox.prepare("https://github.com/vmlgtm/ufo.git");
    expect(result.snapshot).toBe("restored");
    expect(second.container.starts.at(-1)).toMatchObject({ containerSnapshot: { id: "snap-1" } });
    expect(commands(second.container).some((command) => command.startsWith("pnpm install"))).toBe(false);
  });

  it("falls back to a fresh install when a snapshot does not restore", async () => {
    const storage = memoryStorage();
    await setup({ snapshots: true, storage }).sandbox.prepare("https://github.com/vmlgtm/ufo.git");
    const second = setup({ snapshots: true, storage });
    second.container.reply = (argv) =>
      argv[1] === "-C" ? { exitCode: 128, stderr: "not a git repository" } : ufoReplies(argv);
    const result = await second.sandbox.prepare("https://github.com/vmlgtm/ufo.git");
    expect(commands(second.container).some((command) => command.startsWith("pnpm install"))).toBe(true);
    expect(result.snapshot).toBe("saved");
  });
});

describe("repository config", () => {
  it("matches clone URLs however they are written", () => {
    expect(normalizeRepoUrl("https://github.com/VMLGTM/ufo/")).toBe("https://github.com/vmlgtm/ufo.git");
    expect(findRepo("https://github.com/vmlgtm/wp-calypso")?.config.ref).toBe("trunk");
    expect(findRepo("https://bitbucket.org/tata1mg/1mg_web.git")).toBeUndefined();
    expect(repoDir("https://github.com/vmlgtm/wp-calypso.git")).toBe("/workspace/wp-calypso");
  });
});

describe("the egress gateway's parsing", () => {
  it("names the repo of git's smart-HTTP endpoints only", () => {
    expect(repoOfPath("/vmlgtm/ufo.git/info/refs")).toBe("vmlgtm/ufo");
    expect(repoOfPath("/VMLGTM/ufo/git-receive-pack")).toBe("vmlgtm/ufo");
    expect(repoOfPath("/vmlgtm/ufo.git/objects/pack")).toBeUndefined();
    expect(repoOfPath("/repos/vmlgtm/ufo/pulls")).toBeUndefined();
  });

  it("reads every ref update of a receive-pack request", () => {
    const line = (text: string) => `${(text.length + 4).toString(16).padStart(4, "0")}${text}`;
    const body = new TextEncoder().encode(
      line(`${"a".repeat(40)} ${"b".repeat(40)} refs/heads/otto/x\0report-status`) +
        line(`${"c".repeat(40)} ${"0".repeat(40)} refs/heads/main\n`) +
        "0000PACK"
    );
    expect(parseReceivePackCommands(body)).toEqual([
      { old: "a".repeat(40), new: "b".repeat(40), ref: "refs/heads/otto/x" },
      { old: "c".repeat(40), new: "0".repeat(40), ref: "refs/heads/main" }
    ]);
    expect(() => parseReceivePackCommands(new TextEncoder().encode("zzzz"))).toThrow();
  });
});
