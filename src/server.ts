import { callable, routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool,
  type UIMessage
} from "ai";
import { z } from "zod";
import {
  MODEL,
  type Report,
  type ReportListItem,
  type ResearchJob,
  type ResearchProgress,
  type ResearchState,
  type Source,
  type SourceKind
} from "./shared";
import type { SourceKeys } from "./sources";
import { workersAI } from "./ai";

export { ResearchWorkflow } from "./workflow";

const MAX_JOBS_IN_STATE = 20;
// Each job makes ~8 Wikipedia requests; more at once risks HTTP 429.
const MAX_RUNNING_JOBS = 2;

const CHAT_TOOLS = [
  "startResearch",
  "searchReports",
  "getReport",
  "rememberFact"
] as const;
const ONCE_PER_TURN = new Set<string>(["startResearch", "rememberFact"]);
const RESEARCH_INTENT =
  /\b(research|investigate|look (?:in)?to|look up|dig into|find out|deep dive|report on|study)\b/i;

type ReportRow = {
  id: string;
  topic: string;
  summary: string;
  report: string;
  sources: string;
  created_at: number;
};

type MemoryRow = { id: string; fact: string; created_at: number };

/**
 * One instance per browser (the client picks a stable instance name), so each
 * user gets their own chat history, reports, and remembered facts.
 *
 * Memory lives in three places:
 *  - chat history: persisted automatically by AIChatAgent
 *  - reports + facts: this instance's SQLite database (this.sql)
 *  - research progress: agent state, synced live to every open tab
 */
export class ResearchAgent extends AIChatAgent<Env, ResearchState> {
  initialState: ResearchState = { jobs: [] };
  maxPersistedMessages = 200;

  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      summary TEXT NOT NULL,
      report TEXT NOT NULL,
      sources TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      fact TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`;
  }

  // ── Chat ──────────────────────────────────────────────────────────────

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = workersAI(this.env.AI);

    const result = streamText({
      model: workersai(MODEL, { sessionAffinity: this.sessionAffinity }),
      system: this.systemPrompt(),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      tools: {
        startResearch: tool({
          description:
            "Start a background research job on a topic. It searches Wikipedia, research papers (OpenAlex), open-source GitHub repositories, and the web, reads the best sources, and writes a cited report that is saved to memory. Takes about a minute; the user sees live progress.",
          inputSchema: z.object({
            topic: z.string().min(2).describe("The topic to research")
          }),
          execute: async ({ topic }) => {
            // Llama 3.3 sometimes starts research when the user only
            // mentions an interest, so check the request really asks for it.
            if (!RESEARCH_INTENT.test(this.latestUserText())) {
              return {
                status: "not-started",
                note: "The user did not ask for research. Do not start it; offer to research the topic instead."
              };
            }
            const { job, started } = await this.startResearchJob(topic);
            return started
              ? {
                  status: "started",
                  topic: job.topic,
                  note: "Research is running. Do not call startResearch again for this request. Tell the user it has started and they can watch progress in the sidebar."
                }
              : {
                  status: "already-running",
                  topic: job.topic,
                  note: "This research is already in progress. Do not call startResearch again. Tell the user to watch the sidebar."
                };
          }
        }),

        searchReports: tool({
          description:
            "Search saved research reports by keyword. Use this before answering questions about anything the user researched earlier.",
          inputSchema: z.object({
            query: z.string().describe("Keywords to search for")
          }),
          execute: async ({ query }) => {
            const matches = this.searchReports(query);
            return matches.length > 0
              ? matches
              : `No saved reports match "${query}".`;
          }
        }),

        getReport: tool({
          description:
            "Read the full text and sources of a saved report by its ID.",
          inputSchema: z.object({
            id: z.string().describe("The report ID")
          }),
          execute: async ({ id }) =>
            this.getReport(id) ?? `No report with ID ${id}.`
        }),

        rememberFact: tool({
          description:
            "Save a lasting fact about the user (interests, preferences, background) so future conversations can use it. Only call this when the user shares something worth remembering.",
          inputSchema: z.object({
            fact: z.string().describe("The fact, written in the third person")
          }),
          execute: async ({ fact }) =>
            this.rememberFact(fact)
              ? `Remembered: ${fact}`
              : "Already remembered; nothing to do."
        })
      },
      // Llama 3.3 tends to loop on tools instead of answering. Each action
      // tool may run once per turn, and later steps must answer in text.
      prepareStep: ({ steps, stepNumber }) => {
        if (stepNumber >= 3) return { activeTools: [] };
        const used = new Set(
          steps.flatMap((s) => s.toolCalls.map((c) => c.toolName))
        );
        return {
          activeTools: CHAT_TOOLS.filter(
            (name) => !(ONCE_PER_TURN.has(name) && used.has(name))
          )
        };
      },
      stopWhen: stepCountIs(4),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  private systemPrompt() {
    const memories = this.listMemories();
    const reports = this.listReports();
    const running = this.state.jobs.filter((j) => j.status === "running");

    return [
      "You are a friendly research assistant running on Cloudflare.",
      "You can start deep research jobs (which read Wikipedia, research papers, open-source repositories, and web pages), recall past reports, and remember facts about the user.",
      "",
      "Guidelines:",
      "- Only call startResearch when the user explicitly asks you to research, investigate, or look into a topic. Call it once per request. Do not write the report yourself.",
      "- Mentioning an interest is not a request for research: call rememberFact, then offer to research it.",
      "- When the user asks about something they researched before, call searchReports and then getReport, and answer from the report, citing its sources.",
      "- For quick general questions, answer directly and concisely.",
      "- When the user tells you something lasting about themselves, call rememberFact.",
      "- Never invent report IDs, sources, or dates. When citing, use the source titles and URLs exactly as the report gives them.",
      "",
      `Today's date: ${new Date().toISOString().slice(0, 10)}`,
      "",
      "What you remember about the user:",
      memories.length > 0
        ? memories.map((m) => `- ${m.fact}`).join("\n")
        : "- Nothing yet.",
      "",
      "Saved reports (ID: topic):",
      reports.length > 0
        ? reports.map((r) => `- ${r.id}: ${r.topic}`).join("\n")
        : "- None yet.",
      "",
      "Research in progress:",
      running.length > 0
        ? running.map((j) => `- ${j.topic} (${j.message})`).join("\n")
        : "- None."
    ].join("\n");
  }

  // ── Research jobs (Workflow coordination) ─────────────────────────────

  private async startResearchJob(
    topic: string
  ): Promise<{ job: ResearchJob; started: boolean }> {
    // Llama sometimes repeats a tool call within one turn. The state check
    // and setState below run with no await in between, so a repeated call
    // always sees the job the first call added.
    const key = topic.toLowerCase().trim();
    const duplicate = this.state.jobs.find(
      (j) => j.status === "running" && j.topic.toLowerCase().trim() === key
    );
    if (duplicate) return { job: duplicate, started: false };
    const running = this.state.jobs.filter((j) => j.status === "running");
    if (running.length >= MAX_RUNNING_JOBS) {
      throw new Error(
        `Already running ${running.length} research jobs; wait for one to finish.`
      );
    }

    // Pick the ID up front so the job is in state before the first progress
    // callback can arrive from the workflow.
    const job: ResearchJob = {
      id: crypto.randomUUID(),
      topic,
      status: "running",
      step: "queued",
      message: "Starting",
      percent: 0,
      startedAt: Date.now()
    };
    this.setState({
      jobs: [job, ...this.state.jobs].slice(0, MAX_JOBS_IN_STATE)
    });
    await this.runWorkflow(
      "RESEARCH_WORKFLOW",
      { topic },
      { id: job.id, metadata: { topic } }
    );
    return { job, started: true };
  }

  private updateJob(id: string, patch: Partial<ResearchJob>) {
    this.setState({
      jobs: this.state.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j))
    });
  }

  async onWorkflowProgress(
    _workflowName: string,
    instanceId: string,
    progress: unknown
  ) {
    const p = progress as ResearchProgress;
    this.updateJob(instanceId, {
      step: p.step,
      message: p.message,
      percent: p.percent
    });
  }

  async onWorkflowComplete(
    _workflowName: string,
    instanceId: string,
    result?: unknown
  ) {
    const reportId = (result as { reportId?: string } | undefined)?.reportId;
    this.updateJob(instanceId, {
      status: "complete",
      step: "done",
      message: "Report ready",
      percent: 1,
      reportId
    });
    if (reportId) await this.announceReport(reportId);
  }

  async onWorkflowError(
    _workflowName: string,
    instanceId: string,
    error: string
  ) {
    this.updateJob(instanceId, {
      status: "errored",
      step: "error",
      message: "Research failed",
      error
    });
  }

  /** Post a "report ready" note into the chat without starting a model turn. */
  private async announceReport(reportId: string) {
    const report = this.getReport(reportId);
    if (!report) return;
    const stable = await this.waitUntilStable({ timeout: 30_000 });
    if (!stable) return; // The sidebar still shows the finished report.

    const note: UIMessage = {
      id: `report-${reportId}`,
      role: "assistant",
      parts: [
        {
          type: "text",
          text:
            `**Research complete: ${report.topic}**\n\n${report.summary}\n\n` +
            `I read ${describeSources(report.sources)} and saved the full report (open it from the sidebar). Ask me anything about it.`
        }
      ]
    };
    await this.persistMessages([...this.messages, note]);
  }

  // ── Memory (SQLite) ───────────────────────────────────────────────────

  /** Called by ResearchWorkflow over RPC when a report is finished. */
  async saveReport(input: {
    topic: string;
    summary: string;
    report: string;
    sources: Source[];
  }): Promise<string> {
    const id = crypto.randomUUID().slice(0, 8);
    this
      .sql`INSERT INTO reports (id, topic, summary, report, sources, created_at)
      VALUES (${id}, ${input.topic}, ${input.summary}, ${input.report},
              ${JSON.stringify(input.sources)}, ${Date.now()})`;
    return id;
  }

  @callable()
  listReports(): ReportListItem[] {
    return this.sql<ReportRow>`
      SELECT id, topic, summary, created_at FROM reports ORDER BY created_at DESC`.map(
      (r) => ({
        id: r.id,
        topic: r.topic,
        summary: r.summary,
        createdAt: r.created_at
      })
    );
  }

  @callable()
  getReport(id: string): Report | null {
    const [row] = this.sql<ReportRow>`SELECT * FROM reports WHERE id = ${id}`;
    if (!row) return null;
    return {
      id: row.id,
      topic: row.topic,
      summary: row.summary,
      report: row.report,
      sources: JSON.parse(row.sources) as Source[],
      createdAt: row.created_at
    };
  }

  @callable()
  deleteReport(id: string) {
    this.sql`DELETE FROM reports WHERE id = ${id}`;
    this.setState({
      jobs: this.state.jobs.filter((j) => j.reportId !== id)
    });
  }

  @callable()
  async research(topic: string) {
    const trimmed = topic.trim();
    if (trimmed.length < 2) throw new Error("Topic is too short");
    return (await this.startResearchJob(trimmed)).job;
  }

  /** Which research sources are active, for the sidebar. */
  @callable()
  sourceStatus(): Record<SourceKind, boolean> {
    const keys = this.env as Env & SourceKeys;
    return {
      wikipedia: true,
      paper: true,
      github: true,
      web: Boolean(keys.TAVILY_API_KEY)
    };
  }

  @callable()
  listMemories(): MemoryRow[] {
    return this.sql<MemoryRow>`SELECT * FROM memories ORDER BY created_at`;
  }

  @callable()
  forgetMemory(id: string) {
    this.sql`DELETE FROM memories WHERE id = ${id}`;
  }

  private searchReports(query: string): ReportListItem[] {
    const words = query
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2);
    if (words.length === 0) return this.listReports().slice(0, 5);
    const all = this.sql<ReportRow>`SELECT * FROM reports`;
    return all
      .map((r) => {
        const haystack = `${r.topic} ${r.summary} ${r.report}`.toLowerCase();
        const topic = r.topic.toLowerCase();
        const score = words.reduce(
          (s, w) =>
            s + (topic.includes(w) ? 3 : 0) + (haystack.includes(w) ? 1 : 0),
          0
        );
        return { r, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(({ r }) => ({
        id: r.id,
        topic: r.topic,
        summary: r.summary,
        createdAt: r.created_at
      }));
  }

  /** Returns false if an equivalent fact is already stored. */
  private rememberFact(fact: string): boolean {
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, "")
        .trim();
    const key = normalize(fact);
    if (this.listMemories().some((m) => normalize(m.fact) === key)) {
      return false;
    }
    this.sql`INSERT INTO memories (id, fact, created_at)
      VALUES (${crypto.randomUUID()}, ${fact}, ${Date.now()})`;
    return true;
  }

  private latestUserText(): string {
    const last = [...this.messages].reverse().find((m) => m.role === "user");
    return (last?.parts ?? [])
      .map((p) => (p.type === "text" ? p.text : ""))
      .join(" ");
  }
}

function describeSources(sources: Source[]): string {
  const names: Record<SourceKind, [string, string]> = {
    wikipedia: ["Wikipedia article", "Wikipedia articles"],
    paper: ["research paper", "research papers"],
    github: ["open-source repo", "open-source repos"],
    web: ["web page", "web pages"]
  };
  const counts = new Map<SourceKind, number>();
  for (const s of sources) {
    const kind = s.kind ?? "wikipedia";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const parts = [...counts].map(
    ([kind, n]) => `${n} ${names[kind][n === 1 ? 0 : 1]}`
  );
  return parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
    : (parts[0] ?? "0 sources");
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
