import { afterEach, describe, expect, it, vi } from "vitest";
import { OttoEgress, parseReceivePackCommands, repoOfPath, type EgressProps } from "../egress";
import { normalizeRepoUrl, findRepo, repoDir } from "../repos";
import { envArgs, Sandbox, WorkspaceLostError } from "../sandbox";
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
    expect(container.execs.at(-1)?.argv).toEqual(["env", ...envArgs(), "timeout", "-k", "5", "600", "sleep", "1"]);
  });

  it("sets the image's environment on every command, since the platform's exec does not pass it", async () => {
    const { container, sandbox } = setup();
    await sandbox.run(["node", "-v"], { env: { PATH: "/opt/node22/bin" } });
    const argv = container.execs.at(-1)!.argv;
    expect(argv).toContain("NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt");
    expect(argv).toContain("GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt");
    // The caller's values win over the image's.
    expect(argv.filter((arg) => arg.startsWith("PATH="))).toEqual(["PATH=/opt/node22/bin"]);
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

describe("the egress gateway", () => {
  afterEach(() => vi.restoreAllMocks());

  const gateway = (props: EgressProps) =>
    new OttoEgress({ props } as never, { GITHUB_TOKEN: "ghp_test" } as never);
  const line = (text: string) => `${(text.length + 4).toString(16).padStart(4, "0")}${text}`;
  const pushBody = (ref: string) =>
    `${line(`${"a".repeat(40)} ${"b".repeat(40)} ${ref}\0report-status`)}0000PACKDATA`;
  const push = (ref: string) =>
    new Request("https://github.com/vmlgtm/ufo.git/git-receive-pack", {
      method: "POST",
      headers: { "content-type": "application/x-git-receive-pack-request", authorization: "Basic forged" },
      body: pushBody(ref)
    });
  const granted: EgressProps = {
    phase: "locked",
    repo: "vmlgtm/ufo",
    push: { repo: "vmlgtm/ufo", branch: "otto/issue-1-fix" }
  };

  it("forwards an allowed push with its body and the token, never the container's credentials", async () => {
    const sent: { auth: string | null; body: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
      const request = new Request(input, init);
      sent.push({ auth: request.headers.get("authorization"), body: await request.text() });
      return new Response("ok");
    });
    const response = await gateway(granted).fetch(push("refs/heads/otto/issue-1-fix"));
    expect(response.status).toBe(200);
    expect(sent).toEqual([{ auth: `Basic ${btoa("x-access-token:ghp_test")}`, body: pushBody("refs/heads/otto/issue-1-fix") }]);
  });

  it("refuses a push to any other ref, and any push without a grant", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect((await gateway(granted).fetch(push("refs/heads/main"))).status).toBe(403);
    expect((await gateway({ phase: "locked", repo: "vmlgtm/ufo" }).fetch(push("refs/heads/otto/issue-1-fix"))).status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards fetches of the session's repo without credentials, and nothing else", async () => {
    const auths: (string | null)[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      auths.push((input as Request).headers.get("authorization"));
      return new Response("ok");
    });
    const locked = gateway({ phase: "locked", repo: "vmlgtm/ufo" });
    const upload = new Request("https://github.com/vmlgtm/ufo.git/info/refs?service=git-upload-pack", {
      headers: { authorization: "Basic forged" }
    });
    expect((await locked.fetch(upload)).status).toBe(200);
    expect(auths).toEqual([null]);
    expect((await locked.fetch(new Request("https://registry.npmjs.org/vitest"))).status).toBe(403);
    expect((await locked.fetch(new Request("https://github.com/other/repo.git/info/refs?service=git-upload-pack"))).status).toBe(403);
  });
});
