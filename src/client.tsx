import {
  Badge,
  Button,
  InputArea,
  Text
} from "@cloudflare/kumo";
import {
  CheckCircleIcon,
  CodeIcon,
  FilePlusIcon,
  GearIcon,
  GitBranchIcon,
  InfinityIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  PlusIcon,
  StopIcon,
  SunIcon,
  WrenchIcon,
  XCircleIcon,
  XIcon
} from "@phosphor-icons/react";
import { createCodePlugin } from "@streamdown/code";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";
import type { ToolInfo, TranscriptMessage, TranscriptPart } from "./protocol";
import { usePiSession } from "./use-pi-session";
import "./styles.css";

const codePlugin = createCodePlugin({
  themes: ["github-light", "github-dark"]
});

const SESSION_KEY = "pi-harness-session";
const MODEL = "@cf/qwen/qwen3.8-27b";

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

function Sidebar({
  tools,
  activeTools,
  onClose
}: {
  tools: readonly ToolInfo[];
  activeTools: readonly string[];
  onClose: () => void;
}) {
  return (
    <aside
      className="flex min-h-0 flex-col border-l border-kumo-line bg-kumo-base/90 backdrop-blur-md"
      aria-label="Tools"
    >
      <div className="flex h-[64px] shrink-0 items-center justify-between gap-2 border-b border-kumo-line px-4">
        <div className="flex items-center gap-2">
          <Text size="sm" bold>
            Tools
          </Text>
          <Badge variant="secondary" className="font-mono text-[10px] px-1.5 py-0.5">
            {tools.length}
          </Badge>
        </div>
        <Button
          variant="ghost"
          shape="square"
          aria-label="Close tools"
          onClick={onClose}
          icon={<XIcon size={16} />}
        />
      </div>
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3.5">
        {tools.map((tool) => (
          <div
            key={tool.name}
            className="timeline-card p-3"
          >
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
        ))}
      </div>
    </aside>
  );
}

function App() {
  const [session, setSession] = useState(getSession);
  const [prompt, setPrompt] = useState("");
  const [toolsOpen, setToolsOpen] = useState(
    () => window.matchMedia("(min-width: 1100px)").matches
  );
  const endRef = useRef<HTMLDivElement>(null);
  const {
    status,
    messages,
    live,
    running,
    tools: running_,
    catalog,
    queued,
    retry,
    error,
    submit: submitPrompt,
    abort
  } = usePiSession(session);
  const runningTools = running_.map((tool) => tool.name);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, live, running]);

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
        toolsOpen
          ? "lg:grid-cols-[minmax(520px,1fr)_minmax(300px,24vw)]"
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
                aria-label="Tools"
                aria-expanded={toolsOpen}
                onClick={() => setToolsOpen((open) => !open)}
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
            {empty ? (
              <div className="py-12 sm:py-20 text-center">
                <div className="mx-auto mb-6 flex size-16 items-center justify-center rounded-2xl otto-hero-mark">
                  <InfinityIcon size={38} weight="bold" />
                </div>
                <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-kumo-strong">
                  Otto
                </h2>
                <p className="mx-auto mt-2 max-w-md text-sm text-kumo-subtle leading-relaxed">
                  Autonomous engineering assistant for workspace execution, git workflows, and testing.
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
                  <div className="flex items-center gap-2.5 text-sm text-kumo-subtle">
                    <GearIcon size={15} className="animate-spin text-kumo-brand" />
                    {retry
                      ? `Retrying: ${retry.error}`
                      : runningTools.length > 0
                        ? `Running ${runningTools.join(", ")}`
                        : "Waiting for the model..."}
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

      {toolsOpen ? (
        <Sidebar
          tools={catalog}
          activeTools={runningTools}
          onClose={() => setToolsOpen(false)}
        />
      ) : null}
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<App />);
