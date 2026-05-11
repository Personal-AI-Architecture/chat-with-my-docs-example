# Build Plan: Chat With My Docs (local, single-user)

**Status:** Not Started

---

## Overview

A local web app — served by the template's Gateway on `127.0.0.1` — that lets Dave chat with his Markdown notes through a browser. The agent gets a structured TOC of `~/Desktop/BrainDrive Files` in its system prompt and calls a single sandboxed `read_file` tool when it needs full content. Chat model is Ollama (`qwen2.5:7b`) reached through the template's existing OpenAI-compatible adapter; no embedding model, no cloud calls, no new external component.

See [`spec.md`](spec.md) for detailed requirements and user stories.

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Retrieval shape | TOC-in-system-prompt + `read_file` tool | Spec choice. Markdown's heading structure carries enough signal; no embedding model needed. Maps cleanly onto Engine + Tool boundaries. |
| Model adapter | Reuse the template's `openai-compatible` adapter, pointed at `http://localhost:11434/v1` | Ollama exposes an OpenAI-compatible API; reusing the existing adapter keeps adapter-drift surface at zero (no new provider logic in Engine, no new adapter module). |
| Index storage | Memory component (via its tool contract) | Spec invariant: Memory writes route through Auth approval. Storing the index in Memory keeps it durable, exportable, auditable — and prevents drift toward "an index pseudo-component." |
| Index trigger | Manual `POST /reindex` Gateway endpoint, triggered by a UI button | Spec choice: no folder watcher in v1. Synchronous because the corpus is ~20 short files. |
| UI | Plain HTML + a single JS file, served as static assets by the Gateway | Spec open-question resolved: no framework. Smallest surface that satisfies "chat-only browser UI with streaming." |
| Gateway port | `4321`, bound to `127.0.0.1` only | Spec open-question resolved. Configurable via runtime config; default is `4321`. |
| Streaming protocol | SSE — already used by the template's `POST /chat` endpoint | No new transport. Re-uses `text-delta` / `done` events from the existing Gateway API. |
| Auth in v1 | Single trusted local-owner actor, supplied via `X-Actor-ID` / `X-Actor-Permissions` headers by the same-origin static UI | The template requires actor headers on protected routes; the UI mints them for the local user. Auto-approves Memory writes. |
| Over-large MD file | Hard cap: `read_file` truncates content above `64 KiB` and includes a truncation marker | Spec open-question resolved for v1. Keeps tool output bounded; rare for personal notes. Re-visit in v1.1. |
| Conversation persistence | None across launches in v1 | Spec choice. The template's conversation store still runs in-process per the Gateway contract — but the process restarts wipe v1 state since we configure it that way. |

## Architecture

### Component Diagram

```
[Browser, localhost:4321]
       |  (HTML/JS chat UI + Re-index button — same origin as Gateway)
       v
+----- Gateway (existing) ---------------------------------------------------+
|  POST /chat              — public chat entry, returns SSE stream          |
|  POST /reindex     (NEW) — rebuilds the index in Memory, returns count    |
|  GET  /              (NEW) — serves index.html                            |
|  GET  /app.js, /app.css (NEW) — serves static UI assets                   |
|  (existing) GET /conversations, GET /conversations/{id}, etc.             |
+---------------------------------------------------------------------------+
       |    Gateway -> Engine handoff (bounded payload, existing contract)
       v
+----- Engine (existing) ---------------------------------------------------+
|  Agent Loop — adds a system message containing the TOC at the head of    |
|  every chat turn, then runs the existing tool-call loop unchanged.       |
|  Tools advertised: [ read_file ]                                          |
+---------------------------------------------------------------------------+
       |                                          |
       | model_adapter.stream(...)                | tool_executor.executeMany(...)
       v                                          v
+----- openai-compatible adapter --+   +----- read_file tool handler (NEW)  +
|  (existing template adapter)     |   |  Resolves path; rejects anything   |
|  Configured base_url:            |   |  outside ~/Desktop/BrainDrive Files|
|  http://localhost:11434/v1       |   |  or non-.md; returns sanitized     |
|  Model: qwen2.5:7b               |   |  file content (capped at 64 KiB).  |
+----------------------------------+   +------------------------------------+
       |
       v
   [Ollama daemon, localhost:11434 — external Model]


+----- Memory (existing) ---------------------------------------------------+
|  Stores a single owner-data record: the BrainDrive Files index (TOC).    |
|  Reads via Memory contract; writes via Memory tool gated by Auth approval.|
+---------------------------------------------------------------------------+

+----- Auth (existing) -----------------------------------------------------+
|  Single trusted local-owner actor. Auto-approves Memory writes for index. |
|  Tool list filters: read_file is permitted for local-owner.               |
+---------------------------------------------------------------------------+
```

### Components Touched

#### 1. Gateway

- Purpose in this feature: serve the chat UI + `POST /reindex` control endpoint. The existing `POST /chat` is used unchanged (other than the system-message injection happening upstream in the Engine wiring helper, not in the public request shape).
- Files modified: `src/gateway/routes.ts`, `src/gateway/server.ts`, `specs/openapi/gateway-api.yaml`.
- Files added: `src/gateway/static.ts` (static asset handler), `web/index.html`, `web/app.js`, `web/app.css` (UI source under a new `web/` folder).
- Contract changes: OpenAPI spec gains `POST /reindex` + static UI route entries; client request schema for `/chat` is unchanged.

#### 2. Engine

- Purpose in this feature: run the agent loop with one tool advertised (`read_file`) and the TOC pre-loaded as a system message.
- Files modified: none in `src/engine/`. The loop is generic — we change *configuration*, not engine code.
- Contract changes: none. The Engine's request shape (`EngineChatRequest`) already accepts arbitrary `messages[]`, so injecting the TOC system message happens at the assembly boundary (where the Gateway builds the engine request), not inside the loop.
- Wiring code is added in a new `src/config/build-handlers.ts` (or extension of existing `src/config/boot.ts`) — composing engine + tools + adapters at startup.

#### 3. Tools (capability surface, NOT a component)

- Purpose in this feature: provide a single sandboxed `read_file(path)` tool.
- Files added: `src/library/markdown-toc.ts` (pure heading parser), `src/library/path-sandbox.ts` (pure path validator), `src/library/file-index.ts` (pure folder scanner that uses the first two), `src/tools/read-file.ts` (tool definition + handler that uses the sandbox).
- Files modified: existing tool-executor in `src/engine/tool-executor.ts` is extended *by configuration* — tools register into the existing executor. No engine-internals rewrite.

#### 4. Memory

- Purpose in this feature: persist the BrainDrive Files index across process restarts.
- Files modified: `src/memory/tools.ts` (new memory operation key for index, or use existing structured owner-data surface — TBD during execute).
- Contract changes: none. The Memory contract already covers owner data write/read/history.

#### 5. Auth

- Purpose in this feature: provide the local-owner actor context that the UI's same-origin requests carry, and auto-approve Memory writes triggered by `POST /reindex`.
- Files modified: `src/auth/provider.ts` (ensure local-owner identity is registered), `src/auth/middleware.ts` if needed for `POST /reindex` route protection.

#### 6. Adapter (openai-compatible — existing)

- Purpose in this feature: stream completions from Ollama via OpenAI-compatible HTTP.
- Files modified: `src/adapters/loader.ts` may need a config entry for the Ollama base URL.
- Files added: a runtime config JSON under `config/` selecting the adapter, base URL, and model.

### Data Flow

**Re-index flow (US-2):**
1. User clicks **Re-index** in the browser.
2. Browser sends `POST /reindex` to Gateway with actor headers + a generated correlation_id.
3. Gateway calls a Memory write via the existing Memory tool contract (with Auth approval).
4. Memory write handler invokes `file-index.buildIndex(BrainDrive Files folder)`, which produces `{ files: [ { path, headings[] } ] }`.
5. Index is persisted in Memory. Audit log records `approval_request` → `approval_result` → `write success`.
6. Gateway returns `200 { file_count: N, indexed_at: <iso> }`. UI updates the status line.

**Chat flow (US-1):**
1. User types a question, browser sends `POST /chat` with `{ content, metadata }` and actor headers (existing contract).
2. Gateway validates the client request, creates a new conversation in Memory (existing behavior), appends the user message.
3. Gateway builds the Engine request: messages array begins with a system message containing the TOC pulled from Memory, then the user message.
4. Engine streams. If model decides to call `read_file`, tool-executor runs the handler (path sandbox enforced), tool result flows back into the loop, model continues.
5. Tokens stream to the browser via SSE.
6. On `done`, Gateway appends the assistant message to the conversation (in-process, wiped at restart per spec) and emits the canonical `done` event.

---

## Implementation Roadmap

### Schedule Overview

| Phase | Goal | Status |
|---|---|---|
| 1 | Pure utility foundations: Markdown TOC parser, path sandbox, folder scanner | Complete |
| 2 | `read_file` tool registered with the tool-executor and runnable under Auth | Complete |
| 3 | Memory-backed index storage + `POST /reindex` Gateway endpoint | Complete |
| 4 | End-to-end agent wiring: Ollama adapter config, system-prompt TOC injection, full `/chat` loop | Complete |
| 5 | Web UI: static assets served by Gateway, chat + re-index button | Complete |

---

### Phase 1: Pure utility foundations — **Complete**

**Goal:** Build and unit-test the pure logic the rest of the feature depends on — Markdown heading parser, path sandbox validator, folder scanner — with no Memory, no Gateway, no Engine wiring.

**Tasks (tests-first):**

| # | Task | US | Status |
|---|---|---|---|
| 1.1 | Write `test/unit/markdown-toc.test.js` — heading parser cases: simple, nested, no headings, mixed `#`/`##`/`###` levels, code-fence skipping, unicode/emoji headings | US-1 | Not Started |
| 1.2 | Write `test/unit/path-sandbox.test.js` — accept paths inside allowed root; reject `..` traversal, absolute outside-root, symlinks whose canonical target exits root, non-`.md` extension | US-1, US-2 | Not Started |
| 1.3 | Write `test/unit/file-index.test.js` — scan a tmp folder of fixtures; assert returned index shape; assert hidden files (`.DS_Store`) ignored; assert empty folder returns `{ files: [] }`; assert missing folder returns a typed error | US-2 | Not Started |
| 1.4 | Write a fast-check property test in `test/unit/path-sandbox.property.test.js` — for ALL generated path strings, sandbox rejects any path whose canonical form does not start with `<root>/` | US-1 | Not Started |
| 1.5 | Write a fast-check property test in `test/unit/file-index.property.test.js` — re-indexing the same folder twice (no changes between runs) produces deep-equal output (idempotence) | US-2 | Not Started |
| 1.6 | Implement `src/library/markdown-toc.ts` — pure function: `parseHeadings(content: string): Heading[]` | US-1 | Not Started |
| 1.7 | Implement `src/library/path-sandbox.ts` — pure function: `assertInSandbox(requested: string, root: string): string` (returns canonical path or throws typed `PathSandboxError`) | US-1, US-2 | Not Started |
| 1.8 | Implement `src/library/file-index.ts` — `buildIndex(folder: string): FileIndex` using the two above | US-2 | Not Started |
| 1.9 | Run Phase 1 verification | — | Not Started |

**Success Criteria:**

| Criterion | Verification | Expected Result |
|---|---|---|
| All new unit tests pass | `node --test test/unit/markdown-toc.test.js test/unit/path-sandbox.test.js test/unit/file-index.test.js test/unit/path-sandbox.property.test.js test/unit/file-index.property.test.js` | All green |
| Existing tests unchanged | `npm run test` | All green |
| Conformance check passes | `npm run check:conformance` | All green (no new contracts touched yet, so this should be no-op-equivalent) |
| No new top-level src/ component appears | `ls src/` | Same dirs as before plus `library/` and `tools/`; no new component-named folder |
| Pinned dependency added | `cat package.json \| grep fast-check` | Shows `"fast-check": "3.23.2"` exactly (no `^` / `~`) |

**Exit Criteria:** All Phase 1 success criteria green. `src/library/*` exports are pure (zero imports of `src/engine`, `src/gateway`, `src/auth`, `src/memory`). `fast-check` is the only new dependency.

---

### Phase 2: `read_file` tool registered with the tool-executor — **Complete**

**Goal:** Register a `read_file` tool definition + handler that the Agent Loop can call. Tool is sandboxed and Auth-gated; failures are classified, not raw.

**Tasks (tests-first):**

| # | Task | US | Status |
|---|---|---|---|
| 2.1 | Write `test/integration/read-file-tool.test.js` — tool call returns content for an in-sandbox `.md`; rejects out-of-sandbox path with `tool_error` failure code; rejects non-`.md` with `tool_error`; rejects non-existent path with `tool_error`; truncates content above 64 KiB with a visible marker | US-1 | Not Started |
| 2.2 | Write `test/integration/read-file-tool.audit.test.js` — successful call emits a `tool_call success` audit entry with `correlation_id`; failure call emits a `tool_call failure` entry; neither leaks file system paths in the error message returned to the client | US-1 | Not Started |
| 2.3 | Write `test/integration/read-file-tool.auth.test.js` — local-owner actor permitted; missing/insufficient permissions denied with `tool_scope_check deny` audit entry; tool list filtered out for unauthorized actors | US-1 | Not Started |
| 2.4 | Implement `src/tools/read-file.ts` — tool definition (canonical schema: function name, description, JSON schema for `path` parameter) + tool handler that uses `path-sandbox` and reads the file | US-1 | Not Started |
| 2.5 | Register the tool through the existing tool-executor configuration path (extend whatever wiring the template uses — do not modify `src/engine/tool-executor.ts` core logic) | US-1 | Not Started |
| 2.6 | Run Phase 2 verification | — | Not Started |

**Success Criteria:**

| Criterion | Verification | Expected Result |
|---|---|---|
| Phase 2 tests pass | `node --test test/integration/read-file-tool.test.js test/integration/read-file-tool.audit.test.js test/integration/read-file-tool.auth.test.js` | All green |
| Conformance check passes | `npm run check:conformance` | All green (tool isolation, audit logging, security-defaults still pass) |
| No raw error leakage | grep test output for raw filesystem paths in `tool-result.error` payloads | None present |
| Tool not promoted to a component | `ls src/` | No `src/tools` *component* directory at top-level alongside `engine/memory/auth/gateway`; `src/tools/` exists only as a folder of capability handlers, with no exported "Tools" boundary |

**Exit Criteria:** `read_file` tool works in isolation against a fixture folder. Auth gates it. Audit log entries match the template's existing `tool_call` / `tool_scope_check` shapes. Engine internals untouched.

---

### Phase 3: Memory-backed index storage + `POST /reindex` endpoint — **Complete**

**Goal:** Persist the file index in Memory through the Memory tool contract (Auth-approved), expose `POST /reindex` on the Gateway, return file count to the caller.

**Tasks (tests-first):**

| # | Task | US | Status |
|---|---|---|---|
| 3.1 | Write `test/integration/index-memory.test.js` — writing the index calls Memory tool with an Auth-approved write; reading the index returns the same structure; restart of the in-process Memory adapter preserves the index (per the Memory durability invariant the template already tests for conversations) | US-2 | Not Started |
| 3.2 | Write `test/integration/reindex-endpoint.test.js` — `POST /reindex` requires actor headers (401 without); returns `200 { file_count, indexed_at }` on success; returns `500 { error: { code: "folder_missing" } }` when the configured folder doesn't exist; safe error message (no raw filesystem path) | US-2 | Not Started |
| 3.3 | Write `test/integration/reindex-audit.test.js` — successful re-index produces `approval_request` + `approval_result` + Memory `write success` audit entries with a consistent `correlation_id` | US-2 | Not Started |
| 3.4 | Extend `specs/openapi/gateway-api.yaml` to add `POST /reindex` with request/response schemas; ensure `specs/schemas/` has any new shapes referenced | US-2 | Not Started |
| 3.5 | Implement Memory storage for the index — use the existing owner-data surface in `src/memory/tools.ts`; do not introduce a new Memory storage primitive | US-2 | Not Started |
| 3.6 | Implement `POST /reindex` handler in `src/gateway/routes.ts` — protected route (requires actor headers), validates body is empty/ignored, calls into a re-index orchestrator that scans + writes via Memory | US-2 | Not Started |
| 3.7 | Update `scripts/check-contracts.ts` expectations if needed so the new route is verified (check what the script does and extend it additively) | US-2 | Not Started |
| 3.8 | Run Phase 3 verification | — | Not Started |

**Success Criteria:**

| Criterion | Verification | Expected Result |
|---|---|---|
| Phase 3 tests pass | `node --test test/integration/index-memory.test.js test/integration/reindex-endpoint.test.js test/integration/reindex-audit.test.js` | All green |
| Conformance check passes | `npm run check:conformance` | All green (Memory durability, contract conformance, lockin-gates, security defaults all pass) |
| OpenAPI spec validates | `node ./scripts/check-contracts.ts` | Exits 0; the new route is present and schema-valid |
| Loopback-only binding still enforced | Existing loopback test in `test/conformance/security-defaults.test.js` | Still green; `POST /reindex` rejected from non-loopback origins |
| Memory boundary clean | grep `src/gateway/routes.ts` and `src/tools/read-file.ts` for direct `fs` writes to Memory storage directories | None present — index reaches Memory only through its tool contract |

**Exit Criteria:** A `curl -X POST http://127.0.0.1:4321/reindex -H 'X-Actor-ID: local-owner' -H 'X-Actor-Permissions: memory.write,memory.read,read_file'` returns the file count. The index persists across server restarts within the same Node process if the Memory adapter is durable. From a non-loopback origin, the same request is rejected.

---

### Phase 4: End-to-end agent wiring (Ollama + system-prompt TOC + `/chat` loop) — **Complete**

**Goal:** A chat request to `POST /chat` reaches the Engine with the TOC injected as a system message, the Engine streams from Ollama via the existing openai-compatible adapter, and `read_file` tool calls work inside the loop.

**Tasks (tests-first):**

| # | Task | US | Status |
|---|---|---|---|
| 4.1 | Write `test/integration/chat-with-toc.test.js` — using a stub mock model adapter (NOT real Ollama): when the user sends a question and the model emits a `read_file` tool call, the system-prompt the engine received contains the TOC, the tool call hits the read_file handler, the tool result flows back, the model emits final text, and the stream completes with a canonical `done` event | US-1 | Not Started |
| 4.2 | Write `test/conformance/chat-system-prompt.test.js` — verifies the first message in the engine request is a `system` role and that it contains a deterministic "Files index:" marker plus the TOC structure (so we can audit it ever drifts) | US-1 | Not Started |
| 4.3 | Write `test/integration/chat-no-index.test.js` — when the index is empty (no re-index has been run yet, or BrainDrive Files is empty), the system message contains a "no files indexed" sentinel and the agent still streams a response | US-1 | Not Started |
| 4.4 | Write `test/integration/chat-tool-error.test.js` — when the model calls `read_file` with an out-of-sandbox path, the tool-result event carries a classified error, the loop terminates with a safe error event, and no internal path text leaks to the client | US-1 | Not Started |
| 4.5 | Add a runtime config JSON under `config/runtime.json` (or extend existing) selecting the `openai-compatible` adapter with `base_url: http://localhost:11434/v1`, `model: qwen2.5:7b`, no api_key required (Ollama doesn't need one but the field stays absent — no literal secret in config) | US-1 | Not Started |
| 4.6 | Implement system-prompt builder that pulls the latest index from Memory and prepends a system message to the engine request inside `src/gateway/routes.ts`'s engine-request assembly | US-1 | Not Started |
| 4.7 | Add `scripts/demo-chat.js` — runs an actual chat against a local Ollama, prints the streamed response. Manual verification only; not part of `npm test` | US-1 | Not Started |
| 4.8 | Run Phase 4 verification | — | Not Started |

**Success Criteria:**

| Criterion | Verification | Expected Result |
|---|---|---|
| Phase 4 tests pass | `node --test test/integration/chat-with-toc.test.js test/integration/chat-no-index.test.js test/integration/chat-tool-error.test.js test/conformance/chat-system-prompt.test.js` | All green |
| Conformance check passes | `npm run check:conformance` | All green — note that `model-adapter-behavior.test.js`, `gateway-contract.test.js`, `gateway-engine-stream.test.js`, `security-defaults.test.js`, `lockin-gates.test.js` must all stay green |
| No engine internals modified | `git diff src/engine/` | Empty (config-only changes; no engine source edits) |
| No new outbound destinations | `npm run check:lockin` | Allow-list still bounded to `localhost:11434`; no other domains added |
| Streaming works end-to-end | Run `node scripts/demo-chat.js` with Ollama running and a fixture folder | Tokens stream to stdout; `read_file` is called for in-folder questions; final assistant text non-empty |

**Exit Criteria:** With Ollama running and BrainDrive Files populated, the demo script holds a real chat turn that calls `read_file` and produces a streamed grounded answer. The Engine source is unmodified. The outbound guard list is unchanged.

---

### Phase 5: Web UI — **Complete**

**Goal:** Static assets served by the Gateway. User opens `http://127.0.0.1:4321`, sees a chat input, types a question, watches the answer stream in. Re-index button visible, status line shows `<N> files indexed`.

**Tasks (tests-first):**

| # | Task | US | Status |
|---|---|---|---|
| 5.1 | Write `test/integration/static-assets.test.js` — `GET /` returns 200 with `Content-Type: text/html` and contains `<title>Daves-AI</title>` (or similar deterministic marker); `GET /app.js` returns 200 with `Content-Type: text/javascript`; both reject from non-loopback origins | US-1, US-2 | Not Started |
| 5.2 | Write `test/integration/static-assets-no-traversal.test.js` — request paths like `/../package.json`, `/%2e%2e/package.json`, `/web/../package.json` all return 404 (no traversal out of the `web/` folder) | US-1 | Not Started |
| 5.3 | Implement `src/gateway/static.ts` — minimal static handler scoped to the `web/` folder with explicit allow-list of file extensions (`.html`, `.js`, `.css`); refuses traversal | US-1, US-2 | Not Started |
| 5.4 | Wire static handler into `src/gateway/routes.ts` AFTER all API routes (API routes win on conflict) | US-1, US-2 | Not Started |
| 5.5 | Author `web/index.html` — single chat surface: scrollable transcript, input at the bottom, "Re-index" button top-right, status line showing file count | US-1, US-2 | Not Started |
| 5.6 | Author `web/app.js` — opens an SSE connection to `POST /chat` (using `fetch` + ReadableStream — not `EventSource`, since EventSource doesn't support POST), appends text-delta chunks to the transcript, handles `tool-call` / `tool-result` / `error` / `done` events gracefully, sends actor headers on every request, fires `POST /reindex` on button click and updates the status line | US-1, US-2 | Not Started |
| 5.7 | Author `web/app.css` — minimal, readable, no framework | US-1, US-2 | Not Started |
| 5.8 | Manual verification: start the server, open the browser, drop a real Markdown file into `~/Desktop/BrainDrive Files`, click Re-index, ask a question that requires the file, confirm the answer streams in and reflects the file's content | US-1, US-2 | Not Started |
| 5.9 | Run Phase 5 verification | — | Not Started |

**Success Criteria:**

| Criterion | Verification | Expected Result |
|---|---|---|
| Phase 5 tests pass | `node --test test/integration/static-assets.test.js test/integration/static-assets-no-traversal.test.js` | All green |
| Conformance check passes | `npm run check:conformance` | All green |
| Server binds loopback only | `lsof -nP -iTCP -sTCP:LISTEN \| grep 4321` while server runs | Bound to `127.0.0.1:4321` only; no `*:4321` |
| No outbound traffic from a chat turn except Ollama | `lsof -nP -i \| grep node` during a chat | Only loopback + `localhost:11434` connections present |
| Browser end-to-end works | Manual verification per task 5.8 | Dave can chat with his real notes, see streaming, click re-index |

**Exit Criteria:** Dave opens the browser, has a working chat, can re-index his folder, and gets streamed grounded answers. No `^` / `~` versions in `package.json`. `npm run check:conformance` is green.

---

## Technical Details

### Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Language | TypeScript | Pinned by the template |
| Runtime | Node ≥ 20 | Match `package.json` engines |
| Test framework | `node:test` | Already used by template — no new framework |
| Property-based | `fast-check` | New, pinned to `3.23.2` |
| Markdown headings | Hand-rolled regex parser in `src/library/markdown-toc.ts` | No new dependency — heading parsing is small and we want full control over edge cases (code fences, frontmatter) |
| SSE on the client | Browser `fetch` + manual stream parsing | `EventSource` doesn't support POST + custom headers; spec needs actor headers on each request |

### Environment & Version Constraints

| Dependency | Required Version | Notes |
|---|---|---|
| Node | ≥ 20 | From template `engines` |
| TypeScript | `^5.9.3` (existing) | Template-pinned |
| `@types/node` | `^25.6.0` (existing) | Template-pinned |
| `fast-check` | `3.23.2` | NEW. Pinned — no `^` / `~`. Used for path-sandbox + index-idempotence properties |
| Ollama | Any version with `/v1` OpenAI-compatible API | External, user-supplied; verify on first chat with a clear error if absent |
| Ollama model | `qwen2.5:7b` | `ollama pull qwen2.5:7b` is required before the first chat; surface a clear error if missing |

### Contracts & Schemas

- **`POST /reindex`** — additive route on the Gateway API.
  - Request: empty body (or ignored)
  - Response 200: `{ file_count: integer, indexed_at: ISO-8601 string }`
  - Response 401: missing actor headers
  - Response 500: `{ error: { code: "folder_missing" | "memory_write_failed", message: <safe string> } }`
  - Reference: `specs/openapi/gateway-api.yaml` (this file is extended in Phase 3).
- **Engine request shape** — unchanged. The TOC system message is added by the Gateway's engine-request assembly before invoking the existing handler; the Engine's `EngineChatRequest` schema is not modified.
- **`read_file` tool definition** — registered through the existing tool-executor's canonical tool schema. Parameters: `{ path: string }`. No new tool-API surface.

### Adapters & Externals

- **Model adapter:** existing `openai-compatible` in `src/adapters/openai-compatible.ts`, configured via runtime config to point at `http://localhost:11434/v1`. No new adapter module. No provider-specific logic in Engine or Gateway.
- **Client:** browser (Dave's, same machine, same origin as the Gateway).
- **Tool:** `read_file` — local filesystem read, sandboxed to `~/Desktop/BrainDrive Files`, `.md` only.

---

## Drift Considerations

> Read against `docs/blueprints/drift/{Engine,Gateway,Memory,Auth,Tools,Adapter}-drift-guard.md` in the reference repo.

| Component | Drift Pattern (from drift-guard) | How We Prevent It |
|---|---|---|
| **Engine** | "Engine accumulates product-specific business logic" (Engine-DG §1) | TOC system-message injection happens at the Gateway's engine-request assembly boundary, NOT inside the Agent Loop. `git diff src/engine/` must be empty at every phase exit (Phase 4 success criterion). |
| **Engine** | "Assistant text dropped when tool calls are present" (ENGD-CHK-006) | Existing template behavior is correct; Phase 4 test `chat-with-toc.test.js` exercises a multi-turn (tool call → result → final assistant text) flow and asserts assistant text is preserved. |
| **Engine** | "Recoverable tool failures incorrectly treated as terminal" (ENGD-CHK-008) | `read_file` failures (bad path, missing file) emit `tool-result` with `error` field, NOT a terminal stream `error`. Phase 4 test `chat-tool-error.test.js` asserts the loop continues to a graceful classified error event without dumping internal state. |
| **Engine** | "Provider-specific payload formatting leaks into loop core" (Engine-DG §1, ENGD-CHK-014) | Phase 4 adds zero engine source edits — provider concerns stay in `src/adapters/openai-compatible.ts`. Reuse, not new code. |
| **Gateway** | "External client payloads allowed to submit internal Engine contract shape" (GWD-CHK-003) | We do not change the client request schema — `POST /chat` still rejects `messages[]` from the client (existing `parsePublicMessageRequest` enforces this). Phase 4 test does not bypass the public route. |
| **Gateway** | "Auth omitted on protected routes" (GWD-CHK-001) | `POST /reindex` requires actor headers; static asset routes are GET-only and harmless but still loopback-bound. Phase 3 test `reindex-endpoint.test.js` asserts 401 without headers. |
| **Gateway** | "Unsafe internal error detail leaking to client-visible responses/events" (GWD-CHK-008) | All error responses go through `toSafeClientMessage` (existing helper). Phase 3 test `reindex-endpoint.test.js` asserts no raw filesystem paths in the error body. |
| **Gateway** | "Approval semantics implemented only in UI/client flow" (Gateway-DG §1) | Re-index writes go through the Memory tool contract with explicit `approval_request` + `approval_result` audit events; Phase 3 test `reindex-audit.test.js` asserts both events appear in the audit stream. |
| **Memory** | "Components bypass Memory tools with direct filesystem/database reach-in" (Memory-DG §1, MEMD-CHK-002) | The re-index handler writes to Memory only via the Memory tool contract. `read_file` reads from `~/Desktop/BrainDrive Files` — which is NOT Memory's storage area — so no Memory bypass. Phase 3 success criterion greps for direct `fs` writes to Memory dirs. |
| **Memory** | "Path sandbox protections weakened" (MEMD-CHK-004) | Memory's existing path sandbox stays untouched. Our separate `path-sandbox.ts` for the `read_file` tool is a distinct boundary over a different root; Phase 1 property test covers all-inputs rejection of out-of-root paths. |
| **Memory** | "Zero outward dependencies" (MEMD-CHK-001) | `src/memory/*` imports nothing from `src/gateway`, `src/engine`, `src/auth`, `src/tools`, or `src/library`. Static check: `npm run check:imports` enforces this (existing). |
| **Auth** | "Local-owner mode implemented as no-auth mode" (Auth-DG §1) | The local-owner actor is a real registered identity in `src/auth/provider.ts` with explicit permissions (`memory.read`, `memory.write`, `read_file`). Auto-approval is a *policy* for this actor, not a bypass — the approval_request/approval_result events still fire. |
| **Auth** | "Tool list/execution filtered by Auth permissions" (AUTHD-CHK-006) | `read_file` tool advertisement and execution both check the actor's `read_file` permission. Phase 2 test `read-file-tool.auth.test.js` asserts unauthorized actors do not see the tool and cannot execute it. |
| **Auth** | "Actor context not propagated to Engine/tool execution" (AUTHD-CHK-010) | The Gateway's existing engine-request assembly already injects `actor_id` + `actor_permissions` into engine metadata; we keep that path. Phase 2 test asserts the tool handler sees the actor. |
| **Tools** | "Tools promoted into a fifth architecture component" (TOLD-CHK-001) | `src/tools/` is a folder of capability handlers — NOT a top-level component. No `Tools` boundary appears in any architectural inventory or exported public surface. Phase 2 success criterion: `ls src/` shows no Tools-component pattern. |
| **Tools** | "Introduction of a separate Tool API boundary" (TOLD-CHK-002) | No `/tools/*` HTTP route is added. The only paths added are `POST /reindex` (a Gateway control surface) and static asset routes. |
| **Tools** | "Tool execution logic moved outside Engine" (TOLD-CHK-003) | Tool execution stays inside the existing `src/engine/tool-executor.ts`. We register a handler; we don't reimplement execution. Phase 2 test exercises the tool through the existing executor. |
| **Tools** | "Approval modeled as prompt guidance rather than coded enforcement" (TOLD-CHK-009) | `read_file` is read-only and Auth-permitted, so no per-call approval is required. The re-index flow's *Memory write* (which would normally need approval) goes through coded approval_request/approval_result events — Phase 3 test asserts this. |
| **Tools** | "Raw/unsafe tool failure messages leaked to client-visible surfaces" (TOLD-CHK-010) | `read_file` handler converts internal errors to classified codes; never returns raw `Error.message` or stack traces. Phase 2 audit test asserts no filesystem paths or stack frames in client-visible output. |
| **Adapter** | "Provider protocol logic leaked into Engine or Gateway internals" (ADPD-CHK-004) | We use the existing `openai-compatible` adapter unchanged; the only adapter-touching code is a runtime config selecting base URL + model. |
| **Adapter** | "Runtime adapter selection overridden by request payloads" (ADPD-CHK-002, ADPD-CHK-012) | The client request schema is unchanged — clients still cannot send `provider`, `model`, `tool_sources`, or any adapter selector. Existing schema validation enforces this. |
| **Adapter** | "Raw secrets stored in adapter config" (ADPD-CHK-007) | Ollama doesn't require an API key. The adapter config has no `api_key` literal. If a future Ollama auth mode is added, it goes through a secret reference, not an inline value. |
| **Foundation** | "Adding a fifth architectural component" (foundation.md, ADPD-CHK-014) | No new top-level component is introduced. `library/` and `tools/` are capability folders. The architecture's four-component / two-external-API count is preserved; Phase 5 success criterion runs `check:lockin`. |

---

## Security Considerations

| Threat | Mitigation |
|---|---|
| Cross-origin or LAN client reaches the app | Gateway HTTP listener binds `127.0.0.1` only (validated by existing security-defaults test + Phase 5 `lsof` check) |
| Path traversal via `read_file` tool | `src/library/path-sandbox.ts` resolves canonical absolute path, rejects anything not strictly under `~/Desktop/BrainDrive Files`, rejects non-`.md`, refuses symlinks that exit the root. Validated by Phase 1 property test (ALL inputs) + Phase 2 integration test |
| Path traversal via static asset handler | `src/gateway/static.ts` resolves canonical path, restricts to `web/` folder, allow-list of extensions. Validated by Phase 5 test |
| Outbound exfiltration | Outbound guard allow-list contains `localhost:11434` only. `npm run check:lockin` enforces this; Phase 4 success criterion explicitly re-verifies |
| Secret material in config | Adapter config has no `api_key` field. Local Ollama doesn't require one |
| Memory writes bypass Auth | Re-index path goes through Memory tool contract with explicit Auth approval events. Phase 3 audit test asserts both `approval_request` and `approval_result` are present |
| Raw error leakage to client | All error responses + tool errors pass through `toSafeClientMessage` / classified failure codes. Phase 2 + Phase 3 tests assert no filesystem paths in client-visible output |
| Tool callable by unauthorized actor | Auth-gated tool advertisement and execution. Phase 2 `read-file-tool.auth.test.js` asserts both |

---

## Open Items

- **Where exactly the index is stored in Memory.** The template's Memory surface supports owner data; the right shape (single record vs. one record per file vs. a structured index entry) is best decided when Phase 3 starts. Decide during execute, document the choice in the work log.
- **System-prompt format for the TOC.** A deterministic structure ("Files index:\n- path: <p>\n  headings:\n    - <h1>\n    - <h2>...") is fine for v1, but format details (ordering, escaping, max-size truncation policy) are decided during Phase 4. The phase 4 conformance test pins the marker string but not the exact body.
- **Whether to add a model-availability preflight check.** Currently failure surfaces on first chat turn. A startup check (e.g., GET `http://localhost:11434/api/tags` to confirm `qwen2.5:7b` is available) would surface the problem sooner. Decide during Phase 4.
- **Whether re-index should be async with progress events** when corpus size grows. v1 corpus is ~20 short files so synchronous is fine. Re-visit before v1.1.

## Completion Checklist

- [ ] All phases complete
- [ ] All tests passing (`npm test` and `npm run check:conformance`)
- [ ] Conformance check passes (`npm run check:conformance`)
- [ ] Drift-guard checks pass (no drift patterns from §Drift Considerations slipped in — spot-check `git diff src/engine/` is empty, `ls src/` has no fifth-component folder, `check:lockin` outbound list is bounded)
- [ ] No linting errors (`npm run check:toolchain` exits 0)
- [ ] Spec acceptance criteria all covered by tests (every Given-When-Then in `spec.md` has a corresponding test file/case)
- [ ] Manual browser verification done end-to-end against real `~/Desktop/BrainDrive Files`
- [ ] Work log updated

---

## Changelog

| Date | Change | Source |
|---|---|---|
| 2026-05-11 | Initial build plan | Generated from spec.md |

## Work Log

> Filled in during step 4 — Execute. Append a new entry per phase or per significant decision/issue.

**2026-05-11 — Phase 1: Pure utility foundations**

- **What was attempted:** Build pure-utility foundations (Markdown TOC parser, path sandbox, folder scanner) under `src/library/` with tests-first ordering. Five test files (`markdown-toc.test.js`, `path-sandbox.test.js`, `file-index.test.js`, `path-sandbox.property.test.js`, `file-index.property.test.js`) written before any implementation. `fast-check@3.23.2` installed exact-pinned in `devDependencies` after explicit user approval.
- **What worked:** All 42 Phase 1 tests pass (29 unit + 5 property-based + 8 file-index). Full template test suite is 82/82 green via `node --test test/unit/*.test.js`. `npm run check:conformance` remains 14/14 green. `src/library/*.ts` imports zero PAA-component code (verified by grep) — pure utilities, no drift. `src/` still has only four PAA components plus existing utility folders (`adapters/`, `config/`, `types/`) and the new `library/` utility folder; no fifth-component pattern.
- **What didn't work (and was fixed):** First test run had 2 failures, same root cause. Path-sandbox initially called `realpathSync` first and only checked descendant-of-root on the canonical form — so for non-existent escape paths like `../escape.md`, the function threw `invalid_path` (because realpath failed) when the test expected `out_of_sandbox`. Fix: do the lexical descendant check on `path.resolve(root, requested)` BEFORE the realpath call — non-existent escapes now throw `out_of_sandbox` directly; symlinks pointing outside are still caught by the post-realpath check. Also tightened the corresponding property test (`subdir/..` cancels back to root, which is legitimately inside the sandbox — the test had been treating any `..`-containing input as a guaranteed escape).
- **Decisions made:**
  - Used the existing `scripts/ts-require.js` helper (already in the template) for TS test loading rather than inlining the transpile shim in every new test file. This matches the spirit of the template without refactoring existing test files.
  - Heading parser supports ATX-only (`# Title`, not Setext underlines), handles YAML frontmatter at line 0, skips fenced code blocks (` ``` ` and `~~~`), allows up to 3 leading spaces (4+ is a code block), strips trailing closing hashes, normalizes CRLF→LF.
  - `assertInSandbox` returns the canonical resolved path on success; throws `PathSandboxError` with one of three codes (`invalid_path`, `out_of_sandbox`, `invalid_extension`). Error messages are static and do not echo the input back — a separate test asserts no `..` text in error output.
  - `buildIndex` recurses into subdirectories, skips any name starting with `.` (both files and dirs), refuses to follow symlinks whose canonical target exits the root, sorts results by `path` ascending for deterministic/idempotent output, posix-style relative paths in output, 1 MiB cap on file content read.
- **Lessons learned:**
  - `npm test` (which calls `node ./scripts/run-tests.js`) was broken on Node 22.20.0 *before* this build — `run-tests.js` passes the bare `test/unit` directory to `--test`, which Node 22 doesn't auto-discover from. The conformance script works because it explicitly globs `test/conformance/*.test.js`. Not in Phase 1 scope to fix; flagged as a pre-existing template defect. Workaround used throughout Phase 1: `node --test test/unit/*.test.js`.
  - Property tests need careful framing: it's easy to write a property that's *too strict* (rejects legitimate inputs the implementation correctly accepts). The first version of the traversal property treated `subdir/..` as an escape — it isn't. Rule of thumb: the property should describe the actual safety invariant ("never returns a path outside the sandbox"), not a heuristic ("any input with `..` is rejected").
- **Drift checks:** `src/engine/` unchanged (`git status` shows no edits). `src/` has no fifth-component folder. Lockin / outbound guard / security defaults all still pass via `npm run check:conformance`. `src/library/*.ts` has zero PAA-component imports.

**2026-05-11 — Phase 2: `read_file` tool**

- **What was attempted:** Register a sandboxed `read_file(path)` tool definition + handler with the existing tool-executor, Auth-gated by a `read_file` permission, with classified failure codes and sanitized client messages. Three integration test files written first: behavior (`read-file-tool.test.js`), audit (`read-file-tool.audit.test.js`), and auth (`read-file-tool.auth.test.js`). One new source file: `src/tools/read-file.ts` exporting `createReadFileToolDefinition()` and `createReadFileHandler()`.
- **What worked:** All 19 Phase 2 tests passed on the first run. `npm run check:conformance` 14/14 green. Full suite 116/116 (`node --test test/unit/*.test.js test/integration/*.test.js test/conformance/*.test.js`). Zero engine code edits (`git diff --stat src/engine/` is empty). `src/tools/` is a handler-only folder with no exported boundary — the tool registers through the existing `createToolExecutor` configuration path. Audit entries (`tool_call` received/completed/failure, `tool_authorization_check`, `tool_scope_check`) come from the existing executor; the tool just throws — the executor sanitizes. Path-sandbox errors flow through as generic `read_file_<code>` strings in diagnostics; the client sees only `failure_code: "execution_failed"` and a static "Tool execution failed." message.
- **What didn't work:** Nothing failed mid-phase. One small judgment call on test capture pattern (see below).
- **Decisions made:**
  - The handler throws plain `Error` instances with stable codes (`read_file_invalid_argument`, `read_file_out_of_sandbox`, `read_file_invalid_extension`, `read_file_read_failed`). The executor's existing failure path catches them, logs them in audit diagnostics, and returns a generic client message. This is the cleanest way to satisfy "raw error not leaked" without modifying executor code.
  - Tool definition declares `source: "library"`, `mutates_state: false`, `required_permissions: ["read_file"]`. The executor's source-allowlist and permission-check paths gate execution accordingly. Verified by `read-file-tool.auth.test.js`: `scope_violation` when source not allowed, `unauthorized` when actor lacks the permission, success on wildcard `*`.
  - 64 KiB truncation cap with a visible marker. Below or equal to the cap → full content returned. Above the cap → first 64 KiB + `\n\n[... truncated: ...]` marker. The marker text is descriptive enough for the LLM to know it needs a more specific question to drill in.
  - Audit-capture test helper wraps `process.stderr.write` and forwards each chunk to the original `write` so `node:test`'s diagnostic output keeps flowing while we collect JSON audit lines. Forwarding (vs swallowing) preserves test output visibility — important when something does fail.
  - "Tool list filtered for unauthorized actors" — the existing engine advertises tools at request time without permission-filtering them. Phase 2 verifies the *execution-level* auth gate (which the template provides). Advertisement-level filtering would be an engine-internals change; deferred to Phase 4 if it becomes relevant, and not strictly needed for a single-tool single-actor build (local owner always holds the permission).
- **Lessons learned:**
  - The tool-executor handles a lot for free — three layers of pre-execution gating (name allowlist, source allowlist, permission check) plus audit logging on each layer, plus error sanitization on the failure path. Plugging a new tool in is mostly about declaring the right metadata on the `ToolDefinition` and writing a focused handler.
  - The drift-guard rule "tools are not a fifth component" maps neatly: `src/tools/` is a folder of handlers, the executor stays in `src/engine/`, and the tool's only public surface is two factory functions and a few constants — no `Tools` boundary.
- **Drift checks:** `src/engine/` unchanged. `src/` has `tools/` and `library/` as utility folders, not new components. Conformance check is 14/14; lockin / outbound guard / contract / security-defaults / tool-isolation / audit-logging tests all green. Tool failure messages do not leak filesystem paths (verified by `read-file-tool.audit.test.js`).

**2026-05-11 — Phase 3: Memory-backed index + `POST /reindex`**

- **What was attempted:** Wire a `POST /reindex` route into the Gateway that orchestrates `buildIndex(folder)` + a Memory write of the resulting TOC, all under Auth approval. Persistence handled through the existing Memory tool contract (no new Memory storage primitive). Three integration tests written first (`index-memory.test.js`, `reindex-endpoint.test.js`, `reindex-audit.test.js` — 14 tests total). `ReindexHandler` interface added to `src/types/contracts.ts` so the Gateway only depends on a contract; the orchestrator is wired externally (the route accepts a handler via config).
- **What worked:** All 14 Phase 3 tests pass on the first run. `npm run check:conformance` 14/14. Full suite 130/130 (`node --test test/unit/*.test.js test/integration/*.test.js test/conformance/*.test.js`). `git diff --stat src/engine/` empty. The import-boundary check stays green — Gateway imports nothing outside `gateway/` + `types/`; the orchestrator that uses `library/file-index.ts` is built at the test/wiring boundary (where check-imports doesn't apply). OpenAPI spec extended additively with `/reindex` and `ReindexResult` + `GatewayErrorEnvelope` schemas; `check:contracts` still passes.
- **What didn't work:** Nothing failed mid-phase. One scope-shaping decision (see below).
- **Decisions made:**
  - The Gateway can only import from `gateway/` and `types/` (enforced by `scripts/check-imports.ts`). That blocks the natural shape "Gateway has an orchestrator that imports `file-index` from `library/`." Solution: `ReindexHandler` interface in `types/`, the Gateway accepts an injected handler, and the actual orchestrator (which does call `library/file-index.ts` and `memory/tools.ts`) lives outside `src/`-component-land — composed at the test boundary in Phase 3, will live in the entry-point/wiring layer in Phase 4. This preserves the import-boundary invariant cleanly.
  - Memory's existing approval gate auto-approves only `conversations/*` keys by default — any other key (including our index) is denied unless an explicit `approvals.decide` is provided. The orchestrator's `MemoryTools` is constructed with `approvals.decide` that auto-approves writes whose target key is exactly the index key (`library/index`). This is policy-level auto-approval, not a bypass: `approval_request` + `approval_result` audit events still fire (verified by `reindex-audit.test.js`).
  - Index key: `library/index` (a single-record TOC stored under that key — simplest shape, idempotent re-writes via `memoryTools.write(key, newIndex)`).
  - Error mapping in the route: handler may throw an error carrying `reindex_code` (`folder_missing` | `not_a_directory` | `memory_write_failed` | `internal_error`). Gateway maps the code to a static safe message via `safeReindexErrorMessage`. Stack traces and `Error.message` flow into the audit log (`toErrorDiagnostics`) but never to the client.
  - `routeReindex` returns 503 (not 200/500) when no `reindex_handler` is configured on the route — that's a startup misconfiguration, not a runtime failure. Currently unreachable in tests because every test wires a handler; surface added for future operability.
- **Lessons learned:**
  - The import-boundary check is a real shaping force. The first instinct was "put a small `library-index-store.ts` inside `src/gateway/`" — that would have failed `check:imports` the moment it tried to import `FileIndex`. The fix wasn't bigger code; it was moving the orchestration out of the component and using an injected interface. The architecture's "Gateway is bounded" rule pays off when followed.
  - Memory's audit shape includes `approval_request` + `approval_result` for every write (regardless of approval mode) — these are *always* visible to an auditor. v1 auto-approves the index write via a policy, but the auditor can still see "this write was approved by policy" rather than "this write bypassed approvals." That matches the Tools-drift-guard requirement (approvals as coded events, not prompt guidance).
- **Drift checks:** `src/engine/` unchanged (`git diff --stat src/engine/` empty). `src/` shape unchanged at the component level (`auth/engine/gateway/memory` + `adapters/config/types` shared + `library/tools` utility). `check:imports` green — gateway/routes.ts only imports from `gateway/` + `types/`. `check:contracts` green — additive OpenAPI extension. `check:lockin` green — outbound allow-list unchanged. Memory durability test in `index-memory.test.js` confirms cross-instance persistence over the same memory_root. Sanitized error responses verified by `reindex-endpoint.test.js` (no FS paths in 500 bodies).

**2026-05-11 — Phase 4: End-to-end agent wiring**

- **What was attempted:** Inject the file index as a system message at the head of every chat turn, run the agent loop against the existing openai-compatible adapter (configured for Ollama), confirm `read_file` tool calls work in-loop and the failure path is clean. Wrote four test files first (chat-with-toc, chat-no-index, chat-tool-error, plus a conformance test chat-system-prompt) — 8 tests total. Added a `SystemPromptBuilder` contract in `src/types/contracts.ts`, a `formatSystemPromptBody()` utility in `src/library/system-prompt-format.ts` (importable by tests + scripts), runtime config at `config/runtime.json`, and a `scripts/demo-chat.js` for manual Ollama verification.
- **What worked:** All 8 Phase 4 tests pass (one failure during writing, see below). Conformance is now 16/16 (added two new conformance tests on system-prompt shape). Full suite 138/138. `git diff --stat src/engine/` empty — no engine source edits. The gateway's `routeMessage` now prepends a system message returned by the injected builder if present; absent builder = no injection (preserves backward compatibility with onboarding demo). System-prompt body format is documented in code (`FILES_INDEX_MARKER = "Files index:"`, `EMPTY_INDEX_SENTINEL`, `READ_FILE_GUIDANCE`); conformance test asserts the marker is present.
- **What didn't work (and was fixed):** First run of `chat-tool-error.test.js` failed: I had asserted that "`..`" never appears in any client-visible event. But the `tool-call` event legitimately echoes the model's own bad argument (`{"path":"../escape.md"}`) — that's transparency, not a leak; a UI may show "the model attempted X." Tightened the assertion to forbid server-side FS paths (sandbox root, `os.tmpdir()`, stack-trace file frames `at FILE:LINE:COL`) only. Model-produced arguments are part of the contract.
- **Decisions made:**
  - `SystemPromptBuilder` is a tiny interface: `build(): Promise<CanonicalMessage | null>`. The gateway prepends if non-null, skips if null, and audits a failure on builder throw. The actual format-the-TOC logic lives in `src/library/system-prompt-format.ts` so both tests and the demo script use the same formatter — drift in the format triggers a real conformance failure.
  - The system prompt is NEVER persisted in the conversation store. We rebuild it from Memory on every turn. That way edits/re-indexes are reflected immediately on the next chat without conversation state churn.
  - On a builder throw, the gateway emits `gateway.system_prompt_build_failed` audit (failure) with diagnostics, but the chat continues *without* a system prompt rather than failing the whole turn. The model can still answer generically; degraded UX > broken UX. This is a deliberate failure mode; spec it later in v1.1 if needed.
  - Runtime config at `config/runtime.json` selects `provider_adapter: "openai-compatible"`, `adapter.api_base_url: "http://localhost:11434/v1"`, `adapter.model: "qwen2.5:7b"`. No `api_key` field — Ollama doesn't need one, and the adapter-drift-guard forbids literal secrets in tracked config.
  - `scripts/demo-chat.js` wires the full stack against real Ollama: it expands `~` in paths, creates `memory_root` if missing, rebuilds the index every run, runs ONE chat turn streaming to stdout, prints `[tool-call ...]` / `[tool-result N chars]` / `[done]` markers. Surfaces a clear error if the notes folder is missing.
- **Lessons learned:**
  - The mock adapter's default `scripted_chunks` yields the SAME chunks on every `stream()` call — that means multi-turn tool loops would re-replay the script. Built a small `createScriptedAdapter(scripts)` test helper that returns a different script per sequential call. Worth promoting to a shared helper if more multi-turn tests show up.
  - The `tool-call` event echoes the model's raw `arguments` field. That's by design and is part of the Gateway stream contract — UIs may surface what tool the model attempted. The line between "useful transparency" and "data leak" is: model-produced strings = transparent, server-side filesystem paths = leak. Sanitization must target the latter, not the former.
- **Drift checks:** `src/engine/` unchanged (`git diff --stat src/engine/` empty — engine code untouched in Phase 4; only added a new conformance test that *exercises* the engine). `check:imports` green — `src/gateway/routes.ts` still imports only `gateway/` + `types/`. `check:lockin` green — outbound-network guard logic in adapters unchanged; allow-list is permit-scoped, not host-scoped, so adding Ollama as the target requires no allow-list edit. `check:contracts` green. Provider-specific formatting stays in `src/adapters/openai-compatible.ts` (existing); Engine has no Ollama-specific code. System-prompt content does not appear in any conversation persistence record — the conversation store sees only `user` + `assistant` messages.

**2026-05-11 — Phase 5: Web UI**

- **What was attempted:** Add a minimal browser UI for chat + re-index, wire a static-assets handler into the Gateway routes, and provide an HTTP server entrypoint so a real browser can reach the gateway on `http://127.0.0.1:4321`. Two test files written first (`static-assets.test.js`, `static-assets-no-traversal.test.js`) — 20 tests. New code: `src/gateway/static.ts` (handler), `web/index.html` + `web/app.js` + `web/app.css` (the UI), `scripts/serve.js` (the HTTP entrypoint). `npm run serve` added as a convenience.
- **What worked:** All 20 Phase 5 tests pass on the first run. Conformance still 16/16. Full suite 158/158 (`node --test test/unit/*.test.js test/integration/*.test.js test/conformance/*.test.js`). `git diff --stat src/engine/` empty. The Gateway routes dispatch order is now: API routes (POST /chat, conversations, POST /reindex) → static handler (only for GET) → catch-all 404 — so the static handler never intercepts API calls. The static handler refuses raw and URL-encoded `..` traversal, mixed-case encodings, double-encoded sequences, symlinks whose canonical target exits `web/`, disallowed extensions, and null bytes — all property-style asserted.
- **What didn't work:** Nothing failed mid-phase. One architectural choice surfaced (see below).
- **Decisions made:**
  - The template ships no HTTP listener — `gateway/server.ts` is a logic abstraction, and Phase 4's demo ran routes in-process. For Phase 5 to be browser-usable, I added `scripts/serve.js` as a tiny Node `http.createServer` wrapper. It lives in `scripts/` so it's outside the `src/` import-boundary enforcement and can wire library + tools + memory + adapter freely. Refuses any non-loopback `bind_address` from runtime config and rejects non-loopback remote addresses at request time as a belt-and-suspenders check.
  - Static handler is GET-only. POSTs to a static-shaped path (`POST /app.js`) fall through to the existing 404 catch-all. Verified by `static-assets.test.js`.
  - Extension allow-list: `.html`, `.js`, `.css`, `.svg` only. `path.extname(".env")` returns `""` so dotfiles like `.env` are rejected as having no allowed extension — `static-assets-no-traversal.test.js` verifies.
  - Double-decode pass: after the first `decodeURIComponent`, the static handler decodes once more if any `%XX` remains. This catches `%252e%252e` → `%2e%2e` → `..`. After lexical resolve under `web_root`, traversal is caught regardless. Verified.
  - `web/` lives at the project root (not in `src/`) — it's neither TypeScript nor a component. `config/` similarly hosts `runtime.json` and is outside the import-boundary scope.
  - UI: dark theme, system font stack, single page, chat transcript + composer + Re-index button, file count in the top-right status line. Auto-indexes on first load so the user doesn't have to click. `Built on The Personal AI Architecture` footer link per the execute prompt instructions. SSE parsed via `fetch + ReadableStream` (not `EventSource` — that doesn't support POST or custom actor headers).
- **Lessons learned:**
  - The build plan said "loopback-only binding" — that's a *binding* concern, not a *route* concern. The static handler can't observe the remote address from a `GatewayRouteRequest`. Loopback enforcement is in two layers: (a) `scripts/serve.js` only binds `127.0.0.1` and rejects any other `bind_address` from config; (b) the existing template `security-defaults.test.js` already asserts boot-time loopback default. Don't duplicate the check at the handler level — it would only catch synthetic test calls that go through the routes anyway.
  - `EventSource` is the obvious tool for SSE in browsers — and it's wrong here. It only does GET, no custom headers. For a gateway that requires actor headers + accepts POST bodies, hand-roll the SSE parse over `fetch().body.getReader()`. ~40 lines and the architecture stays the way the spec wanted.
- **Drift checks:** `src/engine/` unchanged. `src/` shape: still four PAA components + three shared (`adapters`, `config`, `types`) + two utility (`library`, `tools`). No fifth component. `check:imports` green — `src/gateway/static.ts` only imports Node builtins (`fs`, `path`); `src/gateway/routes.ts` adds an import from `./static` (same component — allowed). `check:contracts` green — no contract changes. `check:lockin` green — outbound-network guard untouched. UI doesn't speak to anything except `localhost:<port>` (same-origin); browser DevTools network tab during a chat will show calls only to that origin. `web/` and `config/` are outside the import-enforcement scope.

**Manual verification path (Phase 5 success criterion 5.8 — user-run):**
1. `ollama serve` (running on `localhost:11434`)
2. `ollama pull qwen2.5:7b`
3. ensure `~/Desktop/BrainDrive Files` exists with at least one `.md` file
4. `npm run serve`
5. open `http://127.0.0.1:4321` in a browser
6. confirm the status line says `<N> files indexed`, type a question, watch the answer stream in
7. add or edit a `.md`, click Re-index, ask another question that reflects the change

---

*Next: Run step 4 (`04-execute.md`) to hand the build plan to the agent and let it run. Run step 5 (`05-test.md`) after each phase to verify. If verification reveals something missed, run step 6 (`06-loop.md`) to update the spec + build plan and try again.*
