import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type { ResearchAgent } from "./server";
import type {
  Report,
  ReportListItem,
  ResearchJob,
  ResearchState,
  SourceKind
} from "./shared";
import { SOURCE_LABELS } from "./shared";
import {
  Badge,
  Button,
  Empty,
  InputArea,
  PoweredByCloudflare,
  Surface,
  Switch,
  Text
} from "@cloudflare/kumo";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  GearIcon,
  CircleIcon,
  MoonIcon,
  SunIcon,
  XCircleIcon,
  BugIcon,
  XIcon,
  MagnifyingGlassIcon,
  BooksIcon,
  BrainIcon,
  FileTextIcon,
  CheckCircleIcon,
  SidebarSimpleIcon,
  GraduationCapIcon,
  GithubLogoIcon,
  GlobeIcon,
  BookOpenTextIcon
} from "@phosphor-icons/react";

type Memory = { id: string; fact: string; created_at: number };
type SourceStatus = Record<SourceKind, boolean>;

const SOURCE_ORDER: SourceKind[] = ["wikipedia", "paper", "github", "web"];

function SourceIcon({ kind, size = 14 }: { kind: SourceKind; size?: number }) {
  const className = "shrink-0 text-kumo-subtle";
  if (kind === "paper")
    return <GraduationCapIcon size={size} className={className} />;
  if (kind === "github")
    return <GithubLogoIcon size={size} className={className} />;
  if (kind === "web") return <GlobeIcon size={size} className={className} />;
  return <BookOpenTextIcon size={size} className={className} />;
}

// Each browser gets its own agent instance, and with it its own chat history,
// reports, and memories. The ID is kept so a reload returns to the same agent.
function getSessionId(): string {
  const key = "research-session-id";
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(key, id);
    return id;
  } catch {
    return "default";
  }
}

// ── Small components ──────────────────────────────────────────────────

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );

  const toggle = useCallback(() => {
    const next = !dark;
    setDark(next);
    const mode = next ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [dark]);

  return (
    <Button
      variant="secondary"
      shape="square"
      icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      onClick={toggle}
      aria-label="Toggle theme"
    />
  );
}

const TOOL_LABELS: Record<string, string> = {
  startResearch: "Starting research",
  searchReports: "Searching saved reports",
  getReport: "Reading a saved report",
  rememberFact: "Saving to memory"
};

function ToolIO({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null) return null;
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return null;
  return (
    <div className="mt-1">
      <Text size="xs" variant="secondary" bold>
        {label}
      </Text>
      <pre className="mt-0.5 font-mono text-xs text-kumo-subtle whitespace-pre-wrap overflow-auto max-h-48">
        {text}
      </pre>
    </div>
  );
}

function ToolPartView({
  part,
  showDebug
}: {
  part: UIMessage["parts"][number];
  showDebug: boolean;
}) {
  if (!isToolUIPart(part)) return null;
  const toolName = getToolName(part);
  const label = TOOL_LABELS[toolName] ?? toolName;

  if (part.state === "output-error") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring-2 ring-kumo-danger">
          <div className="flex items-center gap-2 mb-1">
            <XCircleIcon size={14} className="text-kumo-danger" />
            <Text size="xs" variant="secondary" bold>
              {label}
            </Text>
            <Badge variant="destructive">Error</Badge>
          </div>
          <Text size="xs" variant="secondary">
            {part.errorText || "Tool call failed"}
          </Text>
        </Surface>
      </div>
    );
  }

  const done = part.state === "output-available";
  return (
    <div className="flex justify-start">
      <Surface className="max-w-[85%] px-3 py-2 rounded-xl ring ring-kumo-line">
        <div className="flex items-center gap-2">
          {done ? (
            <CheckCircleIcon size={14} className="text-kumo-success" />
          ) : (
            <GearIcon size={14} className="text-kumo-inactive animate-spin" />
          )}
          <Text size="xs" variant="secondary">
            {label}
            {done ? "" : "..."}
          </Text>
        </div>
        {showDebug && (
          <>
            <ToolIO label="Input" value={part.input} />
            {done && <ToolIO label="Output" value={part.output} />}
          </>
        )}
      </Surface>
    </div>
  );
}

// ── Research sidebar ──────────────────────────────────────────────────

function JobCard({
  job,
  onOpen
}: {
  job: ResearchJob;
  onOpen: (id: string) => void;
}) {
  const pct = Math.round(job.percent * 100);
  return (
    <div className="p-3 rounded-lg border border-kumo-line bg-kumo-base space-y-2">
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-kumo-default leading-snug">
          {job.topic}
        </span>
        {job.status === "running" && <Badge variant="secondary">{pct}%</Badge>}
        {job.status === "complete" && <Badge variant="primary">Done</Badge>}
        {job.status === "errored" && (
          <Badge variant="destructive">Failed</Badge>
        )}
      </div>
      {job.status === "running" && (
        <div className="h-1.5 rounded-full bg-kumo-control overflow-hidden">
          <div
            className="h-full bg-kumo-brand transition-all duration-500"
            style={{ width: `${Math.max(pct, 3)}%` }}
          />
        </div>
      )}
      <Text size="xs" variant="secondary">
        {job.status === "errored" ? job.error || job.message : job.message}
      </Text>
      {job.status === "complete" && job.reportId && (
        <Button
          size="sm"
          variant="outline"
          icon={<FileTextIcon size={14} />}
          onClick={() => onOpen(job.reportId as string)}
        >
          Open report
        </Button>
      )}
    </div>
  );
}

function Sidebar({
  jobs,
  reports,
  memories,
  onResearch,
  onOpenReport,
  onDeleteReport,
  onForget,
  connected,
  sources
}: {
  jobs: ResearchJob[];
  reports: ReportListItem[];
  memories: Memory[];
  onResearch: (topic: string) => Promise<void>;
  onOpenReport: (id: string) => void;
  onDeleteReport: (id: string) => void;
  onForget: (id: string) => void;
  connected: boolean;
  sources: SourceStatus | null;
}) {
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const activeJobs = jobs.filter((j) => j.status !== "complete");

  return (
    <aside className="w-full h-full overflow-y-auto bg-kumo-base border-l border-kumo-line p-4 space-y-6">
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <MagnifyingGlassIcon size={16} className="text-kumo-brand" />
          <Text size="sm" bold>
            New research
          </Text>
        </div>
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (topic.trim().length < 2) return;
            setBusy(true);
            try {
              await onResearch(topic.trim());
              setTopic("");
            } finally {
              setBusy(false);
            }
          }}
        >
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            aria-label="Research topic"
            placeholder="e.g. History of the transistor"
            className="flex-1 min-w-0 px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-ring"
          />
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={!connected || busy || topic.trim().length < 2}
          >
            Go
          </Button>
        </form>
        {sources && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {SOURCE_ORDER.map((kind) => (
              <span
                key={kind}
                title={
                  sources[kind]
                    ? `${SOURCE_LABELS[kind]}: on`
                    : `${SOURCE_LABELS[kind]}: off (set TAVILY_API_KEY to enable)`
                }
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
                  sources[kind]
                    ? "border-kumo-line text-kumo-default"
                    : "border-dashed border-kumo-line text-kumo-inactive line-through"
                }`}
              >
                <SourceIcon kind={kind} size={11} />
                {SOURCE_LABELS[kind]}
              </span>
            ))}
          </div>
        )}
      </section>

      {activeJobs.length > 0 && (
        <section className="space-y-2">
          <Text size="sm" bold>
            Research jobs
          </Text>
          {activeJobs.map((job) => (
            <JobCard key={job.id} job={job} onOpen={onOpenReport} />
          ))}
        </section>
      )}

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <BooksIcon size={16} className="text-kumo-brand" />
          <Text size="sm" bold>
            Saved reports
          </Text>
          {reports.length > 0 && (
            <Badge variant="secondary">{reports.length}</Badge>
          )}
        </div>
        {reports.length === 0 ? (
          <Text size="xs" variant="secondary">
            Reports you research are saved here and remembered in chat.
          </Text>
        ) : (
          reports.map((r) => (
            <div
              key={r.id}
              className="group p-3 rounded-lg border border-kumo-line hover:border-kumo-brand transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <button
                  type="button"
                  onClick={() => onOpenReport(r.id)}
                  className="text-left text-sm font-medium text-kumo-default hover:underline"
                >
                  {r.topic}
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  shape="square"
                  aria-label={`Delete report ${r.topic}`}
                  icon={<TrashIcon size={12} />}
                  onClick={() => onDeleteReport(r.id)}
                />
              </div>
              <p className="mt-1 text-xs text-kumo-subtle line-clamp-3">
                {r.summary}
              </p>
            </div>
          ))
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <BrainIcon size={16} className="text-kumo-brand" />
          <Text size="sm" bold>
            What I remember about you
          </Text>
        </div>
        {memories.length === 0 ? (
          <Text size="xs" variant="secondary">
            Tell me about your interests and I'll remember them.
          </Text>
        ) : (
          <ul className="space-y-1">
            {memories.map((m) => (
              <li
                key={m.id}
                className="flex items-start justify-between gap-2 text-xs text-kumo-default"
              >
                <span>• {m.fact}</span>
                <button
                  type="button"
                  aria-label="Forget this"
                  onClick={() => onForget(m.id)}
                  className="text-kumo-inactive hover:text-kumo-danger shrink-0"
                >
                  <XIcon size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}

function ReportViewer({
  report,
  onClose
}: {
  report: Report;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <Surface className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-xl ring ring-kumo-line shadow-xl">
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-kumo-line">
          <div>
            <Text variant="heading3" as="h2">
              {report.topic}
            </Text>
            <Text size="xs" variant="secondary">
              {new Date(report.createdAt).toLocaleString()} ·{" "}
              {report.sources.length} sources
            </Text>
          </div>
          <Button
            variant="ghost"
            shape="square"
            aria-label="Close report"
            icon={<XIcon size={16} />}
            onClick={onClose}
          />
        </div>
        <div className="overflow-y-auto px-5 py-4">
          <Streamdown className="sd-theme" plugins={{ code }} controls={false}>
            {report.report}
          </Streamdown>
          <h2 className="mt-6 mb-2 text-base font-semibold text-kumo-default">
            Sources
          </h2>
          <ol className="space-y-3 list-decimal pl-5">
            {report.sources.map((s) => (
              <li key={s.url} className="text-sm text-kumo-default">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <SourceIcon kind={s.kind ?? "wikipedia"} />
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-kumo-brand hover:underline"
                  >
                    {s.title}
                  </a>
                  <span className="text-xs text-kumo-subtle">
                    {SOURCE_LABELS[s.kind ?? "wikipedia"]}
                    {s.meta ? ` · ${s.meta}` : ""}
                  </span>
                </div>
                <details className="mt-1">
                  <summary className="text-xs text-kumo-subtle cursor-pointer">
                    Notes taken from this source
                  </summary>
                  <pre className="mt-1 text-xs text-kumo-subtle whitespace-pre-wrap font-sans">
                    {s.notes}
                  </pre>
                </details>
              </li>
            ))}
          </ol>
        </div>
      </Surface>
    </div>
  );
}

// ── Main app ──────────────────────────────────────────────────────────

const SUGGESTIONS = [
  "Research the history of the James Webb Space Telescope",
  "I'm a biology student interested in CRISPR",
  "What have I researched so far?",
  "Research how lithium-ion batteries work"
];

function Chat() {
  const [sessionId] = useState(getSessionId);
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const [showSidebar, setShowSidebar] = useState(
    () => window.matchMedia("(min-width: 1024px)").matches
  );
  const [jobs, setJobs] = useState<ResearchJob[]>([]);
  const [reports, setReports] = useState<ReportListItem[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [openReport, setOpenReport] = useState<Report | null>(null);
  const [sources, setSources] = useState<SourceStatus | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const agent = useAgent<ResearchAgent, ResearchState>({
    agent: "ResearchAgent",
    name: sessionId,
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onStateUpdate: useCallback(
      (state: ResearchState) => setJobs(state.jobs),
      []
    )
  });

  const refreshMemory = useCallback(async () => {
    try {
      const [r, m, s] = await Promise.all([
        agent.stub.listReports(),
        agent.stub.listMemories(),
        agent.stub.sourceStatus()
      ]);
      setReports(r);
      setMemories(m);
      setSources(s);
    } catch (e) {
      console.error("Failed to load memory:", e);
    }
  }, [agent]);

  const { messages, sendMessage, clearHistory, stop, status } = useAgentChat({
    agent,
    experimental_throttle: 100
  });

  const isStreaming = status === "streaming" || status === "submitted";

  // Reload reports and memories on connect, when a job finishes, and after
  // each chat turn (the model may have saved a new memory).
  const finishedCount = jobs.filter((j) => j.status === "complete").length;
  useEffect(() => {
    if (connected && !isStreaming) void refreshMemory();
  }, [connected, isStreaming, finishedCount, refreshMemory]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!isStreaming && textareaRef.current) textareaRef.current.focus();
  }, [isStreaming]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;
      sendMessage({ role: "user", parts: [{ type: "text", text: trimmed }] });
    },
    [isStreaming, sendMessage]
  );

  const openReportById = useCallback(
    async (id: string) => {
      const report = await agent.stub.getReport(id);
      if (report) setOpenReport(report);
    },
    [agent]
  );

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      <header className="px-5 py-3 bg-kumo-base border-b border-kumo-line">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <h1 className="text-lg font-semibold text-kumo-default truncate">
              <span className="mr-2">🔎</span>Research Assistant
            </h1>
            <Badge variant="secondary" className="hidden sm:inline-flex">
              Llama 3.3 · Workers AI
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden sm:flex items-center gap-1.5">
              <CircleIcon
                size={8}
                weight="fill"
                className={connected ? "text-kumo-success" : "text-kumo-danger"}
              />
              <Text size="xs" variant="secondary">
                {connected ? "Connected" : "Disconnected"}
              </Text>
            </div>
            <div className="flex items-center gap-1.5">
              <BugIcon size={14} className="text-kumo-inactive" />
              <Switch
                checked={showDebug}
                onCheckedChange={setShowDebug}
                size="sm"
                aria-label="Show tool details"
              />
            </div>
            <ThemeToggle />
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={clearHistory}
              aria-label="Clear chat"
            >
              <span className="hidden sm:inline">Clear chat</span>
            </Button>
            <Button
              variant="secondary"
              shape="square"
              icon={<SidebarSimpleIcon size={16} />}
              onClick={() => setShowSidebar((s) => !s)}
              aria-label="Toggle research panel"
            />
          </div>
        </div>
      </header>

      <div className="flex-1 flex min-h-0 relative">
        <main className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto px-5 py-6 space-y-4">
              {messages.length === 0 && (
                <Empty
                  icon={<MagnifyingGlassIcon size={32} />}
                  title="What should we research?"
                  contents={
                    <div className="space-y-3">
                      <Text size="sm" variant="secondary">
                        Ask me to research a topic. In the background I search
                        Wikipedia, research papers, open-source repos, and the
                        web, read the best sources, and write a cited report,
                        then remember it so you can ask follow-up questions
                        later.
                      </Text>
                      <div className="flex flex-wrap justify-center gap-2">
                        {SUGGESTIONS.map((prompt) => (
                          <Button
                            key={prompt}
                            variant="outline"
                            size="sm"
                            disabled={isStreaming || !connected}
                            onClick={() => send(prompt)}
                          >
                            {prompt}
                          </Button>
                        ))}
                      </div>
                    </div>
                  }
                />
              )}

              {messages.map((message: UIMessage, index: number) => {
                const isUser = message.role === "user";
                const isLastAssistant =
                  message.role === "assistant" && index === messages.length - 1;

                return (
                  <div key={message.id} className="space-y-2">
                    {showDebug && (
                      <pre className="text-[11px] text-kumo-subtle bg-kumo-control rounded-lg p-3 overflow-auto max-h-64">
                        {JSON.stringify(message, null, 2)}
                      </pre>
                    )}
                    {message.parts.map((part, i) => {
                      const key = `${message.id}-${i}`;

                      if (isToolUIPart(part)) {
                        return (
                          <ToolPartView
                            key={key}
                            part={part}
                            showDebug={showDebug}
                          />
                        );
                      }

                      if (part.type === "text") {
                        if (!part.text) return null;
                        if (isUser) {
                          return (
                            <div key={key} className="flex justify-end">
                              <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed whitespace-pre-wrap">
                                {part.text}
                              </div>
                            </div>
                          );
                        }
                        return (
                          <div key={key} className="flex justify-start">
                            <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                              <Streamdown
                                className="sd-theme rounded-2xl rounded-bl-md p-3"
                                plugins={{ code }}
                                controls={false}
                                isAnimating={isLastAssistant && isStreaming}
                              >
                                {part.text}
                              </Streamdown>
                            </div>
                          </div>
                        );
                      }
                      return null;
                    })}
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
          </div>

          <div className="border-t border-kumo-line bg-kumo-base">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
                setInput("");
                if (textareaRef.current)
                  textareaRef.current.style.height = "auto";
              }}
              className="max-w-3xl mx-auto px-5 py-4"
            >
              <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
                <InputArea
                  ref={textareaRef}
                  value={input}
                  onValueChange={setInput}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send(input);
                      setInput("");
                    }
                  }}
                  onInput={(e) => {
                    const el = e.currentTarget;
                    el.style.height = "auto";
                    el.style.height = `${el.scrollHeight}px`;
                  }}
                  placeholder="Ask a question or say “research …”"
                  disabled={!connected || isStreaming}
                  rows={1}
                  className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none! resize-none max-h-40"
                />
                {isStreaming ? (
                  <Button
                    type="button"
                    variant="secondary"
                    shape="square"
                    aria-label="Stop generation"
                    icon={<StopIcon size={18} />}
                    onClick={stop}
                    className="mb-0.5"
                  />
                ) : (
                  <Button
                    type="submit"
                    variant="primary"
                    shape="square"
                    aria-label="Send message"
                    disabled={!input.trim() || !connected}
                    icon={<PaperPlaneRightIcon size={18} />}
                    className="mb-0.5"
                  />
                )}
              </div>
            </form>
            <div className="flex justify-center pb-3">
              <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
            </div>
          </div>
        </main>

        {showSidebar && (
          <div className="absolute inset-y-0 right-0 z-40 w-[min(22rem,100%)] shadow-xl lg:static lg:shadow-none lg:w-80 shrink-0">
            <Sidebar
              jobs={jobs}
              reports={reports}
              memories={memories}
              connected={connected}
              sources={sources}
              onResearch={async (topic) => {
                await agent.stub.research(topic);
              }}
              onOpenReport={openReportById}
              onDeleteReport={async (id) => {
                await agent.stub.deleteReport(id);
                await refreshMemory();
              }}
              onForget={async (id) => {
                await agent.stub.forgetMemory(id);
                await refreshMemory();
              }}
            />
          </div>
        )}
      </div>

      {openReport && (
        <ReportViewer report={openReport} onClose={() => setOpenReport(null)} />
      )}
    </div>
  );
}

export default function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen text-kumo-inactive">
          Loading...
        </div>
      }
    >
      <Chat />
    </Suspense>
  );
}
