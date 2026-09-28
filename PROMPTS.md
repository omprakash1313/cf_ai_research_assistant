# PROMPTS.md

AI-assisted coding was used to build this project. This file records:

1. the prompts used with the AI coding assistant (Claude Code) during development
2. the prompts the app itself sends to Llama 3.3 at runtime

## 1. Development prompts (Claude Code)

The project was built in one session with Claude Code in VS Code. These are the
prompts given to the assistant, in order, with a note on what each produced.

1. **"can you read this link https://developers.cloudflare.com/agents/"**
   The assistant summarized the Cloudflare Agents landing page.

2. **"i want you to go deep into this and we need to complete this assignment
   so you need to get every information"**
   The assistant downloaded the full Agents documentation (`llms-full.txt`,
   110 pages), split it into one file per page for reference, and read the
   core pages: quick start, Agents API, limits, and concepts.

3. **"also scan this also in depth https://agents.cloudflare.com/"**
   The assistant read the marketing site: the 4-step input → LLM → execution
   → tools model and the CPU-time vs wall-time pricing. It also fetched
   Cloudflare's official `agents-sdk` skill and its reference files, which
   list common mistakes (decorators, migrations, routing).

4. **The assignment text**, pasted as given:

   > We plan to fast track candidates who complete an assignment to build a
   > type of AI-powered application on Cloudflare. An AI-powered application
   > should include the following components: LLM (recommend using Llama 3.3
   > on Workers AI), or an external LLM of your choice; Workflow /
   > coordination (recommend using Workflows, Workers or Durable Objects);
   > User input via chat or voice (recommend using Pages or Realtime); Memory
   > or state.

   The assistant asked two clarifying questions:
   - **App idea:** chosen answer "Research assistant"
   - **Follow the `cf_ai_` repo prefix, README.md, and PROMPTS.md
     conventions?** Chosen answer "Yes"

   It then asked how to handle Node.js 20 being too old for the Cloudflare
   tooling. Chosen answer: "Upgrade system Node", so Node 24 LTS was
   installed through winget.

From there the assistant did the following, checking each step against the
downloaded docs and the installed package type definitions:

- scaffolded from `cloudflare/agents-starter`
- designed the Agent + Workflow + SQLite architecture
- wrote `src/shared.ts`, `src/workflow.ts`, `src/server.ts`, and `src/app.tsx`
- configured `wrangler.jsonc` with the Workflow binding and regenerated types
- ran type-check, lint, and build
- checked that the Wikipedia API response shapes match the code
- wrote this README and PROMPTS file

5. **Getting it running.** The user logged in with `npx wrangler login` and
   registered the `workers.dev` subdomain `omprakashkumawat1313`. The
   assistant lowered `compatibility_date` to one the local runtime supports.

6. **End-to-end testing and fixes.** The assistant tested the research
   workflow directly over RPC, then drove the real chat UI in headless Chrome
   (remember a fact → start research → wait for completion → reload → ask a
   follow-up → open the report). Testing turned up these problems, each
   diagnosed and fixed:
   - **Tool calls arrived with empty arguments, and text was doubled.** The
     assistant compared raw Workers AI SSE output with the provider's
     parsing code. The model sends every streamed chunk in both OpenAI-style
     and legacy fields, and `workers-ai-provider` parses both. The fix is a
     wrapper around the `AI` binding (`src/ai.ts`).
   - **The model looped on tool calls without replying.** Fixed with
     `prepareStep`: action tools run once per turn, and there are no tools
     after step 3.
   - **Research started on a mere mention of interest.** Fixed with a
     research-intent check on the latest user message.
   - **Duplicate jobs triggered Wikipedia HTTP 429.** Fixed with topic
     dedupe, a limit of 2 concurrent jobs, and longer exponential backoff.
   - **Duplicate facts were saved.** Fixed with normalized dedupe.
   - **The model invented citation dates.** The system prompt now requires
     citing sources exactly as stored.

7. **"are we getting all the resource and information from wikipedia only?"**
   The assistant confirmed that sources were Wikipedia only and laid out
   options for more sources.

8. **"we can add a part that it will also refer to open source repos, web
   search, research papers"**
   The assistant checked the OpenAlex, GitHub, and Tavily APIs with live
   requests, then added `src/sources.ts` with one adapter per source. It
   rebuilt the workflow to gather from all sources in parallel, each as a
   best-effort durable step, and to read sources in parallel with
   instructions tuned to each source type. It added report sections for
   papers and open-source projects, source-type badges and a source-status
   row in the UI, and optional keys (`TAVILY_API_KEY`, `GITHUB_TOKEN`). It
   verified the result with an RPC run (4 Wikipedia articles, 2 papers,
   2 repos in 41 s) and the browser test.

## 2. Runtime prompts (sent to Llama 3.3 by the app)

Model: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` on Workers AI.

### Chat agent system prompt — `src/server.ts` → `systemPrompt()`

Rebuilt on every turn so the model sees current memory:

```text
You are a friendly research assistant running on Cloudflare.
You can start deep research jobs, recall past reports, and remember facts about the user.

Guidelines:
- Only call startResearch when the user explicitly asks you to research, investigate, or look into a topic. Call it once per request. Do not write the report yourself.
- Mentioning an interest is not a request for research: call rememberFact, then offer to research it.
- When the user asks about something they researched before, call searchReports and then getReport, and answer from the report, citing its sources.
- For quick general questions, answer directly and concisely.
- When the user tells you something lasting about themselves, call rememberFact.
- Never invent report IDs, sources, or dates. When citing, use the source titles and URLs exactly as the report gives them.

Today's date: <YYYY-MM-DD>

What you remember about the user:
- <fact> …

Saved reports (ID: topic):
- <id>: <topic> …

Research in progress:
- <topic> (<current step>) …
```

Tools exposed to the model: `startResearch`, `searchReports`, `getReport`,
`rememberFact`. Their descriptions in `server.ts` also act as prompts.

### Research workflow prompts — `src/workflow.ts`

**Plan queries** (step `plan-queries`)

- System: `You plan encyclopedia searches. Reply with ONLY a JSON array of strings, no prose.`
- User: `Give 3 short, distinct Wikipedia search queries that together cover the topic: "<topic>".`

The output is parsed leniently (`parseStringArray`), and the raw topic is
always added as a fallback query.

**Take notes on one source** (step `read-<n>-<kind>-<title>`)

- System: `You are a meticulous research assistant. Extract only facts stated in the source text. Do not invent anything.`
- User:

  ```text
  Research topic: "<topic>"

  Source: <source type> "<title>" (<metadata>)

  <source text, up to 12,000 characters>

  <source-type instruction>
  ```

  The source line reads like `Research paper "<title>" (2021 · 1,753 citations · Gillmore et al.)`
  or `Open-source repo "<owner/name>" (★ 1,207 · Python)`. The final
  instruction depends on the source type:

  - Wikipedia: `Write 5-8 concise bullet points with the facts from this source that are most relevant to the research topic.`
  - Research paper: `This is a research paper abstract. Write 3-6 concise bullet points covering the research question, method, and main findings as they relate to the research topic.`
  - Open-source repo: `This is an open-source project's README. Write 3-6 concise bullet points: what the project does, how it relates to the research topic, and its notable features. Ignore installation steps.`
  - Web page: `This is a web page. Write 4-7 concise bullet points with the facts most relevant to the research topic. Ignore navigation, ads, and boilerplate.`

**Write the report** (step `write-report`)

- System: `You write clear, well-structured research briefs in Markdown. Use only the provided notes and cite them inline as [1], [2], etc.`
- User:

  ```text
  Topic: "<topic>"

  Research notes:
  [1] <Source type>: <title> (<metadata>)
  <notes>
  …

  Write a research brief with these sections: '## Overview', '## Key findings' (bullets), '## What the research says' (findings from the research papers), '## Open-source projects' (what each repository does and how it relates to the topic), '## Details', '## Open questions'. Keep it under 800 words. Do not add a sources list; it is appended automatically.
  ```

  The papers and open-source sections are included only when the report
  has sources of that type.

**Summarize the report** (same step)

- System: `You summarize documents in one or two plain sentences with no preamble.`
- User: `Summarize this research brief in at most two sentences:\n\n<report>`
