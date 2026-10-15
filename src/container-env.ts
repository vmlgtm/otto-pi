import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type BinaryReader,
  type DirReader,
  err,
  ExecutionError,
  type ExecutionEnv,
  FileError,
  type FileErrorCode,
  type FileInfo,
  type FileWatcher,
  LineScanner,
  type LineScan,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  StreamDecoder,
  type TextLine,
  type TextLineReader,
  type WatchChange,
  type WatchTarget
} from "@earendil-works/pi-durable/env";
import { posix } from "node:path";
import { MAX_COMMAND_SECONDS, type Sandbox } from "./sandbox";

/** The helper baked into the image (container/otto-fs.mjs). */
const HELPER = "/usr/local/lib/otto/otto-fs.mjs";
const READ_CHUNK = 1024 * 1024;
const LINE_CHUNK = 64 * 1024;
const WATCH_INTERVAL_MS = 250;
/** Output kept in memory for a spill file; beyond it the spill says it is incomplete. */
const SPILL_MEMORY_BYTES = 32 * 1024 * 1024;
/** `timeout` exits 124 when its limit hits, 128+9 when it had to KILL after the grace period. */
const TIMEOUT_EXITS = new Set([124, 137]);

type Wire<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; path?: string } };

const FILE_CODES = new Set<FileErrorCode>([
  "aborted",
  "not_found",
  "permission_denied",
  "not_directory",
  "is_directory",
  "invalid",
  "not_supported",
  "unknown"
]);

function aborted(context: Context, path?: string): Result<never, FileError> | undefined {
  return context.abortSignal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}

function closed<T>(what: string, path: string): Result<T, FileError> {
  return err(new FileError("invalid", `${what} is closed`, path));
}

async function readAll(stream: ReadableStream | null): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    chunks.push(chunk);
    total += chunk.length;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function fromBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64"));
}

function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

function oneChunk(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(bytes);
      controller.close();
    }
  });
}

/**
 * pi's `ExecutionEnv` on the session's container, so pi's own `read`,
 * `write`, `edit` and `bash` run there. pi maintains how the tools behave;
 * this maintains only the mapping.
 *
 * File operations run the image's `otto-fs.mjs` helper, one `exec` each.
 * Readers keep their cursor on this side and read by position; a binary
 * reader holds a hard link, so a rename does not change what it reads.
 * `watch` polls. `exec` wraps every command in `timeout -k 5 <s>`, which
 * kills the command's whole process group, at most 600 s.
 */
export class ContainerEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;
  readonly #sandbox: Sandbox;
  readonly #unset: readonly string[];
  readonly #running = new Set<ExecProcess>();

  constructor(sandbox: Sandbox, options: { id: string; cwd: string; unsetEnv?: readonly string[] }) {
    this.#sandbox = sandbox;
    this.id = options.id;
    this.cwd = options.cwd;
    this.#unset = options.unsetEnv ?? [];
  }

  #resolve(path: string): string {
    let normalized = path;
    if (normalized === "~") normalized = "/root";
    else if (normalized.startsWith("~/")) normalized = `/root/${normalized.slice(2)}`;
    else if (normalized.startsWith("file://")) {
      try {
        normalized = decodeURIComponent(new URL(normalized).pathname);
      } catch {
        // Keep a malformed URL as an ordinary path.
      }
    }
    return posix.isAbsolute(normalized) ? posix.normalize(normalized) : posix.resolve(this.cwd, normalized);
  }

  /** One helper call. Failures to reach the container become `unknown` file errors. */
  async #call<T>(
    op: string,
    args: Record<string, unknown>,
    context: Context,
    stdin?: Uint8Array
  ): Promise<Result<T, FileError>> {
    const early = aborted(context, args.path as string | undefined);
    if (early) return early;
    let output: Uint8Array;
    try {
      const process = await this.#sandbox.spawn(["node", HELPER, op, JSON.stringify(args)], {
        stderr: "ignore",
        ...(stdin ? { stdin: oneChunk(stdin) } : {})
      });
      output = await readAll(process.stdout);
      await process.exitCode;
    } catch (error) {
      return err(
        new FileError("unknown", error instanceof Error ? error.message : String(error), args.path as string | undefined)
      );
    }
    const late = aborted(context, args.path as string | undefined);
    if (late) return late;
    let wire: Wire<T>;
    try {
      wire = JSON.parse(new TextDecoder().decode(output)) as Wire<T>;
    } catch {
      return err(new FileError("unknown", `otto-fs ${op} returned no result`, args.path as string | undefined));
    }
    if (wire.ok) return ok(wire.value);
    const code = FILE_CODES.has(wire.error.code as FileErrorCode) ? (wire.error.code as FileErrorCode) : "unknown";
    return err(new FileError(code, wire.error.message, wire.error.path));
  }

  async absolutePath(path: string): Promise<Result<string, FileError>> {
    return ok(this.#resolve(path));
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return ok(posix.join(...parts));
  }

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const bytes = await this.readBinaryFile(path, context);
    // As Node's readFile(path, "utf8"): a byte-order mark stays in the text.
    return bytes.ok ? ok(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.value)) : bytes;
  }

  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const read = await this.#call<string>("read", { path: this.#resolve(path) }, context);
    return read.ok ? ok(fromBase64(read.value)) : read;
  }

  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const opened = await this.#openLink(path, false, context);
    return opened.ok ? ok(new ContainerTextLineReader(this, opened.value.link, opened.value.info.path)) : opened;
  }

  async readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context
  ): Promise<Result<string[], FileError>> {
    if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
    const opened = await this.openTextLineReader(path, context);
    if (!opened.ok) return opened;
    const lines: string[] = [];
    try {
      while (options?.maxLines === undefined || lines.length < options.maxLines) {
        const line = await opened.value.readLine(context);
        if (!line.ok) return line;
        if (line.value === undefined) break;
        lines.push(line.value.text);
      }
      return ok(lines);
    } finally {
      await opened.value.close(context);
    }
  }

  async #openLink(
    path: string,
    noFollow: boolean,
    context: Context
  ): Promise<Result<{ link: string; info: FileInfo }, FileError>> {
    return this.#call("openReader", { path: this.#resolve(path), noFollow }, context);
  }

  /** Bytes `[offset, offset + length)` of a reader's link. */
  async readRange(link: string, offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
    const read = await this.#call<string>("read", { path: link, offset, length }, context);
    return read.ok ? ok(fromBase64(read.value)) : read;
  }

  async statLink(link: string, path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    const info = await this.#call<FileInfo>("stat", { path: link }, context);
    return info.ok ? ok({ ...info.value, name: posix.basename(path), path }) : info;
  }

  releaseLink(link: string): void {
    void this.#call("closeReader", { link }, BACKGROUND_CONTEXT).catch(() => {});
  }

  async openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    context: Context
  ): Promise<Result<BinaryReader, FileError>> {
    const opened = await this.#openLink(path, options?.noFollow === true, context);
    return opened.ok ? ok(new ContainerBinaryReader(this, opened.value.link, opened.value.info.path)) : opened;
  }

  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.#call("write", { path: this.#resolve(path) }, context, bytesOf(content));
  }

  async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.#call("write", { path: this.#resolve(path), append: true }, context, bytesOf(content));
  }

  async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    if (!Number.isSafeInteger(size) || size < 0) {
      return err(new FileError("invalid", "File size must be a non-negative safe integer", this.#resolve(path)));
    }
    return this.#call("truncate", { path: this.#resolve(path), size }, context);
  }

  async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    return this.#call("flush", { path: this.#resolve(path) }, context);
  }

  async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    const from = this.#resolve(sourcePath);
    return this.#call("rename", { path: from, from, to: this.#resolve(destinationPath) }, context);
  }

  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.#call("stat", { path: this.#resolve(path) }, context);
  }

  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    return this.#call("list", { path: this.#resolve(path) }, context);
  }

  async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    const dir = this.#resolve(path);
    const names = await this.#call<string[]>("names", { path: dir }, context);
    return names.ok ? ok(new ContainerDirReader(this, dir, names.value)) : names;
  }

  async statNames(dir: string, names: string[], context: Context): Promise<Result<FileInfo[], FileError>> {
    return this.#call("lstatMany", { path: dir, dir, names }, context);
  }

  async watch(
    targets: readonly WatchTarget[],
    onChange: (change: WatchChange) => void,
    context: Context
  ): Promise<Result<FileWatcher, FileError>> {
    const early = aborted(context);
    if (early) return early;
    const resolved = targets.map((target) => ({ ...target, path: this.#resolve(target.path) }));
    // Later scans outlive the caller's context: only `close()` ends the watch.
    const scan = (scanContext: Context = BACKGROUND_CONTEXT) =>
      this.#call<Record<string, string>>("watchscan", { targets: resolved }, scanContext);
    // Coverage is established before returning, so a change after this is never missed.
    const first = await scan(context);
    if (!first.ok) return first;
    return ok(new PollingWatcher(first.value, scan, onChange));
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    return this.#call("realpath", { path: this.#resolve(path) }, context);
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const info = await this.fileInfo(path, context);
    if (info.ok) return ok(true);
    return info.error.code === "not_found" ? ok(false) : err(info.error);
  }

  async createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context
  ): Promise<Result<void, FileError>> {
    return this.#call("mkdir", { path: this.#resolve(path), recursive: options?.recursive ?? true }, context);
  }

  async remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context
  ): Promise<Result<void, FileError>> {
    return this.#call(
      "rm",
      { path: this.#resolve(path), recursive: options?.recursive ?? false, force: options?.force ?? false },
      context
    );
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    return this.#call("mkdtemp", { prefix: prefix ?? "tmp-" }, context);
  }

  async createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context
  ): Promise<Result<string, FileError>> {
    const dir = await this.createTempDir("tmp-", context);
    if (!dir.ok) return dir;
    const file = posix.join(dir.value, `${options?.prefix ?? ""}${crypto.randomUUID()}${options?.suffix ?? ""}`);
    const written = await this.writeFile(file, "", context);
    return written.ok ? ok(file) : written;
  }

  async cleanup(): Promise<void> {
    for (const process of this.#running) {
      try {
        process.kill(9);
      } catch {
        // Already gone.
      }
    }
    this.#running.clear();
  }

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const signal = context.abortSignal;
    if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
    const requested = options?.timeout;
    if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0)) {
      return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
    }
    // Whatever the caller asks for, nothing runs longer than the sandbox allows.
    const seconds = Math.min(requested ?? MAX_COMMAND_SECONDS, MAX_COMMAND_SECONDS);
    const cwd = options?.cwd ? this.#resolve(options.cwd) : this.cwd;
    const argv = typeof command === "string" ? ["bash", "-c", command] : [...command];
    if (argv.length === 0) return err(new ExecutionError("spawn_error", "Empty argv: no program to run"));

    // A missing directory or program is a spawn error, not output and an exit code.
    try {
      const check = await this.#sandbox.spawn(
        [
          "sh",
          "-c",
          'test -d "$1" || exit 101; command -v -- "$2" >/dev/null 2>&1 || exit 102',
          "sh",
          cwd,
          argv[0]
        ],
        { stdout: "ignore", stderr: "ignore" }
      );
      const status = await check.exitCode;
      if (status === 101) {
        return err(new ExecutionError("spawn_error", `Working directory does not exist: ${cwd}\nCannot execute bash commands.`));
      }
      if (status === 102) return err(new ExecutionError("spawn_error", `Command not found: ${argv[0]}`));
    } catch (error) {
      return err(new ExecutionError("spawn_error", error instanceof Error ? error.message : String(error)));
    }

    const env = Object.entries(options?.env ?? {}).map(([key, value]) => `${key}=${value}`);
    const wrapped = [
      "env",
      // Absent, not empty: an empty GITHUB_TOKEN still reads as "a token is set".
      ...this.#unset.flatMap((name) => ["-u", name]),
      ...(options?.inheritEnv === false ? ["-i", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"] : []),
      ...env,
      "timeout",
      "-k",
      "5",
      String(seconds),
      ...argv
    ];

    let process: ExecProcess;
    try {
      process = await this.#sandbox.spawn(wrapped, { cwd });
    } catch (error) {
      return err(new ExecutionError("spawn_error", error instanceof Error ? error.message : String(error)));
    }
    this.#running.add(process);
    const started = Date.now();
    let abortedRun = false;
    let callbackError: ExecutionError | undefined;
    const stop = () => {
      try {
        // `timeout` forwards TERM to the command's process group, then KILLs it.
        process.kill(15);
      } catch {
        // Already exited.
      }
    };
    const onAbort = () => {
      abortedRun = true;
      stop();
    };
    signal?.addEventListener("abort", onAbort);

    // Every chunk, in arrival order, for the spill file once output crosses its thresholds.
    const spill = options?.spill;
    const kept: Uint8Array[] = [];
    let keptBytes = 0;
    let totalBytes = 0;
    let totalLines = 0;
    let spilling = false;
    let overflowed = false;

    const pump = async (stream: ReadableStream | null, name: "stdout" | "stderr") => {
      if (!stream) return;
      const decoder = new StreamDecoder();
      const reader = stream.getReader();
      const emit = (text: string) => {
        if (text === "" || !options?.onOutput || callbackError) return;
        try {
          options.onOutput(text, context, { stream: name });
        } catch (error) {
          callbackError = new ExecutionError("callback_error", error instanceof Error ? error.message : String(error));
          stop();
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        totalBytes += chunk.length;
        for (const byte of chunk) if (byte === 0x0a) totalLines++;
        if (spill) {
          if (keptBytes + chunk.length <= SPILL_MEMORY_BYTES) {
            kept.push(chunk);
            keptBytes += chunk.length;
          } else {
            overflowed = true;
          }
          if (totalBytes > spill.afterBytes || totalLines > spill.afterLines) spilling = true;
        }
        emit(decoder.decode(chunk));
      }
      emit(decoder.decode());
    };

    let exitCode: number;
    try {
      [, , exitCode] = await Promise.all([
        pump(process.stdout, "stdout"),
        pump(process.stderr, "stderr"),
        process.exitCode
      ]);
    } catch (error) {
      signal?.removeEventListener("abort", onAbort);
      this.#running.delete(process);
      return err(new ExecutionError("unknown", error instanceof Error ? error.message : String(error)));
    }
    signal?.removeEventListener("abort", onAbort);
    this.#running.delete(process);
    const elapsedMs = Date.now() - started;

    let spillPath: string | undefined;
    if (spilling) {
      const file = await this.createTempFile({ prefix: "pi-output-", suffix: ".log" }, BACKGROUND_CONTEXT);
      if (file.ok) {
        const notice = overflowed
          ? new TextEncoder().encode(`\n[otto: output beyond ${SPILL_MEMORY_BYTES} bytes was not kept]\n`)
          : new Uint8Array();
        const all = new Uint8Array(keptBytes + notice.length);
        let offset = 0;
        for (const chunk of kept) {
          all.set(chunk, offset);
          offset += chunk.length;
        }
        all.set(notice, offset);
        const written = await this.writeFile(file.value, all, BACKGROUND_CONTEXT);
        if (written.ok) spillPath = file.value;
      }
    }

    if (callbackError) return err(callbackError);
    if (abortedRun) {
      const error = new ExecutionError("aborted", "aborted");
      if (spillPath) error.spillPath = spillPath;
      return err(error);
    }
    if (TIMEOUT_EXITS.has(exitCode) && elapsedMs >= seconds * 1000 - 250) {
      const error = new ExecutionError("timeout", `Command timed out after ${seconds} seconds`);
      if (spillPath) error.spillPath = spillPath;
      return err(error);
    }
    return ok({ exitCode, ...(spillPath ? { spillPath } : {}) });
  }
}

class ContainerBinaryReader implements BinaryReader {
  #closed = false;
  constructor(
    readonly env: ContainerEnv,
    readonly link: string,
    readonly path: string
  ) {}

  async info(context: Context): Promise<Result<FileInfo, FileError>> {
    const early = aborted(context, this.path);
    if (early) return early;
    if (this.#closed) return closed("Binary reader", this.path);
    return this.env.statLink(this.link, this.path, context);
  }

  async read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
    const early = aborted(context, this.path);
    if (early) return early;
    if (this.#closed) return closed("Binary reader", this.path);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      return err(new FileError("invalid", "Offset and length must be non-negative safe integers", this.path));
    }
    if (length === 0) return ok(new Uint8Array());
    return this.env.readRange(this.link, offset, length, context);
  }

  async scanLines(options: { startLine: number; endLine?: number }, context: Context): Promise<Result<LineScan, FileError>> {
    const early = aborted(context, this.path);
    if (early) return early;
    if (this.#closed) return closed("Binary reader", this.path);
    let scanner: LineScanner;
    try {
      scanner = new LineScanner(options.startLine, options.endLine);
    } catch {
      return err(new FileError("invalid", "Invalid line range", this.path));
    }
    for (let position = 0; ; ) {
      const chunk = await this.env.readRange(this.link, position, READ_CHUNK, context);
      if (!chunk.ok) return chunk;
      if (chunk.value.length === 0) return ok(scanner.finish());
      scanner.push(chunk.value);
      position += chunk.value.length;
      if (chunk.value.length < READ_CHUNK) return ok(scanner.finish());
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.env.releaseLink(this.link);
  }
}

class ContainerTextLineReader implements TextLineReader {
  readonly #decoder = new StreamDecoder();
  #offset = 0;
  #buffered = "";
  #ended = false;
  #closed = false;

  constructor(
    readonly env: ContainerEnv,
    readonly link: string,
    readonly path: string
  ) {}

  async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
    const early = aborted(context, this.path);
    if (early) return early;
    if (this.#closed) return err(new FileError("invalid", "Text line reader is closed", this.path));
    for (;;) {
      const newline = this.#buffered.indexOf("\n");
      if (newline !== -1) {
        const text = this.#buffered.slice(0, newline);
        this.#buffered = this.#buffered.slice(newline + 1);
        return ok({ text, terminated: true });
      }
      if (this.#ended) {
        if (this.#buffered.length === 0) return ok(undefined);
        const text = this.#buffered;
        this.#buffered = "";
        return ok({ text, terminated: false });
      }
      const chunk = await this.env.readRange(this.link, this.#offset, LINE_CHUNK, context);
      if (!chunk.ok) return chunk;
      this.#offset += chunk.value.length;
      if (chunk.value.length === 0) {
        this.#buffered += this.#decoder.decode();
        this.#ended = true;
      } else {
        this.#buffered += this.#decoder.decode(chunk.value);
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffered = "";
    this.env.releaseLink(this.link);
  }
}

class ContainerDirReader implements DirReader {
  #index = 0;
  #closed = false;

  constructor(
    readonly env: ContainerEnv,
    readonly path: string,
    readonly names: string[]
  ) {}

  async next(maxEntries: number, context: Context): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
    const early = aborted(context, this.path);
    if (early) return early;
    if (this.#closed) return closed("Directory reader", this.path);
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      return err(new FileError("invalid", "maxEntries must be a positive safe integer", this.path));
    }
    const entries: FileInfo[] = [];
    // Entries removed since the listing are skipped, so keep reading until the page fills or the list ends.
    while (entries.length < maxEntries && this.#index < this.names.length) {
      const page = this.names.slice(this.#index, this.#index + (maxEntries - entries.length));
      this.#index += page.length;
      const infos = await this.env.statNames(this.path, page, context);
      if (!infos.ok) return infos;
      entries.push(...infos.value);
    }
    return ok({ entries, done: this.#index >= this.names.length });
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

/** Compares fingerprints of the watched paths every `WATCH_INTERVAL_MS`. */
class PollingWatcher implements FileWatcher {
  readonly mode = "polling" as const;
  #closed = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight: Promise<void> | undefined;

  constructor(
    private last: Record<string, string>,
    private readonly scan: () => Promise<Result<Record<string, string>, FileError>>,
    private readonly onChange: (change: WatchChange) => void
  ) {
    this.#schedule();
  }

  #schedule(): void {
    if (this.#closed) return;
    this.#timer = setTimeout(() => {
      this.#inFlight = this.#poll().finally(() => {
        this.#inFlight = undefined;
        this.#schedule();
      });
    }, WATCH_INTERVAL_MS);
  }

  async #poll(): Promise<void> {
    const next = await this.scan();
    if (this.#closed) return;
    if (!next.ok) {
      // Unreachable for a moment (a restart): rescan everything later.
      this.onChange({ overflow: true });
      return;
    }
    const paths = new Set<string>();
    for (const [path, print] of Object.entries(next.value)) if (this.last[path] !== print) paths.add(path);
    for (const path of Object.keys(this.last)) if (!(path in next.value)) paths.add(path);
    this.last = next.value;
    if (paths.size > 0) this.onChange({ paths: [...paths].sort() });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#inFlight;
  }
}
