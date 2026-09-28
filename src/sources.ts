// Source adapters for the research workflow. Each gatherer turns a topic
// into candidate documents; readCandidate() turns a candidate into source text.

import type { SourceKind } from "./shared";

/** Optional secrets. Set them in .dev.vars locally or with `wrangler secret put`. */
export type SourceKeys = {
  TAVILY_API_KEY?: string;
  GITHUB_TOKEN?: string;
};

/** A document found by a gatherer, before the LLM has read it. */
export type Candidate = {
  kind: SourceKind;
  title: string;
  url: string;
  meta?: string; // e.g. "2021 · 1,753 citations" or "★ 1,207 · Python"
  text?: string; // full text when the search API already returned it
  ref?: string; // what readCandidate() needs to fetch the text
};

const USER_AGENT = "cf-ai-research-assistant/1.0 (Cloudflare Workers demo)";
export const MAX_SOURCE_CHARS = 12_000;

async function getJson<T>(
  url: string | URL,
  init: RequestInit = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("User-Agent", USER_AGENT);
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    throw new Error(`${new URL(url).hostname} returned HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── Wikipedia ─────────────────────────────────────────────────────────

const WIKI_API = "https://en.wikipedia.org/w/api.php";

export async function gatherWikipedia(
  queries: string[],
  limit: number
): Promise<Candidate[]> {
  const perQuery: string[][] = [];
  for (const q of queries) {
    const url = new URL(WIKI_API);
    url.search = new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: q,
      srlimit: "3",
      format: "json",
      formatversion: "2"
    }).toString();
    const data = await getJson<{ query?: { search?: { title: string }[] } }>(
      url
    );
    perQuery.push((data.query?.search ?? []).map((hit) => hit.title));
  }
  // Interleave: every query's best hit, then every second-best, and so on,
  // so one broad query can't crowd out the others.
  const titles: string[] = [];
  const depth = Math.max(0, ...perQuery.map((hits) => hits.length));
  for (let rank = 0; rank < depth; rank++) {
    for (const hits of perQuery) if (hits[rank]) titles.push(hits[rank]);
  }
  return dedupe(titles)
    .slice(0, limit)
    .map((title) => ({
      kind: "wikipedia",
      title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`,
      ref: title
    }));
}

async function readWikipedia(title: string): Promise<string | null> {
  const url = new URL(WIKI_API);
  url.search = new URLSearchParams({
    action: "query",
    prop: "extracts",
    explaintext: "1",
    redirects: "1",
    titles: title,
    format: "json",
    formatversion: "2"
  }).toString();
  const data = await getJson<{
    query?: { pages?: { extract?: string; missing?: boolean }[] };
  }>(url);
  const page = data.query?.pages?.[0];
  return page && !page.missing && page.extract ? page.extract : null;
}

// ── Research papers (OpenAlex) ────────────────────────────────────────

type OpenAlexWork = {
  id: string;
  doi: string | null;
  display_name: string;
  publication_year: number | null;
  cited_by_count: number;
  authorships: { author: { display_name: string } }[];
  abstract_inverted_index: Record<string, number[]> | null;
  primary_location?: { landing_page_url?: string | null } | null;
};

export async function gatherPapers(
  topic: string,
  limit: number
): Promise<Candidate[]> {
  const url = new URL("https://api.openalex.org/works");
  url.search = new URLSearchParams({
    search: topic,
    per_page: "8",
    filter: "has_abstract:true",
    select:
      "id,doi,display_name,publication_year,cited_by_count,authorships,abstract_inverted_index,primary_location"
  }).toString();
  const data = await getJson<{ results: OpenAlexWork[] }>(url);

  // OpenAlex ranks by relevance. Among the top hits, prefer well-cited work.
  return data.results
    .slice(0, Math.max(limit * 2, 4))
    .sort((a, b) => b.cited_by_count - a.cited_by_count)
    .slice(0, limit)
    .map((w) => {
      const authors = w.authorships.map((a) => a.author.display_name);
      const byline =
        authors.length > 2 ? `${authors[0]} et al.` : authors.join(" & ");
      return {
        kind: "paper",
        title: w.display_name,
        url: w.doi ?? w.primary_location?.landing_page_url ?? w.id,
        meta: [
          w.publication_year,
          `${w.cited_by_count.toLocaleString("en-US")} citations`,
          byline
        ]
          .filter(Boolean)
          .join(" · "),
        text: rebuildAbstract(w.abstract_inverted_index)
      } satisfies Candidate;
    })
    .filter((c) => c.text);
}

/** OpenAlex stores abstracts as {word: [positions]}; put the words back in order. */
export function rebuildAbstract(
  index: Record<string, number[]> | null
): string {
  if (!index) return "";
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const p of positions) words[p] = word;
  }
  return words.filter(Boolean).join(" ");
}

// ── Open-source repositories (GitHub) ─────────────────────────────────

type GitHubRepo = {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  language: string | null;
  default_branch: string;
  archived: boolean;
};

export async function gatherGitHub(
  topic: string,
  limit: number,
  token?: string
): Promise<Candidate[]> {
  const url = new URL("https://api.github.com/search/repositories");
  // Best-match ranking, with a small star floor to skip empty/toy repos.
  url.search = new URLSearchParams({
    q: `${topic} stars:>=10`,
    per_page: "6"
  }).toString();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json"
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const data = await getJson<{ items: GitHubRepo[] }>(url, { headers });

  return data.items
    .filter((r) => !r.archived)
    .slice(0, limit)
    .map((r) => ({
      kind: "github",
      title: r.full_name,
      url: r.html_url,
      meta: [`★ ${r.stargazers_count.toLocaleString("en-US")}`, r.language]
        .filter(Boolean)
        .join(" · "),
      // Fallback text if the README can't be fetched.
      text: r.description ?? undefined,
      ref: `${r.full_name}@${r.default_branch}`
    }));
}

async function readGitHubReadme(ref: string): Promise<string | null> {
  // raw.githubusercontent.com doesn't count against the GitHub API rate limit.
  const [fullName, branch] = ref.split("@");
  for (const file of ["README.md", "readme.md", "README.rst", "README"]) {
    const res = await fetch(
      `https://raw.githubusercontent.com/${fullName}/${branch}/${file}`,
      { headers: { "User-Agent": USER_AGENT } }
    );
    if (res.ok) return stripMarkdownNoise(await res.text());
  }
  return null;
}

/** Drop images, badges, and HTML so the model reads prose, not markup. */
function stripMarkdownNoise(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Web search (Tavily) ───────────────────────────────────────────────

export async function gatherWeb(
  topic: string,
  limit: number,
  apiKey: string
): Promise<Candidate[]> {
  const data = await getJson<{
    results: {
      title: string;
      url: string;
      content: string;
      raw_content?: string | null;
    }[];
  }>("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      query: topic,
      max_results: limit + 2,
      search_depth: "basic",
      include_raw_content: true
    })
  });

  // Skip Wikipedia and GitHub results: those sources are covered already.
  return data.results
    .filter((r) => !/wikipedia\.org|github\.com/.test(r.url))
    .slice(0, limit)
    .map((r) => ({
      kind: "web",
      title: r.title,
      url: r.url,
      meta: new URL(r.url).hostname.replace(/^www\./, ""),
      text: (r.raw_content || r.content).slice(0, MAX_SOURCE_CHARS)
    }));
}

// ── Shared ────────────────────────────────────────────────────────────

/** Full text for a candidate, fetched if the gatherer didn't include it. */
export async function readCandidate(c: Candidate): Promise<string | null> {
  let text: string | null | undefined = null;
  if (c.kind === "wikipedia" && c.ref) text = await readWikipedia(c.ref);
  else if (c.kind === "github" && c.ref) text = await readGitHubReadme(c.ref);
  text ||= c.text;
  return text ? text.slice(0, MAX_SOURCE_CHARS) : null;
}

export function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const key = v.toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
