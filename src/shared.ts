// Types and constants shared by the agent, the workflow, and the React client.

/** Llama 3.3 70B on Workers AI — used for chat, planning, and writing. */
export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export type JobStatus = "running" | "complete" | "errored";

/** A research run, synced to every connected browser through agent state. */
export type ResearchJob = {
  id: string; // workflow instance ID
  topic: string;
  status: JobStatus;
  step: string;
  message: string;
  percent: number; // 0..1
  startedAt: number;
  reportId?: string;
  error?: string;
};

export type ResearchState = {
  jobs: ResearchJob[];
};

export type SourceKind = "wikipedia" | "paper" | "github" | "web";

export const SOURCE_LABELS: Record<SourceKind, string> = {
  wikipedia: "Wikipedia",
  paper: "Research paper",
  github: "Open-source repo",
  web: "Web"
};

export type Source = {
  kind?: SourceKind; // absent on reports saved before multi-source research
  title: string;
  url: string;
  meta?: string;
  notes: string;
};

/** A finished report, stored in the agent's SQLite database. */
export type Report = {
  id: string;
  topic: string;
  summary: string;
  report: string;
  sources: Source[];
  createdAt: number;
};

export type ReportListItem = Pick<
  Report,
  "id" | "topic" | "summary" | "createdAt"
>;

export type ResearchProgress = {
  step: string;
  message: string;
  percent: number;
};
