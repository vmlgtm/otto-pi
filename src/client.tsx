import {
  Badge,
  Button,
  InputArea,
  Text
} from "@cloudflare/kumo";
import {
  CheckCircleIcon,
  CodeIcon,
  CompassIcon,
  FilePlusIcon,
  GearIcon,
  GitBranchIcon,
  InfinityIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  PlusIcon,
  ShieldCheckIcon,
  StopIcon,
  SunIcon,
  UsersIcon,
  WrenchIcon,
  XCircleIcon,
  XIcon
} from "@phosphor-icons/react";
import { createCodePlugin } from "@streamdown/code";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";
import type {
  SubagentInfo,
  SubagentRole,
  ToolInfo,
  TranscriptMessage,
  TranscriptPart
} from "./protocol";
import { usePiSession } from "./use-pi-session";
import "./styles.css";

const codePlugin = createCodePlugin({
  themes: ["github-light", "github-dark"]
});

const SESSION_KEY = "pi-harness-session";
const MODEL = "@cf/qwen/qwen3.8-27b";

const ROLE_CONFIG: Record<
  SubagentRole,
  {
    readonly name: string;
    readonly icon: typeof CompassIcon;
    readonly badgeClass: string;
    readonly textClass: string;
    readonly borderClass: string;
    readonly bgClass: string;
    readonly description: string;
  }
> = {
  explorer: {
    name: "Explorer",
    icon: CompassIcon,
    badgeClass: "bg-cyan-500/10 text-cyan-400 border-cyan-500/30",
    textClass: "text-cyan-400",
    borderClass: "border-cyan-500/40",
    bgClass: "bg-cyan-400",
    description: "Codebase Mapping & Read-Only Analysis"
  },
  coder: {
    name: "Coder",
    icon: CodeIcon,
    badgeClass: "bg-amber-500/10 text-amber-400 border-amber-500/30",
    textClass: "text-amber-400",
    borderClass: "border-amber-500/40",
    bgClass: "bg-amber-400",
    description: "Surgical Implementation & Local Test Execution"
  },
  reviewer: {
    name: "Reviewer",
    icon: ShieldCheckIcon,
    badgeClass: "bg-purple-500/10 text-purple-400 border-purple-500/30",
    textClass: "text-purple-400",
    borderClass: "border-purple-500/40",
    bgClass: "bg-purple-400",
    description: "Diff Audit, Blast Radius & Security Verification"
  }
};

const SUGGESTIONS = [
  {
    icon: <FilePlusIcon size={15} />,
    label: "Write a file",
    value:
      "Write a haiku about Durable Objects to /workspace/haiku.txt, then read it back."
  },
  {
    icon: <CodeIcon size={15} />,
    label: "Run JavaScript",
    value:
      "Use exec to run JavaScript that lists /workspace and returns the size of each file."
  },
  {
    icon: <GitBranchIcon size={15} />,
    label: "Clone a repo",
    value:
      "Clone https://github.com/octocat/Hello-World into /workspace/hello, then show its git log."
  }
] satisfies Array<{ icon: ReactNode; label: string; value: string }>;

function getSession(): string {
  const existing = localStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(SESSION_KEY, created);
  return created;
}

function ModeToggle() {
  const [mode, setMode] = useState(
    () => localStorage.getItem("theme") ?? "dark"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      shape="square"
      aria-label="Toggle theme"
      onClick={() => setMode((value) => (value === "light" ? "dark" : "light"))}
      icon={mode === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
    />
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-40 overflow-auto rounded-lg border border-kumo-line bg-kumo-recessed p-2.5 text-xs leading-5 whitespace-pre-wrap break-words">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function ToolCallCard({
  part,
  running
}: {
  part: Extract<TranscriptPart, { type: "tool-call" }>;
  running: boolean;
}) {
  const isDelegate = part.name === "delegate_task";
  const args =
    isDelegate && typeof part.arguments === "object" && part.arguments !== null
      ? (part.arguments as {
          role?: SubagentRole;
          task?: string;
          mode?: string;
          context?: string;
        })
      : null;
  const roleCfg =
    args?.role && args.role in ROLE_CONFIG ? ROLE_CONFIG[args.role] : null;

  if (isDelegate && roleCfg && args) {
    const RoleIcon = roleCfg.icon;
    return (
      <details
        className={`timeline-card group overflow-hidden border ${roleCfg.borderClass} bg-kumo-base/80`}
      >
        <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3.5 py-2.5 select-none hover:bg-white/5 transition-colors">
          {running ? (
            <GearIcon
              size={15}
              className={`animate-spin ${roleCfg.textClass}`}
            />
          ) : (
            <div
              className={`size-2.5 rounded-full ${roleCfg.bgClass} shadow-[0_0_8px_rgba(255,255,255,0.4)]`}
            />
          )}
          <div className="flex min-w-0 flex-1 items-center gap-2 flex-wrap sm:flex-nowrap">
            <span
              className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider ${roleCfg.badgeClass}`}
            >
              <RoleIcon size={12} weight="bold" />
              {roleCfg.name}
            </span>
            <span className="font-mono text-xs text-kumo-inactive">
              delegate_task
            </span>
            {args.task ? (
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-kumo-strong">
                "{args.task}"
              </span>
            ) : null}
          </div>
          <Badge
            variant={running ? "primary" : "secondary"}
            className="font-mono text-[10px] px-1.5 py-0.5 shrink-0"
          >
            {running ? "Working..." : "Dispatched"}
          </Badge>
        </summary>
        <div className="space-y-2.5 border-t border-kumo-line bg-kumo-recessed/40 px-3.5 py-3 text-xs">
          <div>
            <span className="font-mono text-[10px] uppercase font-semibold text-kumo-inactive">
              Assigned Task
            </span>
            <p className="mt-0.5 text-xs font-medium text-kumo-strong leading-relaxed">
              {args.task}
            </p>
          </div>
          {args.context ? (
            <div>
              <span className="font-mono text-[10px] uppercase font-semibold text-kumo-inactive">
                Architect Context
              </span>
              <p className="mt-0.5 text-xs text-kumo-subtle italic leading-relaxed whitespace-pre-wrap">
                {args.context}
              </p>
            </div>
          ) : null}
          <div className="flex items-center gap-3 pt-1 text-[11px] text-kumo-inactive font-mono">
            <span>
              Role:{" "}
              <strong className={roleCfg.textClass}>{roleCfg.name}</strong> (
              {roleCfg.description})
            </span>
            <span>Mode: {args.mode ?? "fresh"}</span>
          </div>
          <details className="pt-1">
            <summary className="cursor-pointer text-[10px] font-mono text-kumo-inactive hover:text-kumo-subtle">
              Raw Arguments
            </summary>
            <div className="mt-1">
              <JsonBlock value={part.arguments} />
            </div>
          </details>
        </div>
      </details>
    );
  }

  return (
    <details className="timeline-card group overflow-hidden">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3.5 py-2.5 select-none">
        {running ? (
          <GearIcon size={14} className="animate-spin text-kumo-brand" />
        ) : (
          <div className="size-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-kumo-strong">
          {part.name}
        </span>
        <Badge variant="secondary" className="font-mono text-[10px] px-1.5 py-0.5">
          {running ? "Running" : "Called"}
        </Badge>
      </summary>
      <div className="border-t border-kumo-line bg-kumo-base/50 px-3.5 py-3">
        <p className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-kumo-inactive">
          Arguments
        </p>
        <JsonBlock value={part.arguments} />
      </div>
    </details>
  );
}

function ToolResultCard({
  part
}: {
  part: Extract<TranscriptPart, { type: "tool-result" }>;
}) {
  const text = part.content
    .filter((content) => content.type === "text")
    .map((content) => (content.type === "text" ? content.text : ""))
    .join("\n");
  const images = part.content.filter((content) => content.type === "image");

  const isDelegate = part.name === "delegate_task";
  let delegateResult: {
    sessionId?: string;
    role?: SubagentRole;
    status?: string;
    summary?: string;
    filesModified?: string[];
    turnCount?: number;
  } | null = null;

  if (isDelegate) {
    if (
      part.details &&
      typeof part.details === "object" &&
      "role" in (part.details as any)
    ) {
      delegateResult = part.details as any;
    } else if (text) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && "role" in parsed) {
          delegateResult = parsed;
        }
      } catch {}
    }
  }

  const roleCfg =
    delegateResult?.role && delegateResult.role in ROLE_CONFIG
      ? ROLE_CONFIG[delegateResult.role]
      : null;

  if (isDelegate && delegateResult && roleCfg) {
    const RoleIcon = roleCfg.icon;
    const isSuccess = delegateResult.status === "completed" && !part.error;
    const isLimit = delegateResult.status === "turn_limit_reached";

    return (
      <details
        className={`timeline-card group overflow-hidden border ${roleCfg.borderClass} bg-kumo-base/80`}
      >
        <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3.5 py-2.5 select-none hover:bg-white/5 transition-colors">
          {part.error ? (
            <div className="size-2.5 rounded-full bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.7)]" />
          ) : isSuccess ? (
            <div className="size-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]" />
          ) : (
            <div className="size-2.5 rounded-full bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.7)]" />
          )}
          <div className="flex min-w-0 flex-1 items-center gap-2 flex-wrap sm:flex-nowrap">
            <span
              className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider ${roleCfg.badgeClass}`}
            >
              <RoleIcon size={12} weight="bold" />
              {roleCfg.name}
            </span>
            <span className="font-mono text-xs text-kumo-inactive">
              delegate_task result
            </span>
            <span className="text-xs text-kumo-subtle truncate">
              {isSuccess
                ? `Completed in ${delegateResult.turnCount ?? 1} turn${(delegateResult.turnCount ?? 1) === 1 ? "" : "s"}`
                : isLimit
                  ? `Turn limit reached (${delegateResult.turnCount ?? 10} turns)`
                  : delegateResult.status}
              {delegateResult.filesModified &&
              delegateResult.filesModified.length > 0
                ? ` • ${delegateResult.filesModified.length} file${delegateResult.filesModified.length === 1 ? "" : "s"} modified`
                : ""}
            </span>
          </div>
          <Badge
            variant={
              part.error ? "destructive" : isSuccess ? "success" : "secondary"
            }
            className="font-mono text-[10px] px-1.5 py-0.5 shrink-0"
          >
            {part.error ? "Failed" : isSuccess ? "Done" : delegateResult.status}
          </Badge>
        </summary>
        <div className="space-y-3 border-t border-kumo-line bg-kumo-base/50 px-3.5 py-3">
          {delegateResult.summary ? (
            <div>
              <p className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-kumo-inactive">
                Handoff Summary to Architect
              </p>
              <pre className="max-h-56 overflow-auto rounded-lg border border-kumo-line bg-kumo-recessed p-2.5 font-mono text-xs leading-5 whitespace-pre-wrap text-kumo-strong">
                {delegateResult.summary}
              </pre>
            </div>
          ) : text ? (
            <div>
              <p className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-kumo-inactive">
                Output
              </p>
              <JsonBlock value={text} />
            </div>
          ) : null}

          {delegateResult.filesModified &&
          delegateResult.filesModified.length > 0 ? (
            <div>
              <p className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-kumo-inactive">
                Files Modified
              </p>
              <div className="flex flex-wrap gap-1.5">
                {delegateResult.filesModified.map((file) => (
                  <span
                    key={file}
                    className="rounded-md border border-kumo-line bg-kumo-recessed px-2 py-0.5 font-mono text-xs text-kumo-strong"
                  >
                    {file}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <details className="mt-2">
            <summary className="cursor-pointer text-[10px] font-mono text-kumo-inactive hover:text-kumo-subtle">
              Raw Payload
            </summary>
            <div className="mt-1">
              <JsonBlock value={part.details ?? text} />
            </div>
          </details>
        </div>
      </details>
    );
  }

  return (
    <details className="timeline-card group overflow-hidden">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3.5 py-2.5 select-none">
        {part.error ? (
          <div className="size-2 rounded-full bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.7)]" />
        ) : (
          <div className="size-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          <span className="font-semibold text-kumo-strong">{part.name}</span>
          {text ? <span className="ml-2 font-sans text-kumo-subtle">{text}</span> : null}
        </span>
        <Badge
          variant={part.error ? "destructive" : "secondary"}
          className="font-mono text-[10px] px-1.5 py-0.5"
        >
          {part.error ? "Failed" : "Done"}
        </Badge>
      </summary>
      <div className="space-y-3 border-t border-kumo-line bg-kumo-base/50 px-3.5 py-3">
        {text ? (
          <div>
            <p className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-kumo-inactive">
              Output
            </p>
            <JsonBlock value={text} />
          </div>
        ) : null}
        {images.map((image, index) =>
          image.type === "image" ? (
            <img
              key={index}
              src={`data:${image.mimeType};base64,${image.data}`}
              alt={`${part.name} output`}
              className="max-w-full rounded-lg"
            />
          ) : null
        )}
        {part.details !== undefined ? (
          <div>
            <p className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-kumo-inactive">
              Details
            </p>
            <JsonBlock value={part.details} />
          </div>
        ) : null}
      </div>
    </details>
  );
}

function AssistantPart({
  part,
  running
}: {
  part: TranscriptPart;
  running: boolean;
}) {
  switch (part.type) {
    case "text":
      return (
        <Streamdown
          className="sd-theme text-sm leading-6"
          plugins={{ code: codePlugin }}
          controls={false}
        >
          {part.text}
        </Streamdown>
      );
    case "thinking":
      return (
        <details className="rounded-xl border border-kumo-line bg-kumo-recessed/40 px-3 py-2">
          <summary className="cursor-pointer list-none text-xs font-semibold text-kumo-subtle hover:text-kumo-default">
            Thinking
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-xs italic leading-5 text-kumo-subtle">
            {part.text}
          </p>
        </details>
      );
    case "tool-call":
      return <ToolCallCard part={part} running={running} />;
    case "tool-result":
      return <ToolResultCard part={part} />;
    case "image":
      return (
        <img
          src={`data:${part.mimeType};base64,${part.data}`}
          alt=""
          className="max-w-full rounded-lg"
        />
      );
  }
}

function UserMessage({ message }: { message: TranscriptMessage }) {
  const text = message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm border border-white/10 bg-zinc-900/90 px-4 py-3 text-sm leading-relaxed text-zinc-100 shadow-md backdrop-blur-md">
        {text}
      </div>
    </div>
  );
}

function AssistantMessage({
  message,
  streaming = false,
  runningTools
}: {
  message: TranscriptMessage;
  streaming?: boolean;
  runningTools: readonly string[];
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="otto-mark mt-0.5 size-8 rounded-lg">
        <InfinityIcon size={18} weight="bold" />
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        {message.parts.map((part, index) => (
          <AssistantPart
            key={`${message.id}-${index}`}
            part={part}
            running={
              streaming &&
              part.type === "tool-call" &&
              runningTools.includes(part.name)
            }
          />
        ))}
        {streaming ? <span className="streaming-cursor" /> : null}
        {message.error ? (
          <div
            role="alert"
            className="rounded-xl bg-kumo-danger/10 px-4 py-3 text-sm text-kumo-danger"
          >
            {message.error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ToolMessage({ message }: { message: TranscriptMessage }) {
  return (
    <div className="ml-11 space-y-2">
      {message.parts.map((part, index) =>
        part.type === "tool-result" ? (
          <ToolResultCard key={`${message.id}-${index}`} part={part} />
        ) : null
      )}
    </div>
  );
}

function Message({
  message,
  streaming = false,
  runningTools
}: {
  message: TranscriptMessage;
  streaming?: boolean;
  runningTools: readonly string[];
}) {
  switch (message.role) {
    case "user":
      return <UserMessage message={message} />;
    case "assistant":
      return (
        <AssistantMessage
          message={message}
          streaming={streaming}
          runningTools={runningTools}
        />
      );
    case "tool":
      return <ToolMessage message={message} />;
    case "notice":
      return message.parts.length === 0 ? null : (
        <p className="text-center text-xs text-kumo-inactive">
          {message.parts
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("")}
        </p>
      );
  }
}

function SubagentCard({ subagent }: { subagent: SubagentInfo }) {
  const roleCfg = ROLE_CONFIG[subagent.role];
  const RoleIcon = roleCfg?.icon ?? UsersIcon;

  return (
    <div
      className={`timeline-card p-3 space-y-2.5 border ${roleCfg?.borderClass ?? ""}`}
    >
      <div className="flex items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider ${
              roleCfg?.badgeClass ?? "bg-zinc-800 text-zinc-300 border-zinc-700"
            }`}
          >
            <RoleIcon size={11} weight="bold" />
            {roleCfg?.name ?? subagent.role}
          </span>
          <span className="font-mono text-[10px] text-kumo-inactive">
            #{subagent.sessionId.slice(-6)}
          </span>
        </div>
        <Badge
          variant={
            subagent.status === "completed"
              ? "success"
              : subagent.status === "running"
                ? "primary"
                : "secondary"
          }
          className="font-mono text-[10px] px-1.5 py-0.5"
        >
          {subagent.status === "running" ? (
            <span className="flex items-center gap-1">
              <GearIcon size={11} className="animate-spin text-kumo-brand" />{" "}
              Running
            </span>
          ) : subagent.status === "completed" ? (
            "Completed"
          ) : subagent.status === "turn_limit_reached" ? (
            "Turn Limit"
          ) : (
            subagent.status
          )}
        </Badge>
      </div>

      <p className="text-xs text-kumo-strong font-medium leading-snug">{subagent.task}</p>

      {subagent.turnCount !== undefined ? (
        <div className="flex items-center gap-2 text-[10px] text-kumo-subtle font-mono">
          <span>Turns: {subagent.turnCount} / 10</span>
          {subagent.filesModified && subagent.filesModified.length > 0 ? (
            <span>• Files: {subagent.filesModified.length}</span>
          ) : null}
        </div>
      ) : null}

      {subagent.filesModified && subagent.filesModified.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {subagent.filesModified.map((f) => (
            <span
              key={f}
              className="rounded bg-kumo-recessed px-1.5 py-0.5 font-mono text-[9px] text-kumo-subtle"
            >
              {f.split("/").pop()}
            </span>
          ))}
        </div>
      ) : null}

      {subagent.summary ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-[10px] font-semibold text-kumo-brand hover:underline">
            View Handoff Summary
          </summary>
          <pre className="mt-1.5 max-h-36 overflow-auto rounded-lg border border-kumo-line bg-kumo-recessed p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-kumo-subtle">
            {subagent.summary}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function Sidebar({
  tab,
  setTab,
  tools,
  activeTools,
  subagents,
  onClose
}: {
  tab: "subagents" | "tools";
  setTab: (tab: "subagents" | "tools") => void;
  tools: readonly ToolInfo[];
  activeTools: readonly string[];
  subagents: readonly SubagentInfo[];
  onClose: () => void;
}) {
  const activeSubagentsCount = subagents.filter((s) => s.status === "running").length;

  return (
    <aside
      className="flex min-h-0 flex-col border-l border-kumo-line bg-kumo-base/90 backdrop-blur-md"
      aria-label="Sidebar"
    >
      <div className="flex h-[64px] shrink-0 items-center justify-between gap-2 border-b border-kumo-line px-4">
        <div className="flex items-center gap-1 rounded-xl bg-kumo-recessed/60 p-1">
          <button
            type="button"
            onClick={() => setTab("subagents")}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition-all cursor-pointer ${
              tab === "subagents"
                ? "bg-kumo-base text-kumo-strong shadow-sm"
                : "text-kumo-subtle hover:text-kumo-strong"
            }`}
          >
            <UsersIcon size={14} />
            Swarm
            <Badge variant="secondary" className="font-mono text-[9px] px-1 py-0">
              {subagents.length}
            </Badge>
          </button>
          <button
            type="button"
            onClick={() => setTab("tools")}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition-all cursor-pointer ${
              tab === "tools"
                ? "bg-kumo-base text-kumo-strong shadow-sm"
                : "text-kumo-subtle hover:text-kumo-strong"
            }`}
          >
            <WrenchIcon size={14} />
            Tools
            <Badge variant="secondary" className="font-mono text-[9px] px-1 py-0">
              {tools.length}
            </Badge>
          </button>
        </div>
        <Button
          variant="ghost"
          shape="square"
          aria-label="Close sidebar"
          onClick={onClose}
          icon={<XIcon size={16} />}
        />
      </div>

      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3.5">
        {tab === "subagents" ? (
          subagents.length === 0 ? (
            <div className="py-12 text-center text-kumo-subtle space-y-2">
              <UsersIcon size={28} className="mx-auto text-kumo-inactive" />
              <p className="text-xs font-medium">No subagents active</p>
              <p className="text-[11px] max-w-[220px] mx-auto text-kumo-inactive">
                The Architect delegates modular tasks to Explorer, Coder, and Reviewer subagents.
              </p>
            </div>
          ) : (
            subagents.map((subagent) => (
              <SubagentCard key={subagent.sessionId} subagent={subagent} />
            ))
          )
        ) : (
          tools.map((tool) => (
            <div key={tool.name} className="timeline-card p-3">
              <div className="flex items-center gap-2">
                {activeTools.includes(tool.name) ? (
                  <GearIcon size={14} className="animate-spin text-kumo-brand" />
                ) : (
                  <WrenchIcon size={13} className="text-kumo-inactive" />
                )}
                <code className="text-xs font-semibold text-kumo-strong">{tool.name}</code>
              </div>
              <p className="mt-1 text-xs text-kumo-subtle leading-relaxed">{tool.description}</p>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

function App() {
  const [session, setSession] = useState(getSession);
  const [prompt, setPrompt] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.matchMedia("(min-width: 1100px)").matches
  );
  const [sidebarTab, setSidebarTab] = useState<"subagents" | "tools">("subagents");
  const endRef = useRef<HTMLDivElement>(null);
  const {
    status,
    messages,
    live,
    running,
    tools: running_,
    catalog,
    subagents,
    queued,
    retry,
    error,
    submit: submitPrompt,
    abort
  } = usePiSession(session);
  const runningTools = running_.map((tool) => tool.name);
  const activeSubagentsCount = subagents.filter((s) => s.status === "running").length;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, live, running]);

  useEffect(() => {
    if (activeSubagentsCount > 0) {
      setSidebarTab("subagents");
      if (window.innerWidth >= 1024) {
        setSidebarOpen(true);
      }
    }
  }, [activeSubagentsCount]);

  const connected = status === "open";

  /** While a run is going, Enter queues a follow-up and Steer joins the run. */
  const submit = (whenBusy: "followUp" | "steer" = "followUp") => {
    const text = prompt.trim();
    if (!text || !connected) return;
    setPrompt("");
    submitPrompt(text, whenBusy);
  };

  const newSession = () => {
    const next = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, next);
    setSession(next);
  };

  const empty = messages.length === 0 && !live && !running;

  return (
    <div
      className={`grid h-dvh overflow-hidden studio-ambient text-kumo-default ${
        sidebarOpen
          ? "lg:grid-cols-[minmax(520px,1fr)_minmax(320px,26vw)]"
          : "grid-cols-1"
      }`}
    >
      <section className="flex min-h-0 min-w-0 flex-col" aria-label="Chat">
        <header className="glass-header shrink-0 z-10">
          <div className="mx-auto flex h-[64px] max-w-3xl items-center justify-between gap-3 px-5">
            <div className="flex min-w-0 items-center gap-3">
              <div className="otto-mark size-9 rounded-xl">
                <InfinityIcon size={22} weight="bold" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold tracking-tight text-kumo-strong">
                  Otto
                </h1>
                <p className="truncate font-mono text-[11px] text-kumo-subtle">
                  session <span className="text-kumo-inactive">{session.slice(0, 8)}</span>
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Badge variant="secondary" className="hidden font-mono text-[11px] sm:inline-flex">
                {MODEL.split("/").at(-1)}
              </Badge>
              <Badge variant={connected ? "success" : "secondary"} className="gap-1.5 font-mono text-[11px]">
                {connected ? <span className="live-dot" /> : null}
                {connected
                  ? "Live"
                  : status === "connecting"
                    ? "Connecting"
                    : "Reconnecting"}
              </Badge>
              <Button
                variant="ghost"
                shape="square"
                aria-label="Swarm Subagents"
                aria-expanded={sidebarOpen && sidebarTab === "subagents"}
                onClick={() => {
                  if (sidebarOpen && sidebarTab === "subagents") {
                    setSidebarOpen(false);
                  } else {
                    setSidebarTab("subagents");
                    setSidebarOpen(true);
                  }
                }}
                icon={
                  <div className="relative">
                    <UsersIcon size={16} />
                    {activeSubagentsCount > 0 ? (
                      <span className="absolute -top-1 -right-1 size-2 rounded-full bg-emerald-400 animate-pulse" />
                    ) : null}
                  </div>
                }
              />
              <Button
                variant="ghost"
                shape="square"
                aria-label="Tools"
                aria-expanded={sidebarOpen && sidebarTab === "tools"}
                onClick={() => {
                  if (sidebarOpen && sidebarTab === "tools") {
                    setSidebarOpen(false);
                  } else {
                    setSidebarTab("tools");
                    setSidebarOpen(true);
                  }
                }}
                icon={<WrenchIcon size={16} />}
              />
              <Button
                variant="ghost"
                shape="square"
                aria-label="New session"
                onClick={newSession}
                icon={<PlusIcon size={16} />}
              />
              <ModeToggle />
            </div>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-6 px-5 py-6">
            {subagents.length > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-kumo-line bg-kumo-recessed/60 px-3.5 py-2.5 backdrop-blur-md shadow-sm">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-kumo-strong mr-1">
                    <UsersIcon size={15} className="text-kumo-brand" />
                    <span>Swarm Pipeline:</span>
                  </div>
                  {subagents.map((s) => {
                    const cfg = ROLE_CONFIG[s.role];
                    const Icon = cfg?.icon ?? UsersIcon;
                    return (
                      <div
                        key={s.sessionId}
                        className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-mono transition-all ${
                          cfg?.badgeClass ?? "border-zinc-700 bg-zinc-800 text-zinc-300"
                        } ${s.status === "running" ? "ring-2 ring-kumo-brand/40 shadow-sm" : ""}`}
                      >
                        <Icon size={12} weight="bold" />
                        <span className="font-bold uppercase">{cfg?.name ?? s.role}</span>
                        {s.status === "running" ? (
                          <span className="flex items-center gap-1 text-[10px] text-amber-400 font-sans font-semibold">
                            <GearIcon size={11} className="animate-spin" />
                            working...
                          </span>
                        ) : s.status === "completed" ? (
                          <CheckCircleIcon size={13} weight="bold" className="text-emerald-400" />
                        ) : s.status === "turn_limit_reached" ? (
                          <span className="text-[10px] text-amber-400">limit</span>
                        ) : (
                          <XCircleIcon size={13} weight="bold" className="text-rose-400" />
                        )}
                      </div>
                    );
                  })}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSidebarTab("subagents");
                    setSidebarOpen(true);
                  }}
                  className="cursor-pointer text-xs font-medium text-kumo-brand hover:underline flex items-center gap-1"
                >
                  Inspect details →
                </button>
              </div>
            ) : null}

            {empty ? (
              <div className="py-12 sm:py-20 text-center">
                <div className="mx-auto mb-6 flex size-16 items-center justify-center rounded-2xl otto-hero-mark">
                  <InfinityIcon size={38} weight="bold" />
                </div>
                <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-kumo-strong">
                  Otto Swarm
                </h2>
                <p className="mx-auto mt-2 max-w-md text-sm text-kumo-subtle leading-relaxed">
                  Autonomous multi-agent engineering swarm. Orchestrates specialist subagents (Explorer, Coder, Reviewer) to inspect, solve, and audit changes.
                </p>
                <div className="mt-8 grid gap-3 sm:grid-cols-3 text-left">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion.label}
                      type="button"
                      disabled={!connected}
                      onClick={() => setPrompt(suggestion.value)}
                      className="hero-card flex flex-col justify-between p-4 text-left cursor-pointer group"
                    >
                      <div className="flex items-center gap-2 mb-2 text-kumo-strong">
                        {suggestion.icon}
                        <span className="text-xs font-semibold text-kumo-strong group-hover:text-white transition-colors">
                          {suggestion.label}
                        </span>
                      </div>
                      <p className="text-[11px] text-kumo-subtle line-clamp-3 leading-relaxed">
                        {suggestion.value}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {messages.map((message) => (
              <Message
                key={message.id}
                message={message}
                runningTools={runningTools}
              />
            ))}

            {live ? (
              <Message message={live} streaming runningTools={runningTools} />
            ) : null}

            {running && !live ? (
              <div className="flex items-start gap-3">
                <div className="otto-mark mt-0.5 size-8 rounded-lg">
                  <InfinityIcon size={18} weight="bold" />
                </div>
                <div className="timeline-card px-4 py-3">
                  <div className="flex items-center gap-2.5 text-sm text-kumo-subtle flex-wrap">
                    <GearIcon size={15} className="animate-spin text-kumo-brand shrink-0" />
                    {retry ? (
                      `Retrying: ${retry.error}`
                    ) : runningTools.includes("delegate_task") ? (
                      (() => {
                        const active = subagents.find((s) => s.status === "running");
                        const activeRole = active?.role;
                        const roleCfg =
                          activeRole && activeRole in ROLE_CONFIG
                            ? ROLE_CONFIG[activeRole]
                            : null;
                        const RoleIcon = roleCfg?.icon;
                        return (
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-kumo-strong font-medium">
                              Swarm active:
                            </span>
                            {roleCfg && RoleIcon ? (
                              <span
                                className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-xs font-bold uppercase tracking-wider ${roleCfg.badgeClass}`}
                              >
                                <RoleIcon size={13} weight="bold" />
                                {roleCfg.name}
                              </span>
                            ) : (
                              <span className="font-mono text-xs font-semibold uppercase text-kumo-strong">
                                Subagent
                              </span>
                            )}
                            {active?.task ? (
                              <span className="text-xs text-kumo-subtle truncate max-w-[280px] sm:max-w-[420px]">
                                "{active.task}"
                              </span>
                            ) : (
                              <span className="text-xs text-kumo-subtle">
                                working on delegated task...
                              </span>
                            )}
                            {active?.turnCount !== undefined ? (
                              <Badge variant="secondary" className="font-mono text-[10px]">
                                Turn {active.turnCount}/10
                              </Badge>
                            ) : null}
                          </div>
                        );
                      })()
                    ) : runningTools.length > 0 ? (
                      `Running ${runningTools.join(", ")}`
                    ) : (
                      "Waiting for the model..."
                    )}
                  </div>
                </div>
              </div>
            ) : null}

            {running_.map((tool) =>
              tool.output ? (
                <pre
                  key={tool.callId}
                  className="ml-11 max-h-40 overflow-auto rounded-xl border border-kumo-line bg-kumo-recessed p-3 font-mono text-xs"
                >
                  {tool.output}
                </pre>
              ) : null
            )}

            {queued > 0 ? (
              <p className="ml-11 font-mono text-xs text-kumo-subtle">
                {queued} queued behind this turn
              </p>
            ) : null}

            {error ? (
              <div
                role="alert"
                className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-300"
              >
                {error}
              </div>
            ) : null}

            <div ref={endRef} />
          </div>
        </main>

        <div className="shrink-0 p-4 sm:p-5">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
            className="mx-auto max-w-3xl"
          >
            <div className="floating-dock flex items-end gap-3 rounded-2xl p-3 sm:p-3.5 transition-all focus-within:ring-2 focus-within:ring-kumo-brand/40">
              <InputArea
                value={prompt}
                onValueChange={setPrompt}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder={
                  running
                    ? "Queue a follow-up, or steer the running turn..."
                    : "Ask Otto..."
                }
                aria-label="Message Otto"
                disabled={!connected}
                rows={2}
                className="flex-1 !bg-transparent !shadow-none !ring-0 !outline-none focus:!ring-0 text-sm placeholder:text-kumo-placeholder"
              />
              {running ? (
                <div className="mb-0.5 flex gap-1.5">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    aria-label="Steer"
                    disabled={prompt.trim() === ""}
                    onClick={() => submit("steer")}
                  >
                    Steer
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    shape="square"
                    aria-label="Stop"
                    onClick={abort}
                    icon={<StopIcon size={18} weight="fill" />}
                  />
                </div>
              ) : (
                <Button
                  type="submit"
                  variant="primary"
                  shape="square"
                  aria-label="Send message"
                  disabled={!connected || prompt.trim() === ""}
                  icon={<PaperPlaneRightIcon size={18} />}
                  className="mb-0.5 !bg-black dark:!bg-white hover:!bg-zinc-800 dark:hover:!bg-zinc-200 !text-white dark:!text-black shadow-sm"
                />
              )}
            </div>
            <div className="mt-2.5 flex items-center justify-center">
              <span className="font-mono text-[10px] text-kumo-inactive">
                Enter to send <span className="opacity-40">·</span> Shift+Enter for new line
              </span>
            </div>
          </form>
        </div>
      </section>

      {sidebarOpen ? (
        <Sidebar
          tab={sidebarTab}
          setTab={setSidebarTab}
          tools={catalog}
          activeTools={runningTools}
          subagents={subagents}
          onClose={() => setSidebarOpen(false)}
        />
      ) : null}
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<App />);
