# PROMPTS.md

## AI-Assisted Development Record

This document records the prompts provided to the AI coding assistant during the development of this project, along with the runtime prompts used by the application to interact with **Llama 3.3 70B Instruct** through Cloudflare Workers AI.

The purpose of this document is to provide transparency into the AI-assisted development process, architectural decisions, debugging iterations, and runtime prompt design.

---

# 1. Development Prompts — Claude Code

The application was developed iteratively in a single development session using **Claude Code within VS Code**. The following prompts were used during development.

## 1.1 Cloudflare Agents Documentation

### Prompt

> Can you read this link https://developers.cloudflare.com/agents/

### Outcome

The assistant reviewed the Cloudflare Agents documentation to establish an initial understanding of the platform, its architecture, APIs, and recommended development patterns.

---

## 1.2 Deep Technical Review

### Prompt

> I want you to go deep into this and we need to complete this assignment so you need to get every information.

### Outcome

The assistant performed a deeper review of the Cloudflare Agents documentation, including the full documentation set (`llms-full.txt`).

The documentation was organized into individual reference files and the following areas were studied in detail:

- Cloudflare Agents Quick Start
- Agents API
- Agent concepts and architecture
- Runtime and platform limits
- State and persistence
- Durable Objects
- Workflows
- Deployment considerations

This documentation was subsequently used as the primary technical reference during implementation.

---

## 1.3 Cloudflare Agents Platform Review

### Prompt

> Also scan this also in depth https://agents.cloudflare.com/

### Outcome

The Cloudflare Agents platform and architecture were reviewed in depth.

Particular attention was given to:

- Input → LLM → execution → tools architecture
- Agent orchestration
- Stateful execution
- CPU-time versus wall-time considerations
- Tool invocation patterns
- Durable Objects
- Workflow execution
- Cloudflare Agents SDK conventions

The official Cloudflare Agents SDK guidance was also reviewed to identify common implementation issues, including:

- Agent decorators
- Durable Object migrations
- Routing configuration
- SDK conventions
- Workflow integration patterns

---

# 2. Assignment Requirements

The assignment required an AI-powered application deployed on Cloudflare with the following core components:

- **Large Language Model (LLM)** — preferably Llama 3.3 through Workers AI
- **Workflow / orchestration** — using Workers, Workflows, or Durable Objects
- **User interaction** — through a chat or voice interface
- **Memory / state management**

Two architectural decisions were established before implementation.

### Application Type

**Research Assistant**

The application was designed as an AI-powered research assistant capable of:

- Understanding research requests
- Performing multi-source research
- Persisting research results
- Remembering user-provided facts
- Retrieving previously generated research
- Answering follow-up questions using stored research

### Repository Conventions

The project follows the requested conventions:

- `cf_ai_` repository prefix
- `README.md`
- `PROMPTS.md`
- Cloudflare-native architecture

---

# 3. Development Environment

During development, the Cloudflare tooling required a newer Node.js version than the existing environment.

The development environment was therefore upgraded to **Node.js 24 LTS**.

Cloudflare tooling was then initialized and configured using the supported project scaffolding and SDK versions.

The project was scaffolded from:

```text
cloudflare/agents-starter
```

---

# 4. Application Architecture

The application was designed around four primary layers:

```text
User
  │
  ▼
Chat Interface
  │
  ▼
Cloudflare Agent
  │
  ├── Memory
  ├── Report Retrieval
  ├── Research Tool
  │
  ▼
Research Workflow
  │
  ├── Query Planning
  ├── Wikipedia
  ├── Research Papers
  ├── Open-Source Repositories
  ├── Web Search
  │
  ▼
LLM Analysis
  │
  ▼
Persistent Research Report
```

The major application components were implemented as:

```text
src/
├── ai.ts
├── app.tsx
├── server.ts
├── workflow.ts
├── sources.ts
└── shared.ts
```

The Cloudflare Workflow binding was configured through:

```text
wrangler.jsonc
```

Types were regenerated after binding configuration to ensure the implementation remained consistent with the Cloudflare runtime configuration.

---

# 5. Initial Implementation

The initial implementation established the following capabilities:

### Agent

The Agent provides the conversational interface and determines which application capability should be invoked.

### Workflow

The Workflow provides durable orchestration for long-running research operations.

### Persistent State

SQLite-based persistence was used to retain:

- User facts
- Research reports
- Research metadata
- Research progress

### Chat Interface

A web-based chat interface was implemented to allow users to:

- Ask questions
- Start research
- Retrieve previous research
- Ask follow-up questions
- Store information for future conversations

---

# 6. Validation and Testing

The implementation was validated progressively rather than relying solely on static code inspection.

The following checks were performed:

- Type checking
- Linting
- Production build
- Cloudflare configuration validation
- API response validation
- Direct Workflow/RPC testing
- End-to-end browser testing

The Wikipedia API response structure was also compared against the application's expected data model to ensure reliable parsing.

---

# 7. End-to-End Debugging

After the initial implementation, the complete application was tested through the actual chat interface using a headless Chrome browser.

The test sequence included:

1. Store a user fact.
2. Start a research request.
3. Execute the research workflow.
4. Wait for workflow completion.
5. Reload the application.
6. Retrieve the generated report.
7. Ask a follow-up question.
8. Open and inspect the final research report.

This testing uncovered several runtime issues that were subsequently resolved.

---

## 7.1 Workers AI Streaming Compatibility

### Problem

Tool calls were occasionally received with empty arguments, while streamed assistant text appeared duplicated.

### Investigation

The raw Workers AI Server-Sent Events output was compared with the parsing behavior of the `workers-ai-provider`.

The investigation showed that the model response can expose streamed content through both OpenAI-compatible and legacy response fields, resulting in duplicated processing.

### Resolution

A dedicated Workers AI wrapper was introduced:

```text
src/ai.ts
```

The wrapper normalizes the response before it reaches the application-level model/tool handling.

---

## 7.2 Repeated Tool Invocation

### Problem

The model could repeatedly invoke tools without producing a final response.

### Resolution

The Agent execution loop was constrained using `prepareStep`.

The resulting behavior ensures that:

- Action tools execute once per turn.
- Tool availability is progressively restricted.
- No additional action tools are exposed after the configured execution step.

This prevents uncontrolled tool-call loops.

---

## 7.3 Research Intent Detection

### Problem

The system could start a research workflow when the user merely mentioned an area of interest.

For example, mentioning a topic was incorrectly interpreted as a research request.

### Resolution

Research execution was changed to require explicit research intent in the latest user message.

The system now distinguishes between:

```text
"I am interested in quantum computing."
```

and:

```text
"Research quantum computing for me."
```

The first results in memory being updated and the user being offered the option to research the topic.

The second explicitly starts the research workflow.

---

## 7.4 Duplicate Research Jobs

### Problem

Repeated or overlapping research jobs resulted in excessive requests to external sources and caused HTTP `429 Too Many Requests` responses from Wikipedia.

### Resolution

The research workflow was updated with:

- Topic-level deduplication
- Maximum two concurrent research jobs
- Exponential backoff
- Longer retry intervals
- Duplicate request prevention

---

## 7.5 Duplicate Memory Entries

### Problem

Equivalent user facts could be stored multiple times because of differences in formatting or wording.

### Resolution

Normalized deduplication was introduced before persisting facts.

This ensures semantically equivalent normalized entries are not repeatedly stored.

---

## 7.6 Citation Integrity

### Problem

The LLM occasionally generated citation dates that were not present in the source metadata.

### Resolution

The system prompt was strengthened so that citations must use source information exactly as stored by the application.

The model is explicitly instructed:

```text
Never invent report IDs, sources, or dates.
```

---

# 8. Initial Research Source

The first version of the research system used **Wikipedia as the sole external research source**.

This implementation established the basic research pipeline:

```text
Research Topic
      ↓
Query Planning
      ↓
Wikipedia Search
      ↓
Source Retrieval
      ↓
LLM Note Extraction
      ↓
Report Generation
      ↓
Persistent Report
```

The system was subsequently extended to support multiple source types.

---

# 9. Multi-Source Research Expansion

### Development Prompt

> We can add a part that it will also refer to open source repos, web search, research papers.

### Investigation

Before implementation, the relevant APIs were tested to verify availability and response formats.

The following sources were evaluated:

- OpenAlex — research papers
- GitHub — open-source repositories
- Tavily — web search
- Wikipedia — encyclopedia/reference information

---

# 10. Multi-Source Architecture

The research workflow was redesigned so that independent sources could be queried in parallel.

```text
                    Research Topic
                          │
                          ▼
                    Query Planning
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
        ▼                 ▼                 ▼
    Wikipedia          OpenAlex          GitHub
        │                 │                 │
        │                 ▼                 │
        │          Research Papers          │
        │                                   │
        └─────────────────┬─────────────────┘
                          │
                          ▼
                    Web Search
                       Tavily
                          │
                          ▼
                   Source Analysis
                          │
                          ▼
                    Report Writer
                          │
                          ▼
                  Research Report
```

Each source adapter was implemented in:

```text
src/sources.ts
```

The workflow executes source collection as independent durable steps wherever possible.

Source-specific analysis instructions are then used to extract information appropriate to the type of source.

---

# 11. Source-Specific Processing

Different source types require different extraction strategies.

### Wikipedia

The model is instructed to produce:

- 5–8 concise bullet points
- Relevant factual information
- No unsupported claims

### Research Papers

The model extracts:

- Research question
- Methodology
- Main findings
- Relevance to the research topic

### Open-Source Repositories

The model extracts:

- Project purpose
- Relationship to the research topic
- Important capabilities
- Notable features

Installation instructions and unrelated README content are intentionally ignored.

### Web Pages

The model extracts:

- Relevant factual information
- Important findings
- Topic-specific details

Navigation, advertisements, and boilerplate content are ignored.

---

# 12. Research Report Generation

The report-generation stage combines the structured notes from all available sources.

The generated report contains:

```text
## Overview

## Key findings

## What the research says

## Open-source projects

## Details

## Open questions
```

The sections related to research papers and open-source projects are included only when those source types are available.

The generated report is limited to approximately **800 words** to keep the output concise and useful.

A source list is appended automatically by the application rather than being generated by the model.

---

# 13. Runtime Configuration

Optional external integrations are configured through environment variables.

```text
TAVILY_API_KEY
GITHUB_TOKEN
```

The application is designed so that individual external sources can operate on a best-effort basis without preventing the entire research workflow from completing.

This allows the research assistant to remain functional even when one external source is unavailable.

---

# 14. Runtime LLM

The application uses:

```text
@cf/meta/llama-3.3-70b-instruct-fp8-fast
```

through:

```text
Cloudflare Workers AI
```

The LLM is used for:

- Conversational reasoning
- Tool selection
- Research query planning
- Source analysis
- Research synthesis
- Report generation
- Report summarization

---

# 15. Runtime Prompt — Chat Agent

The chat Agent system prompt is rebuilt on every turn so that the model receives the latest application state, including memory, saved reports, and active research jobs.

### System Prompt

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

### Available Agent Tools

The Agent has access to four application-level tools:

```text
startResearch
searchReports
getReport
rememberFact
```

The tool descriptions additionally provide the model with the constraints and intended usage of each operation.

---

# 16. Runtime Research Prompts

## 16.1 Query Planning

### System

```text
You plan encyclopedia searches. Reply with ONLY a JSON array of strings, no prose.
```

### User

```text
Give 3 short, distinct Wikipedia search queries that together cover the topic: "<topic>".
```

The resulting array is parsed using a tolerant `parseStringArray` implementation.

The original research topic is always retained as a fallback query.

---

## 16.2 Source Analysis

### System

```text
You are a meticulous research assistant. Extract only facts stated in the source text. Do not invent anything.
```

### User

```text
Research topic: "<topic>"

Source: <source type> "<title>" (<metadata>)

<source text, up to 12,000 characters>

<source-specific instruction>
```

The final instruction is dynamically selected based on the source type.

---

## 16.3 Report Generation

### System

```text
You write clear, well-structured research briefs in Markdown. Use only the provided notes and cite them inline as [1], [2], etc.
```

### User

```text
Topic: "<topic>"

Research notes:
[1] <Source type>: <title> (<metadata>)
<notes>
…

Write a research brief with these sections:
'## Overview',
'## Key findings',
'## What the research says',
'## Open-source projects',
'## Details',
'## Open questions'.

Keep it under 800 words.

Do not add a sources list; it is appended automatically.
```

The research-paper and open-source sections are included only when corresponding source material is available.

---

# 17. Report Summarization

### System

```text
You summarize documents in one or two plain sentences with no preamble.
```

### User

```text
Summarize this research brief in at most two sentences:

<report>
```

This stage produces a concise summary suitable for displaying in the application UI and for quickly reviewing previously generated reports.

---

# 18. Validation Results

The final multi-source research implementation was validated through both direct workflow execution and browser-based end-to-end testing.

A representative workflow execution successfully collected:

```text
4 Wikipedia articles
2 research papers
2 open-source repositories
```

The workflow completed in approximately:

```text
41 seconds
```

The resulting report was then validated through the actual chat interface.

---

# 19. Engineering Principles Applied

Throughout development, the implementation followed several principles:

### Reliability

External API failures are handled using retries, backoff, deduplication, and best-effort source execution.

### Source Integrity

The model is explicitly prohibited from fabricating:

- Sources
- URLs
- Dates
- Report IDs
- Unsupported facts

### Durable Execution

Long-running research is delegated to Cloudflare Workflows rather than being performed entirely inside a single conversational request.

### Separation of Responsibilities

The application separates:

```text
Conversation
    ↓
Agent
    ↓
Workflow
    ↓
Source Adapters
    ↓
LLM Analysis
    ↓
Persistent Report
```

### Test-Driven Iteration

Important runtime behaviors were verified through direct execution and end-to-end browser testing rather than relying solely on static implementation checks.

---

# 20. Final Technology Stack

| Component | Technology |
|---|---|
| AI Model | Llama 3.3 70B Instruct |
| AI Runtime | Cloudflare Workers AI |
| Agent Framework | Cloudflare Agents |
| Workflow | Cloudflare Workflows |
| Application Runtime | Cloudflare Workers |
| Frontend | React / TypeScript |
| Persistence | SQLite |
| Encyclopedia Source | Wikipedia |
| Research Papers | OpenAlex |
| Open-Source Repositories | GitHub |
| Web Search | Tavily |
| Development Environment | VS Code + Claude Code |
| Runtime | Node.js 24 LTS |
| Deployment | Cloudflare Workers |

---

# 21. Development Summary

The application evolved from a basic Wikipedia-powered research assistant into a multi-source, stateful research platform.

The final implementation provides:

- Conversational interaction
- Persistent user memory
- Durable research workflows
- Multi-source research
- Research-paper analysis
- Open-source project discovery
- Web search integration
- Source-aware report generation
- Citation integrity controls
- Duplicate prevention
- Retry and backoff handling
- End-to-end validation

The `PROMPTS.md` file therefore serves not only as a record of AI prompts, but also as a traceable development history showing how the application was designed, validated, debugged, and progressively improved.
