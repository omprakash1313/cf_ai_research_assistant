import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import { generateText } from "ai";
import { workersAI } from "./ai";
import type { ResearchAgent } from "./server";
import {
  MODEL,
  SOURCE_LABELS,
  type ResearchProgress,
  type Source,
  type SourceKind
} from "./shared";
import {
  dedupe,
  gatherGitHub,
  gatherPapers,
  gatherWeb,
  gatherWikipedia,
  readCandidate,
  type Candidate,
  type SourceKeys
} from "./sources";

export type ResearchParams = { topic: string };

/** Sources per report: up to 2 from each kind, with Wikipedia filling gaps. */
const PER_KIND = 2;
const MAX_SOURCES = 8;

const STEP_RETRIES = {
  // Generous backoff: Wikipedia answers bursts with HTTP 429.
  retries: { limit: 4, delay: "10 seconds", backoff: "exponential" },
  timeout: "2 minutes"
} as const;

// Gathering is best-effort: a source that keeps failing is skipped, not fatal.
const GATHER_RETRIES = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
  timeout: "1 minute"
} as const;

/**
 * Multi-step research pipeline. Each step.do() result is checkpointed, so a
 * failure or restart resumes from the last finished step instead of redoing
 * every LLM call and fetch.
 */
export class ResearchWorkflow extends AgentWorkflow<
  ResearchAgent,
  ResearchParams,
  ResearchProgress
> {
  async run(
    event: AgentWorkflowEvent<ResearchParams>,
    step: AgentWorkflowStep
  ) {
    const { topic } = event.payload;
    const keys = this.env as Env & SourceKeys;

    try {
      await this.progress("plan", "Planning search queries", 0.05);
      const queries = await step.do("plan-queries", STEP_RETRIES, () =>
        this.planQueries(topic)
      );

      await this.progress(
        "search",
        "Searching Wikipedia, research papers, GitHub, and the web",
        0.12
      );
      // Independent sources run in parallel; each is its own durable step.
      const gather = async (
        kind: SourceKind,
        fn: () => Promise<Candidate[]>
      ): Promise<Candidate[]> => {
        try {
          return await step.do(`gather-${kind}`, GATHER_RETRIES, fn);
        } catch (error) {
          console.warn(`Skipping ${kind} sources:`, error);
          return [];
        }
      };
      const [wiki, papers, repos, web] = await Promise.all([
        gather("wikipedia", () => gatherWikipedia(queries, 4)),
        gather("paper", () => gatherPapers(topic, PER_KIND)),
        gather("github", () =>
          gatherGitHub(topic, PER_KIND, keys.GITHUB_TOKEN)
        ),
        keys.TAVILY_API_KEY
          ? gather("web", () =>
              gatherWeb(topic, PER_KIND, keys.TAVILY_API_KEY as string)
            )
          : Promise.resolve([])
      ]);

      // Wikipedia fills whatever slots the other sources left empty.
      const others = [...papers, ...repos, ...web];
      const wikiSlots = Math.max(PER_KIND, MAX_SOURCES - others.length);
      const candidates = [...wiki.slice(0, wikiSlots), ...others];
      if (candidates.length === 0) {
        throw new Error(`No sources found for "${topic}"`);
      }

      let read = 0;
      await this.progress(
        "read",
        `Reading ${candidates.length} sources (${describeMix(candidates)})`,
        0.2
      );
      const results = await Promise.all(
        candidates.map(async (c, i) => {
          const source = await step.do(
            `read-${i}-${c.kind}-${c.title.slice(0, 60)}`,
            STEP_RETRIES,
            () => this.readSource(topic, c)
          );
          read++;
          await this.progress(
            "read",
            `Read ${read}/${candidates.length}: ${c.title}`,
            0.2 + (0.6 * read) / candidates.length
          );
          return source;
        })
      );
      const sources = results.filter((s): s is Source => s !== null);
      if (sources.length === 0) {
        throw new Error("None of the sources could be read");
      }

      await this.progress("write", "Writing the report", 0.85);
      const { summary, report } = await step.do(
        "write-report",
        STEP_RETRIES,
        () => this.writeReport(topic, sources)
      );

      const reportId = await step.do("save-report", async () =>
        this.agent.saveReport({ topic, summary, report, sources })
      );

      await step.reportComplete({ reportId });
      return { reportId };
    } catch (error) {
      await step.reportError(
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  // Non-durable progress: may repeat on retry, which is harmless for a UI bar.
  private progress(step: string, message: string, percent: number) {
    return this.reportProgress({ step, message, percent });
  }

  private llm(system: string, prompt: string, maxOutputTokens = 1024) {
    const workersai = workersAI(this.env.AI);
    return generateText({
      model: workersai(MODEL),
      system,
      prompt,
      maxOutputTokens
    }).then((r) => r.text.trim());
  }

  private async planQueries(topic: string): Promise<string[]> {
    const text = await this.llm(
      "You plan encyclopedia searches. Reply with ONLY a JSON array of strings, no prose.",
      `Give 3 short, distinct Wikipedia search queries that together cover the topic: "${topic}".`,
      200
    );
    const parsed = parseStringArray(text);
    // Always include the raw topic so a bad plan still finds something.
    return dedupe([topic, ...parsed]).slice(0, 4);
  }

  private async readSource(
    topic: string,
    c: Candidate
  ): Promise<Source | null> {
    const text = await readCandidate(c);
    if (!text) return null;

    const notes = await this.llm(
      "You are a meticulous research assistant. Extract only facts stated in the source text. Do not invent anything.",
      `Research topic: "${topic}"\n\n` +
        `Source: ${describeSource(c)}\n\n${text}\n\n` +
        READ_INSTRUCTIONS[c.kind],
      700
    );
    return {
      kind: c.kind,
      title: c.title,
      url: c.url,
      meta: c.meta,
      notes
    };
  }

  private async writeReport(topic: string, sources: Source[]) {
    const notes = sources
      .map(
        (s, i) =>
          `[${i + 1}] ${SOURCE_LABELS[s.kind ?? "wikipedia"]}: ${s.title}` +
          `${s.meta ? ` (${s.meta})` : ""}\n${s.notes}`
      )
      .join("\n\n");
    const kinds = new Set(sources.map((s) => s.kind));
    const sections = [
      "'## Overview'",
      "'## Key findings' (bullets)",
      kinds.has("paper") &&
        "'## What the research says' (findings from the research papers)",
      kinds.has("github") &&
        "'## Open-source projects' (what each repository does and how it relates to the topic)",
      "'## Details'",
      "'## Open questions'"
    ].filter(Boolean);

    const report = await this.llm(
      "You write clear, well-structured research briefs in Markdown. Use only the provided notes and cite them inline as [1], [2], etc.",
      `Topic: "${topic}"\n\nResearch notes:\n${notes}\n\n` +
        `Write a research brief with these sections: ${sections.join(", ")}. ` +
        "Keep it under 800 words. Do not add a sources list; it is appended automatically.",
      2000
    );
    const summary = await this.llm(
      "You summarize documents in one or two plain sentences with no preamble.",
      `Summarize this research brief in at most two sentences:\n\n${report}`,
      150
    );
    return { summary, report };
  }
}

const READ_INSTRUCTIONS: Record<SourceKind, string> = {
  wikipedia:
    "Write 5-8 concise bullet points with the facts from this source that are most relevant to the research topic.",
  paper:
    "This is a research paper abstract. Write 3-6 concise bullet points covering the research question, method, and main findings as they relate to the research topic.",
  github:
    "This is an open-source project's README. Write 3-6 concise bullet points: what the project does, how it relates to the research topic, and its notable features. Ignore installation steps.",
  web: "This is a web page. Write 4-7 concise bullet points with the facts most relevant to the research topic. Ignore navigation, ads, and boilerplate."
};

function describeSource(c: Candidate): string {
  const label = SOURCE_LABELS[c.kind];
  return `${label} "${c.title}"${c.meta ? ` (${c.meta})` : ""}`;
}

function describeMix(candidates: Candidate[]): string {
  const counts = new Map<SourceKind, number>();
  for (const c of candidates) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  const names: Record<SourceKind, [string, string]> = {
    wikipedia: ["Wikipedia article", "Wikipedia articles"],
    paper: ["paper", "papers"],
    github: ["repo", "repos"],
    web: ["web page", "web pages"]
  };
  return [...counts]
    .map(([kind, n]) => `${n} ${names[kind][n === 1 ? 0 : 1]}`)
    .join(", ");
}

/** Pull a JSON string array out of model output, tolerating extra prose. */
export function parseStringArray(text: string): string[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const value: unknown = JSON.parse(match[0]);
      if (Array.isArray(value)) {
        return value.filter(
          (v): v is string => typeof v === "string" && v.trim() !== ""
        );
      }
    } catch {
      // Fall through to line parsing.
    }
  }
  return text
    .split("\n")
    .map((line) => line.replace(/^[\s\-*\d.)"]+|["\s,]+$/g, "").trim())
    .filter(Boolean);
}
