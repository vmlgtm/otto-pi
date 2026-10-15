#!/usr/bin/env node
// File operations for ContainerEnv (src/container-env.ts), one per process:
//   node otto-fs.mjs <op> '<json args>'   (file content for write/append on stdin)
// Prints one JSON line: {"ok":true,"value":...} or {"ok":false,"error":{code,message,path}}.
// Error codes follow pi-durable's FileErrorCode, mapped as its Node environment maps them.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const READERS = "/var/tmp/otto-readers";

function fileError(error, fallbackPath) {
  const map = {
    ENOENT: "not_found",
    EACCES: "permission_denied",
    EPERM: "permission_denied",
    ENOTDIR: "not_directory",
    EISDIR: "is_directory",
    EINVAL: "invalid"
  };
  return {
    code: map[error?.code] ?? "unknown",
    message: error?.message ?? String(error),
    path: typeof error?.path === "string" ? error.path : fallbackPath
  };
}

function kindOf(stats) {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  return undefined;
}

function info(p, stats) {
  const kind = kindOf(stats);
  if (!kind) return undefined;
  return { name: path.basename(p), path: p, kind, size: Number(stats.size), mtimeMs: Number(stats.mtimeMs) };
}

async function stdinBytes() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** `kind:size:mtimeNs:ino` for change detection; directories by identity only. */
function fingerprint(stats) {
  const kind = kindOf(stats) ?? "other";
  return kind === "directory" ? `d:${stats.ino}` : `${kind}:${stats.size}:${stats.mtimeNs}:${stats.ino}`;
}

async function scan(target, out) {
  const exclude = target.exclude ?? {};
  const skipped = (name) => (exclude.hidden && name.startsWith(".")) || (exclude.names ?? []).includes(name);
  let stats;
  try {
    stats = await fs.stat(target.path, { bigint: true }); // a watched symlink reports its target
  } catch {
    out[target.path] = "missing";
    return;
  }
  out[target.path] = fingerprint(stats);
  if (!stats.isDirectory()) return;
  const walk = async (dir, deep) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skipped(entry.name)) continue;
      const child = path.join(dir, entry.name);
      try {
        const childStats = await fs.lstat(child, { bigint: true });
        out[child] = fingerprint(childStats);
        if (deep && childStats.isDirectory()) await walk(child, true);
      } catch {
        // Removed while scanning: absent from this snapshot.
      }
    }
  };
  await walk(target.path, target.recursive === true);
}

const ops = {
  async stat({ path: p, follow }) {
    const stats = follow ? await fs.stat(p) : await fs.lstat(p);
    const result = info(p, stats);
    if (!result) throw Object.assign(new Error("Unsupported file type"), { code: "EINVAL", path: p });
    return result;
  },
  async read({ path: p, offset, length }) {
    if (offset === undefined) return (await fs.readFile(p)).toString("base64");
    const handle = await fs.open(p, "r");
    try {
      const buffer = Buffer.alloc(length);
      let total = 0;
      while (total < length) {
        const { bytesRead } = await handle.read(buffer, total, length - total, offset + total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      return buffer.subarray(0, total).toString("base64");
    } finally {
      await handle.close();
    }
  },
  async write({ path: p, append }) {
    const content = await stdinBytes();
    await fs.mkdir(path.dirname(p), { recursive: true });
    if (append) await fs.appendFile(p, content);
    else await fs.writeFile(p, content);
    return null;
  },
  async truncate({ path: p, size }) {
    const handle = await fs.open(p, "r+");
    try {
      await handle.truncate(size);
    } finally {
      await handle.close();
    }
    return null;
  },
  async flush({ path: p }) {
    const handle = await fs.open(p, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return null;
  },
  async rename({ from, to }) {
    await fs.rename(from, to);
    return null;
  },
  async mkdir({ path: p, recursive }) {
    await fs.mkdir(p, { recursive });
    return null;
  },
  async rm({ path: p, recursive, force }) {
    await fs.rm(p, { recursive, force });
    return null;
  },
  async list({ path: p }) {
    const entries = await fs.readdir(p);
    const infos = [];
    for (const name of entries) {
      const child = path.join(p, name);
      const result = info(child, await fs.lstat(child));
      if (result) infos.push(result);
    }
    return infos;
  },
  /** Names of a directory, for a paged reader that stats each page later. */
  async names({ path: p }) {
    const dir = await fs.opendir(p);
    const names = [];
    for await (const entry of dir) names.push(entry.name);
    return names;
  },
  /** Entries' info; ones removed since `names` are skipped. */
  async lstatMany({ dir, names }) {
    const infos = [];
    for (const name of names) {
      const child = path.join(dir, name);
      try {
        const result = info(child, await fs.lstat(child));
        if (result) infos.push(result);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return infos;
  },
  async realpath({ path: p }) {
    return await fs.realpath(p);
  },
  async mkdtemp({ prefix }) {
    return await fs.mkdtemp(path.join("/tmp", prefix ?? "tmp-"));
  },
  /**
   * Open a regular file for a reader that must keep reading it even after
   * a rename: a hard link to its inode, which the reader reads by path.
   */
  async openReader({ path: p, noFollow }) {
    let flags = constants.O_RDONLY | constants.O_NONBLOCK;
    if (noFollow) flags |= constants.O_NOFOLLOW;
    let handle;
    try {
      handle = await fs.open(p, flags);
    } catch (error) {
      if (noFollow && (error?.code === "ELOOP" || error?.code === "EMLINK")) {
        throw Object.assign(new Error("Refusing to follow a symbolic link"), { code: "EINVAL", path: p });
      }
      throw error;
    }
    try {
      const stats = await handle.stat();
      if (stats.isDirectory()) {
        throw Object.assign(new Error("EISDIR: illegal operation on a directory, read"), { code: "EISDIR", path: p });
      }
      if (!stats.isFile()) throw Object.assign(new Error("Not a regular file"), { code: "EINVAL", path: p });
      await fs.mkdir(READERS, { recursive: true });
      const link = path.join(READERS, randomUUID());
      try {
        await fs.link(await fs.realpath(p), link);
      } catch {
        await fs.copyFile(p, link); // another filesystem: a copy still stays put
      }
      return { link, info: info(p, stats) };
    } finally {
      await handle.close();
    }
  },
  async closeReader({ link }) {
    if (link.startsWith(`${READERS}/`)) await fs.rm(link, { force: true });
    return null;
  },
  async watchscan({ targets }) {
    const out = {};
    for (const target of targets) await scan(target, out);
    return out;
  }
};

const [op, raw] = process.argv.slice(2);
const args = raw ? JSON.parse(raw) : {};
try {
  const run = ops[op];
  if (!run) throw Object.assign(new Error(`unknown op ${op}`), { code: "EINVAL" });
  process.stdout.write(`${JSON.stringify({ ok: true, value: await run(args) })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: fileError(error, args.path) })}\n`);
}
