# Spec: Chat With My Docs (local, single-user)

## Overview

### What we're building

A local web app that lets Dave chat with his Markdown notes through a browser at `localhost`. The agent uses a table-of-contents index of the files plus a `read_file` tool to fetch full content on demand. Everything runs on-device — chat model is Ollama (`qwen2.5:7b`), no cloud calls, no embeddings.

### Target user

- Who: Dave (sole user). Future-Dave may make this multi-user but v1 is single-user.
- Technical level: Advanced — comfortable in the terminal for setup, but wants the running app to be UI-only.
- Context: Day-to-day use on a personal laptop. Notes live in `~/Desktop/BrainDrive Files` and grow over time.

### Problem statement

Dave doesn't want a chatbot that operates blind on his life. He wants an AI that already has the context of his personal notes — past decisions, work-in-progress, references — so when he asks for advice the response is grounded in *his* situation, not generic best-practice. The privacy constraint is load-bearing: that context can only exist if no part of it leaves his machine. The current alternative — pasting selected files into a cloud chat one piece at a time — is laborious, error-prone, and leaks data.

## User Stories

### US-1: Get advice grounded in my own notes

As Dave, I want to ask the AI for advice in a chat window and have it answer with full context from my Markdown notes, so that the response reflects *my* situation — what I've already decided, what I'm working on, what I've referenced — rather than generic best-practice.

**Steps:**
1. Dave opens `http://localhost:<port>` in his browser.
2. The chat UI loads. The index has already been built (or Dave clicks **Re-index** to refresh it).
3. Dave types a question and hits enter.
4. The agent has the TOC (file paths + heading hierarchy of every Markdown file) in its context. It decides whether to call `read_file` on one or more files.
5. Tokens stream into the chat as the model produces them.
6. Dave reads the answer; the conversation scrolls and stays in memory for this session.

**Acceptance Criteria:**

```gherkin
Given the BrainDrive Files folder contains at least one Markdown file
And the file has been indexed
And Ollama is running locally with qwen2.5:7b available
When Dave sends a question that is answerable from a file's content
Then the agent reads the relevant file via the read_file tool
And the answer streams to the UI token-by-token
And the answer reflects the content of the file Dave wrote
```

```gherkin
Given the BrainDrive Files folder is empty
When Dave sends any question
Then the agent answers from the empty index without calling read_file
And the response acknowledges there are no indexed files
```

```gherkin
Given Ollama is NOT running
When Dave sends a message
Then the UI surfaces a clear error ("Ollama not reachable on localhost:11434")
And the app does not crash; Dave can retry after starting Ollama
```

### US-2: Re-index the folder after I add or change notes

As Dave, I want a Re-index button that rescans the folder so that newly added or edited Markdown files become available to the agent without restarting the app.

**Steps:**
1. Dave adds a new `.md` file (or edits an existing one) inside `~/Desktop/BrainDrive Files`.
2. Dave clicks **Re-index** in the UI.
3. The Gateway triggers a re-scan; Memory's index is rebuilt.
4. UI displays the file count after re-index completes.
5. Subsequent questions use the updated index.

**Acceptance Criteria:**

```gherkin
Given a new Markdown file has been added to the folder
When Dave clicks Re-index
Then the index includes the new file's path and heading hierarchy
And the next question can resolve to that file via read_file
```

```gherkin
Given a Markdown file has been deleted from the folder
When Dave clicks Re-index
Then the index no longer references that file
And the agent does not attempt to read_file on the deleted path
```

```gherkin
Given the folder ~/Desktop/BrainDrive Files does not exist
When Dave clicks Re-index
Then the UI surfaces a clear error
And the existing index (if any) is left unchanged
```

## Invariants & Edge Cases

### Properties that must always hold

- **Loopback-only network surface.** The Gateway HTTP listener binds exclusively to `127.0.0.1`. No request from a non-loopback origin is ever accepted.
- **No cloud egress.** The system makes no outbound HTTP calls except to `localhost:11434` (Ollama). The architecture's outbound-guard test must continue to pass for this build.
- **Tool sandbox.** The `read_file` tool only resolves paths whose canonical form is inside `~/Desktop/BrainDrive Files`. Any path that resolves outside (via `..`, symlink, absolute path) is rejected.
- **Index reflects last re-index.** The TOC available to the agent equals the result of the most recent successful re-index. Re-indexing is idempotent — re-running on an unchanged folder produces an identical index.
- **Memory writes route through Auth.** Per PAA architecture, any Memory write (index persistence) carries an Auth-issued approval. v1 auto-approves for the local single-user identity; the gating path still exists.
- **Tool isolation.** Only `read_file` is callable in v1. The Agent Loop never sees other tools.
- **No conversation persistence in v1.** A new chat begins at every app launch. Closing the browser tab and reopening discards the conversation.

### Edge cases to test

- Empty folder (zero `.md` files).
- Folder doesn't exist.
- Non-Markdown files in the folder (silently ignored — only `*.md` is indexed).
- Hidden files (e.g. `.DS_Store`) — ignored.
- Symlinks inside the folder — ignored unless their canonical target is also inside the folder.
- Very long Markdown file (single file > model context window) — tool returns content; if too large, build plan decides truncation or chunking strategy. **[TBD: to be decided during build plan]**
- Total TOC size grows large enough to exceed model context — **[TBD: to be decided during build plan]** (v1 with ~20 short files comfortably fits)
- Unicode / emoji / non-ASCII characters in filenames and content.
- Malformed Markdown (no headings at all → indexed by file path only).
- Concurrent re-index click while a chat is in flight.
- Ollama not running / model not pulled.
- File deleted between `read_file` call and tool execution.

### Failure modes

| Scenario | Expected behavior |
|---|---|
| Ollama not reachable (`localhost:11434` connection refused) | Clear UI error, no crash, chat input remains usable for retry |
| `qwen2.5:7b` model not pulled in Ollama | Clear UI error referencing the model name; suggest `ollama pull qwen2.5:7b` |
| BrainDrive Files folder missing at re-index | UI error; existing index unchanged |
| `read_file` called on a non-existent or out-of-bounds path | Tool returns a structured error; agent surfaces "file not available" without crashing the loop |
| Streaming connection dropped mid-response | UI shows partial response with a clear "disconnected" state; no orphaned server state |
| Model returns malformed tool call JSON | Agent Loop logs, surfaces a graceful error to the chat |
| Re-index runs while chat is mid-stream | Re-index completes; in-flight chat continues using the snapshot it started with |

## Detailed Requirements

### Core functionality

- Index builder: scans `~/Desktop/BrainDrive Files` for `*.md`, parses each file to extract heading hierarchy (`#` through `######`), produces a structured TOC keyed by file path.
- Index persistence: TOC is stored in Memory. Survives process restart. Refreshed only when Dave clicks Re-index.
- Agent Loop: for every chat turn, the TOC is rendered as a system-message preamble. The model has access to the `read_file` tool. Tool calls execute, results are appended to the loop, and the loop continues until the model emits a final assistant message.
- Streaming: assistant tokens are streamed to the browser via SSE.
- Re-index endpoint: triggered by the Re-index button. Synchronous for v1 (~20 small files, fast). UI shows file count on completion.
- Chat is single-rolling, in-memory only for v1. No save/load.

### User interface

- Single page served by the Gateway. Plain, minimal — chat transcript fills the viewport, input box at the bottom, one **Re-index** button (top corner or similar). A small status line shows `<N> files indexed` after a successful index.
- Streaming responses render as they arrive.
- Error states render inline as system messages in the chat (e.g. "Ollama not reachable").
- Framework: **[TBD: to be decided during build plan]** — likely plain HTML+JS or a single-file SPA, no heavy framework.

### Data & state

- Stored (persists across process restart, lives in Memory):
  - The file index / TOC (path → heading hierarchy).
- Temporary (in-process, dies on app shutdown):
  - The current chat conversation.
  - Streaming session state.
- Never stored:
  - Document content itself — `read_file` reads from disk on each tool call (no caching in v1).

## Scope

### Feature type

- [x] Prototype — proving feasibility, skip polish
- [ ] Production — full implementation with error handling

(Production-readiness is a stated future direction; v1 ships as a working prototype.)

### PAA components touched

- [x] Memory — stores the file index (TOC); restored on restart
- [x] Agent Loop — runs the chat, executes `read_file` tool calls
- [x] Auth — present architecturally; trivial single-local-user identity, auto-approves Memory writes in v1
- [x] Gateway — serves the web UI, the SSE chat endpoint, and the re-index endpoint; binds 127.0.0.1 only
- [x] External — Models: Ollama (`qwen2.5:7b`)
- [x] External — Clients: web browser (Dave's, on the same machine)
- [x] External — Tools: `read_file` (filesystem read over `~/Desktop/BrainDrive Files`)

### MVP scope (v1)

**Included:**
- Markdown-only indexing
- TOC + `read_file` retrieval (no embeddings)
- Ollama `qwen2.5:7b` chat model
- Single rolling chat, no persistence across launches
- Re-index button (manual, no folder watcher)
- SSE streaming
- Local web UI (chat-only, localhost-only)

**Out of scope for v1:**
- Cloud models of any kind
- Multi-user / auth login UI
- Editing files inside the app *(deferred to v1.1 — see below)*
- Document upload through the UI
- File types other than Markdown
- Multiple / saved / named conversations
- Citations (which file/section an answer came from)
- Mobile or native desktop packaging
- Folder auto-watch
- Embedding model / vector store
- Chunking strategy for over-large files
- Conversation export / sharing

### Planned for v1.1 (first follow-on)

The first capability Dave plans to add after v1 ships:

- **Document editing via the AI** — let Dave ask the AI to update a doc, with the AI proposing the change and Dave approving it.
  - **Intended shape:** AI proposes a diff (or full new content) → UI shows the proposed change → Dave clicks **Apply** to write to disk. Mirrors the v1 read sandbox: only paths inside `~/Desktop/BrainDrive Files`, only `*.md`.
  - **New decisions to make when v1.1 is scoped:** write semantics (full overwrite vs append vs patch), per-edit approval UX, backup/undo behavior (`.backup` shadow file? in-app history?), concurrent re-index handling, behavior when the file changed on disk between proposal and apply.
  - **Architectural touch points expected:** new tool in the Agent Loop (e.g. `propose_edit(path, new_content)`), a *real* (non-auto) approval flow through Auth, new audit-log lines for proposed-edit and applied-edit events, a small UI surface for diff review.
  - **Why deferred from v1:** materially larger blast radius (the AI can alter the user's own record of past decisions), needs a real approval UX rather than v1's auto-approve, and deserves a few weeks of v1 read-only usage before the edit ergonomics get locked in.

## Technical Context

### Integration points

- Uses the Gateway API external contract (HTTP + SSE) — chat endpoint + re-index endpoint.
- Uses the Model API contract via an Ollama adapter.
- Adapters: Ollama adapter (new or template-provided — confirm during build plan), Memory adapter (template default), Auth adapter (template default, trusted-local-user identity).
- New tool definition: `read_file(path: string)` — sandboxed to BrainDrive Files folder.
- No new external contracts; this is a Gateway-API consumer.

### Dependencies

- Existing PAA components from the template: Memory, Agent Loop, Auth, Gateway, and their conformance tests.
- External services: Ollama daemon on `localhost:11434` with `qwen2.5:7b` pulled.
- New packages: **[TBD: to be decided during build plan]** — likely a Markdown heading parser, possibly an SSE helper. Goal: minimize new dependencies.

### Constraints

- Performance: first-token latency dominated by Ollama; target "feels responsive" rather than a hard ms number for v1. Re-index of ~20 short files should complete in well under 2 seconds.
- Local-first: all functionality works fully offline (Ollama is local).
- Compatibility: Node ≥ 20 (template requirement). Latest stable Chrome/Safari/Firefox for the UI.
- Network: HTTP listener binds `127.0.0.1` only.

## Test Strategy

### Test levels required

- [x] Unit — Markdown heading parser, path-sandbox validator, TOC builder
- [x] Integration — Gateway endpoints (chat SSE + re-index) against a stub Model adapter, `read_file` tool against a temp folder
- [x] Property-based — path sandbox properties (any path outside the folder is rejected for ALL inputs), re-index idempotency (same folder state → same TOC)
- [ ] E2E — deferred for prototype; manual browser verification covers v1

### Verification approach

- Agent self-verification: `npm run check:conformance` must pass at every milestone. Feature-specific tests added under `test/` per the template's conventions. A demo script under `scripts/` exercises a real end-to-end chat against Ollama and produces visible output Dave can read.
- Human verification: Dave runs the app in a browser, types real questions against his real BrainDrive Files folder, confirms answers feel grounded and streaming feels alive.
- Production monitoring: N/A for v1 prototype. Audit log lines (already produced by the architecture) are sufficient.

### Baseline impact

- Always-run checks affected: `npm run check:conformance` (the template's safety net — must stay green).
- Additional checks triggered:
  - New tool definition → tool isolation + audit logging properties must still hold
  - New Gateway endpoints → outbound-guard, loopback-only, and contract conformance still hold
  - New adapter (Ollama) → adapter swap test must continue to pass (mock adapter remains usable)

## Security Considerations

### Risk level

- [x] Low — single local user, no external network surface, loopback-only Gateway, filesystem reads sandboxed to a single folder
- [ ] Medium
- [ ] High

### Threat assessment

- User input: chat messages flow into a local LLM. Validated for size only; LLMs handle free text. Tool-call arguments (`path`) are validated against the sandbox.
- Code execution: no user-provided code is executed. The agent calls one tool: `read_file`.
- Data sensitivity: personal notes. Sensitivity is high to Dave, but blast radius is bounded by loopback-only binding + Ollama-only egress.
- Network surface: one HTTP listener on `127.0.0.1:<port>`. No exposure to LAN or internet.
- Blast radius if compromised: an attacker with local-machine code execution already has direct filesystem access, so the app does not materially expand exposure.

### Required mitigations

- Bind Gateway HTTP listener to `127.0.0.1` only (never `0.0.0.0`).
- `read_file` tool: resolve the requested path to its canonical absolute form; reject if it is not a strict descendant of `~/Desktop/BrainDrive Files`; reject if it does not have a `.md` extension; refuse to follow symlinks whose targets exit the folder.
- Reject any inbound HTTP request whose origin is not loopback (`Host` and remote address check).
- Continue to enforce the architecture's outbound guard — only `localhost:11434` (Ollama) is in the allow-list. The check-lockin and outbound-guard conformance tests stay green.
- Memory writes carry an Auth approval per architecture, even in single-user mode.

## Explicit Boundaries

### Do not modify

- The four PAA component boundaries in `src/` (`memory/`, `engine/`, `auth/`, `gateway/`, `config/`, `types/`, `adapters/`) — extend within them, do not move responsibilities between them.
- The existing conformance test suite under `test/conformance/`.
- The OpenAPI / schema definitions under `specs/openapi` and `specs/schemas` — extend additively only, never rewrite.
- The `scripts/check-*` files — extend additively only.
- `package.json` `engines`, `scripts.check*`, `scripts.test*` blocks — extend additively, don't remove.

### Do not introduce

- Any outbound HTTP call to anything other than `localhost:11434` (Ollama).
- An embedding model, vector store, or RAG-style chunker.
- A second public API surface (the architecture allows two external APIs: Gateway API and Model API — no third).
- A pseudo-component for "tools," "documents," or "index" — they live inside existing components.
- Heavyweight UI frameworks (React, Vue, Svelte, etc. — plain HTML/JS is the prototype default; revisit during build plan).
- Auth UI (no login screen, no users table, no sessions DB).

### Out of scope (even if related)

- Multi-conversation history / sidebar.
- Citations / source highlighting.
- File editing or upload from the UI.
- Folder watching / auto-reindex.
- Non-Markdown file support.
- Cloud-model fallback.
- Mobile or native desktop packaging.
- Conversation export, sharing, or sync.
- Embedding-based retrieval.

## Open Questions

- **Port number for the Gateway HTTP listener.** Default proposal: `4321`. Confirm at build-plan time or pick an alternative.
- **UI framework choice.** Default proposal: plain HTML + a single JS file, no framework. Revisit during build plan if a tiny dependency materially simplifies streaming.
- **Over-large file handling.** If a single Markdown file is too large to return through `read_file` in one shot, do we truncate, error, or chunk? Decide during build plan.
- **TOC size limit.** With ~20 short files this is a non-issue, but at what file count or size does the TOC need to be summarized rather than dumped in full? Decide during build plan; v1 ships without this guard.
- **Ollama adapter source.** Confirm whether the template already provides an Ollama-compatible adapter or whether we author one against the Model API contract. Decide during build plan.
- **Approval flow surface.** v1 auto-approves single-user Memory writes. Confirm during build plan whether the audit log entries still need to render approval_request → approval_result events (architectural compliance) or whether a fast-path "auto-approved" entry is acceptable.

## Success Definition

When this feature is complete, Dave will be able to:
1. Run `npm` scripts to start the local app, open `http://localhost:<port>` in a browser, and see a clean chat UI.
2. Click **Re-index** and see the file count reflect his BrainDrive Files folder.
3. Ask a natural-language question about content in his notes and watch a grounded answer stream in token-by-token, with no network traffic leaving `localhost`.
4. Edit / add / delete files in the folder, re-index, and have new questions reflect the updated content.
5. Run `npm run check:conformance` and see all checks pass — confirming the build hasn't drifted from the PAA architecture.

---

## Changelog

| Date | Change | Source |
|---|---|---|
| 2026-05-11 | Initial spec | Interview 2026-05-08 + spec generation 2026-05-11 |
| 2026-05-11 | Reframed Problem statement and US-1 outcome from "search/recall" to "advisor with full personal context"; privacy reframed as the enabling constraint | Dave clarification after first spec draft |
| 2026-05-11 | Added "Planned for v1.1 (first follow-on)" — document editing via the AI, with intended shape and architectural touch points | Dave decision after first spec draft |
