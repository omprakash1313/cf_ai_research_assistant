# PROMPTS.md

# AI-Assisted Development Prompts

This document records the primary prompts used during the development of the project with Claude Code in VS Code.

The prompts are intentionally structured to reflect an engineering workflow: **understanding the platform → analyzing requirements → designing the architecture → implementing features → validating behavior → debugging issues → extending functionality**.

---

## 1. Cloudflare Agents — Initial Documentation Review

### Prompt

> Please review the official Cloudflare Agents documentation at https://developers.cloudflare.com/agents/.
>
> Focus on understanding the core architecture, Agent lifecycle, available APIs, state management, tool execution, and the recommended development patterns.
>
> Summarize the concepts that are most relevant to building an AI-powered application on Cloudflare.

### Objective

Establish a strong technical foundation before beginning implementation and identify the Cloudflare-native capabilities relevant to the assignment.

---

## 2. Deep Technical Analysis of Cloudflare Agents

### Prompt

> I want to use Cloudflare Agents as the foundation for this assignment. Please perform a deep technical analysis of the official documentation and identify everything that is relevant to implementing a production-quality application.
>
> Review the Agents API, architecture, concepts, runtime limitations, state management, Durable Objects, Workflows, deployment requirements, and important implementation considerations.
>
> Use the official documentation as the primary source and highlight any constraints or common implementation mistakes that we should account for during development.

### Objective

Move beyond a high-level understanding and establish the technical constraints and recommended patterns that would guide the implementation.

---

## 3. Cloudflare Agents Platform and SDK Review

### Prompt

> Please also perform a detailed review of https://agents.cloudflare.com/.
>
> Compare the platform concepts presented there with the official developer documentation and identify the architecture and capabilities that are most applicable to our assignment.
>
> In particular, investigate the Agent execution model, LLM interaction, tool execution, workflows, state management, CPU-time versus wall-time considerations, and the Cloudflare Agents SDK.
>
> Also review the official SDK guidance for common implementation mistakes, including decorators, migrations, routing, and Durable Object integration.

### Objective

Validate the proposed architecture against both the platform documentation and SDK implementation guidance.

---

# 4. Assignment Requirements and Architecture Planning

### Prompt

> Here is the assignment specification:
>
> We plan to fast track candidates who complete an assignment to build a type of AI-powered application on Cloudflare. The application should include:
>
> - An LLM, preferably Llama 3.3 through Workers AI, or another external LLM.
> - Workflow or coordination using Workflows, Workers, or Durable Objects.
> - User interaction through chat or voice.
> - Memory or persistent state.
>
> Please analyze these requirements and propose an application architecture that demonstrates all four capabilities clearly.
>
> The application should be practical, technically interesting, and suitable for demonstrating Cloudflare's AI and serverless capabilities.
>
> Before implementation, identify the major components, data flow, storage requirements, external integrations, and deployment considerations.

### Architecture Decision

**Application:** AI Research Assistant

The selected application provides a conversational interface through which users can request research on a topic, retrieve previous research, maintain persistent user facts, and ask follow-up questions.

---

# 5. Repository and Project Conventions

### Prompt

> Please structure the project according to the assignment conventions.
>
> Use the `cf_ai_` repository prefix and maintain both `README.md` and `PROMPTS.md`.
>
> Keep the project structure clean and production-oriented, with clear separation between the Agent, workflow, application UI, shared types, AI integration, and external research sources.
>
> Before creating files, propose the project structure and explain the responsibility of each major component.

### Objective

Establish a maintainable project structure before implementation begins.

---

# 6. Development Environment Compatibility

### Prompt

> Before proceeding with implementation, verify the Node.js and Cloudflare tooling requirements for the selected Agents SDK and project template.
>
> If the current environment does not meet the supported requirements, identify the required version and provide the safest upgrade path.
>
> Avoid introducing compatibility workarounds unless they are necessary.

### Outcome

The development environment was upgraded to Node.js 24 LTS to meet the requirements of the Cloudflare tooling.

---

# 7. Initial Application Implementation

### Prompt

> Implement the research assistant architecture we have defined.
>
> Use the Cloudflare Agents starter project as the foundation and implement the application using TypeScript.
>
> The initial implementation should include:
>
> 1. A conversational Agent.
> 2. A durable research Workflow.
> 3. Persistent state using SQLite.
> 4. A web-based chat interface.
> 5. Agent tools for starting research, retrieving reports, searching previous reports, and remembering user facts.
>
> Keep the implementation modular and strongly typed.
>
> Configure the required Cloudflare bindings and regenerate the appropriate types after configuration changes.
>
> After implementation, run type checking, linting, and a production build and resolve any issues found.

---

# 8. Cloudflare Deployment Configuration

### Prompt

> Configure the project for deployment on Cloudflare Workers.
>
> Verify the Wrangler configuration, Workflow binding, compatibility date, generated types, and required environment configuration.
>
> After configuration, validate that the project can build successfully and that the local runtime is compatible with the configured Cloudflare features.

---

# 9. End-to-End Testing

### Prompt

> Perform a complete end-to-end validation of the research assistant rather than relying only on unit-level or static checks.
>
> Test the following workflow:
>
> 1. Store a persistent user fact.
> 2. Start a research request.
> 3. Execute the research Workflow.
> 4. Wait for the Workflow to complete.
> 5. Reload the application.
> 6. Retrieve the generated report.
> 7. Ask a follow-up question about the previous research.
> 8. Open and validate the generated report.
>
> If any runtime issue occurs, inspect the underlying behavior, identify the root cause, implement the appropriate fix, and repeat the end-to-end test.

---

# 10. Debugging Workers AI Streaming and Tool Calls

### Prompt

> During end-to-end testing, tool calls are arriving with empty arguments and streamed assistant text appears to be duplicated.
>
> Please investigate this at the protocol/provider level rather than applying a superficial workaround.
>
> Compare the raw Workers AI streaming response with the parsing behavior of `workers-ai-provider`.
>
> Determine whether the model response is being exposed through multiple response fields and whether the provider is processing the same content more than once.
>
> Implement a robust normalization layer around the Workers AI binding if required, while preserving compatibility with the existing Agent and tool-calling architecture.
>
> Add validation to confirm that tool arguments and streamed text are processed exactly once.

---

# 11. Preventing Repeated Tool Execution

### Prompt

> The Agent is occasionally entering a tool-call loop and repeatedly invoking research tools without producing a final response.
>
> Analyze the Agent execution lifecycle and identify why the model is being given repeated opportunities to invoke the same tools.
>
> Update the execution strategy using the appropriate `prepareStep` or equivalent mechanism so that:
>
> - Action tools execute only when appropriate.
> - Tool availability is constrained across execution steps.
> - The model is eventually required to produce a final response.
> - The solution does not rely on arbitrary delays or hard-coded response text.
>
> Validate the behavior with an end-to-end test.

---

# 12. Explicit Research Intent

### Prompt

> The current Agent can start a research workflow when a user merely mentions an area of interest.
>
> Update the Agent behavior so that `startResearch` is invoked only when the latest user message contains an explicit request to research, investigate, analyze, study, or look into a topic.
>
> If the user simply mentions an interest or provides information about themselves, store the information using `rememberFact` when appropriate and offer research as an optional next step.
>
> Add representative test cases covering both explicit research requests and simple statements of interest.

---

# 13. Duplicate Research Jobs and Rate Limiting

### Prompt

> End-to-end testing indicates that duplicate research jobs can result in unnecessary external API requests and HTTP 429 responses from Wikipedia.
>
> Please implement a robust solution that includes:
>
> - Topic-level deduplication.
> - A maximum of two concurrent research jobs.
> - Exponential retry backoff.
> - Appropriate handling of HTTP 429 responses.
> - Prevention of duplicate work when the same topic is already being processed.
>
> The solution should remain compatible with Cloudflare Workflows and should not compromise the durability of the research process.

---

# 14. Duplicate Memory Prevention

### Prompt

> The current memory implementation can store duplicate facts when the same information is expressed using slightly different formatting.
>
> Introduce normalized deduplication before persistence.
>
> The implementation should normalize comparable values consistently while preserving the original human-readable fact.
>
> Verify that repeated submissions of equivalent facts do not create unnecessary duplicate records.

---

# 15. Citation Integrity

### Prompt

> The generated research report occasionally contains citation metadata, particularly dates, that is not present in the underlying source data.
>
> Strengthen the report-generation instructions so that the model can only cite information explicitly provided by the research pipeline.
>
> The model must never invent:
>
> - Source titles
> - URLs
> - Publication dates
> - Report IDs
> - Authors
> - Citation counts
>
> When source metadata is available, citations must reproduce it exactly as provided by the application.
>
> Validate the resulting reports against the original source metadata.

---

# 16. Expanding Beyond Wikipedia

### Prompt

> The initial research implementation currently relies on Wikipedia as its primary external source.
>
> Extend the research system so that it can also incorporate:
>
> 1. Research papers.
> 2. Open-source repositories.
> 3. Web search results.
>
> Before implementation, verify the availability and response formats of suitable APIs for each source.
>
> Prefer reliable and well-documented APIs. Evaluate OpenAlex for research papers, GitHub for open-source repositories, and Tavily for web search.
>
> Design the integration so that each source is implemented as an independent adapter and can fail independently without preventing the overall research workflow from completing.

---

# 17. Multi-Source Research Workflow

### Prompt

> Redesign the research Workflow to support multiple independent information sources.
>
> The Workflow should:
>
> 1. Generate research queries.
> 2. Query Wikipedia, OpenAlex, GitHub, and web search where available.
> 3. Execute independent source collection steps in parallel where appropriate.
> 4. Extract structured notes from each source.
> 5. Apply source-specific extraction instructions.
> 6. Combine the resulting notes.
> 7. Generate a consolidated research brief.
>
> Keep the workflow durable and compatible with Cloudflare Workflows.
>
> Avoid making the final report dependent on any single external source.

---

# 18. Source-Specific Analysis

### Prompt

> Implement source-aware analysis instructions so that the LLM processes each source type according to its purpose.
>
> For Wikipedia, extract concise factual information relevant to the research topic.
>
> For research papers, identify the research question, methodology, and principal findings.
>
> For open-source repositories, identify the project's purpose, relevance, and notable capabilities while ignoring installation instructions.
>
> For web pages, extract relevant factual information while ignoring navigation, advertising, and boilerplate content.
>
> Ensure that the analysis stage extracts only information explicitly supported by the provided source text.

---

# 19. Research Report Generation

### Prompt

> Improve the research report-generation stage so that the final output is concise, structured, and suitable for a professional research brief.
>
> The report should contain:
>
> - Overview
> - Key findings
> - What the research says
> - Open-source projects, when applicable
> - Details
> - Open questions
>
> Keep the report below 800 words.
>
> Use only the structured research notes provided to the model.
>
> Add inline citations using the supplied source identifiers.
>
> Do not generate an independent sources list because the application will append the authoritative source metadata automatically.

---

# 20. Runtime Prompt Design

The Agent's runtime system prompt was designed to provide the model with the current application state on every conversational turn.

The prompt includes:

- Current date
- Persistent user facts
- Previously generated research reports
- Active research workflows
- Tool usage rules
- Citation integrity requirements

This ensures that the model operates using the latest application state rather than relying solely on conversational context.

---

# 21. Runtime Model

The application uses:

```text
@cf/meta/llama-3.3-70b-instruct-fp8-fast
```

through Cloudflare Workers AI.

The model is responsible for:

- Natural-language understanding
- Tool selection
- Research query planning
- Source analysis
- Research synthesis
- Report generation
- Report summarization

Long-running research execution itself is delegated to Cloudflare Workflows rather than being performed directly within the conversational model loop.

---

# 22. Runtime Validation

The final multi-source implementation was validated through both direct Workflow execution and browser-based end-to-end testing.

A representative research execution successfully collected:

- 4 Wikipedia articles
- 2 research papers
- 2 open-source repositories

The complete workflow executed in approximately 41 seconds.

The generated research report was subsequently validated through the actual chat interface, including persistence, retrieval, and follow-up questioning.

---

# 23. Final Development Approach

The project followed an iterative engineering process:

```text
Documentation
      ↓
Requirements Analysis
      ↓
Architecture Design
      ↓
Initial Implementation
      ↓
Static Validation
      ↓
End-to-End Testing
      ↓
Runtime Debugging
      ↓
Reliability Improvements
      ↓
Multi-Source Expansion
      ↓
Final Validation
```

The AI coding assistant was used as a development accelerator, while architectural decisions, implementation requirements, validation criteria, and debugging objectives were explicitly defined throughout the development process.
