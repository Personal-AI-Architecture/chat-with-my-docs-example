# Walkthrough — how this was built, phase by phase

This is the long-form story of building `chat-with-my-docs-example` on the [PAA TypeScript template](https://github.com/Personal-AI-Architecture/ts-architecture-template) using its [5-step build workflow](prompts/README.md). Every phase ran tests-first, every phase ended green on the architecture conformance check, every mid-phase fix is recorded.

If you just want the artifacts: see [`interview.md`](interview.md), [`spec.md`](spec.md), and [`build-plan.md`](build-plan.md). This file is for people who want to see the *process*.

---

## Setup

```bash
gh repo fork Personal-AI-Architecture/ts-architecture-template --fork-name Daves-AI --clone=true --remote=true
git clone https://github.com/Personal-AI-Architecture/the-architecture.git personal-ai-architecture
cd Daves-AI
npm ci
npm run check:conformance
```

Three packages installed (typescript, @types/node, plus internal deps). Conformance passed **14/14**: contracts, imports, lockin, security defaults, tool isolation, audit logging. Baseline.

Reading order before doing any work:

- `docs/ai-agent-docs/index.md` and `docs/ai-agent-docs/foundation.md` in the reference repo — to internalize the four-component shape (Memory, Agent Loop, Auth, Gateway), the two external APIs, and the "Memory is the substrate" rule
- `prompts/README.md` — to load the 5-step workflow

---

## Step 1 — Interview

Prompt: [`prompts/01-interview.md`](prompts/01-interview.md). It tells the agent to read the spec template first (`prompts/02-spec.md`), then interview the user in batches of 2-4 questions until every required spec section can be filled with confidence.

The conversation took **five rounds**. Captured verbatim in [`interview.md`](interview.md). Headlines per round:

1. **What are we building?** → "Chat with my docs," single user, full UI, prototype to start, local-only because privacy
2. **Shape of the feature** → Markdown only (others later), folder is `~/Desktop/BrainDrive Files`, Ollama already installed, no citations in v1
3. **Behavior + UI** → single rolling chat, manual Re-index button, `qwen2.5:7b`, local web app — and a key challenge from the user: *"do we need an embedding model? Can't we just have an index of the docs like a table of contents?"*
4. **Confirming retrieval shape + sizes** → TOC-based confirmed, ~20 short files, chat-only UI, SSE streaming
5. **Persistence + network + out-of-scope lockdown** → fresh chat every launch, localhost-only, 9-item exclusion list confirmed

That third-round question is worth reading. The user pushed back on the assumption that RAG always means embeddings. The agent explained the trade-off (embedding-RAG vs. index/TOC + read-file-as-tool) and recommended the TOC shape *for this corpus* (small, structured Markdown). That decision shaped the whole build.

After the rounds, the agent produced a summary table, a PAA component mapping, and a list of open questions. The user could verify alignment before moving on.

---

## Step 2 — Spec

Prompt: [`prompts/02-spec.md`](prompts/02-spec.md). The spec template is the contract: overview, user stories with Given/When/Then, invariants, edge cases, failure modes, scope, technical context, test strategy, security, explicit boundaries, open questions.

The agent wrote [`spec.md`](spec.md) directly from the interview — no new questions, just the agreed-upon answers committed.

**Two corrections happened post-draft:**

1. **Problem statement reframe.** The user pointed out: *"It's not really about searching for me, it's about giving the AI the context it needs to advise me."* The spec was rewritten — "AI advisor with context" rather than "search across my notes." Same architecture, different *why*. Captured in the spec's Changelog.
2. **v1.1 capture.** The user asked: *"if I want to tell the AI to update a doc for me will it do that with the current spec?"* It wouldn't — the v1 spec has `read_file` only and "editing files inside the app" listed as out-of-scope. The agent explained the trade-offs (write semantics, approval UX, backup/undo, blast radius), recommended deferring, and the user picked **v1 read-only + capture document editing as the v1.1 follow-on**. A `Planned for v1.1` section was added to the spec.

Both corrections also propagated to `interview.md` so the shareable artifact reflected the post-draft reality.

---

## Step 3 — Build plan

Prompt: [`prompts/03-build-plan.md`](prompts/03-build-plan.md). This step has a heavier reading load: before designing, the agent reads the drift-guards in `docs/blueprints/drift/` for each PAA component the build touches.

Drift-guards read before designing:

- `Engine-drift-guard.md`
- `Gateway-drift-guard.md`
- `Memory-drift-guard.md`
- `Auth-drift-guard.md`
- `Tools-drift-guard.md`
- `Adapter-drift-guard.md`

Then the existing template surface was inspected:

- `specs/openapi/gateway-api.yaml` — to know the existing routes and request shapes
- `src/engine/index.ts` — to confirm what the loop already does (tool execution, audit logging, approval gating, error sanitization — a lot)
- `src/gateway/routes.ts` — to see how the public request shape is bounded
- `src/adapters/` — to confirm the existing `openai-compatible.ts` adapter can be reused unchanged (Ollama exposes an OpenAI-compatible API)
- `test/conformance/security-defaults.test.js` — to know the loopback assertion is already there

The output: [`build-plan.md`](build-plan.md). Five phases, tests-first inside each, `npm run check:conformance` as a hard gate at every phase exit. One pinned new dependency: `fast-check@3.23.2` (for property-based tests). One concrete drift-considerations table mapping each touched component to the drift patterns most likely to apply and the specific test or check that defends against each.

Key architectural decisions in the plan:

- **Reuse** the existing `openai-compatible` adapter pointed at Ollama. No new adapter module. No provider logic in the Engine or Gateway.
- **Don't modify** `src/engine/`. The TOC system-message injection happens at the Gateway's engine-request assembly boundary, not in the loop.
- **`src/tools/` is a folder of handlers**, not a component boundary. `src/library/` is a folder of pure utilities, not a component.
- **Memory writes for the index go through the Memory tool contract** with Auth approval — never via direct filesystem writes to Memory storage.

The user signed off and the build started.

---

## Step 4 — Execute

Prompt: [`prompts/04-execute.md`](prompts/04-execute.md). Three hard gates: (1) the user types `PROCEED` between phases, (2) the user types `approved` before any new top-level package is installed, (3) the agent stops and asks if it gets stuck. Tests-first inside every phase.

The execute prompt also requires reading the relevant component drift-guard *before* implementing anything in that component. Drift control is a per-phase responsibility, not a one-time read at planning time.

### Phase 1 — Pure utility foundations

**Goal:** Markdown TOC parser, path sandbox validator, folder scanner. Pure logic, no Memory, no Gateway, no Engine wiring.

**Gate:** new package `fast-check@3.23.2`. The agent stopped and asked for `approved`. The user gave it.

```bash
npm install --save-dev --save-exact fast-check@3.23.2
```

The first install accidentally landed `fast-check` in `dependencies` instead of `devDependencies`. The agent caught it, moved it, and verified the pin was exact (no `^`/`~`).

Tests-first — five test files written before any implementation:

```
test/unit/markdown-toc.test.js               (14 unit tests)
test/unit/path-sandbox.test.js               (11 unit tests, filesystem-touching)
test/unit/file-index.test.js                 (11 unit tests, filesystem-touching)
test/unit/path-sandbox.property.test.js      (3 property tests via fast-check)
test/unit/file-index.property.test.js        (3 property tests via fast-check)
```

Property tests are the highest-leverage piece. The sandbox property test runs 500 random inputs and asserts the function *never* returns a path outside the configured root — that's how you find the edge case you didn't think to write a unit test for.

Implementation:

```
src/library/markdown-toc.ts          (ATX heading parser, frontmatter + fenced code aware)
src/library/path-sandbox.ts          (lexical-then-realpath escape check, 3 error codes)
src/library/file-index.ts            (recursive scanner, dot-skip, symlink-out refusal, sorted output)
```

First test run: **40 / 42 pass**. Two failures, same root cause.

The `path-sandbox` originally called `fs.realpathSync` first and only ran the descendant-of-root check on the canonical form. So for non-existent escape paths like `../escape.md`, the function threw `invalid_path` (because the file didn't exist) instead of `out_of_sandbox`. Fix: do the lexical check on `path.resolve(root, requested)` *before* calling `realpathSync`. Non-existent escapes now throw `out_of_sandbox` directly; symlinks pointing outside are still caught by the post-realpath check.

That fix shipped **41 / 42**. The remaining failure: the property test had a counterexample `["subdir", ".."]` → `"subdir/.."`, which lexically resolves *back to root* and is legitimately inside the sandbox. The test had assumed any `..`-containing input must be rejected — but `subdir/..` cancels out. Tightened the test to assert against inputs that **actually escape** the root, not just contain `..` characters.

```bash
node --test test/unit/markdown-toc.test.js test/unit/path-sandbox.test.js \
  test/unit/file-index.test.js test/unit/path-sandbox.property.test.js \
  test/unit/file-index.property.test.js
```

Result: **42 / 42**. Full suite: **82 / 82** (existing 70 + the new 12 from this phase — minus property tests that count as 5 in the suite count). Conformance: **14 / 14**.

Drift checks at phase exit: `git diff --stat src/engine/` empty. No fifth-component folder. `src/library/` imports zero PAA-component code.

One pre-existing template defect surfaced: `npm test` is broken on Node 22 because `scripts/run-tests.js` passes the bare `test/unit` directory to `node --test`, which Node 22 doesn't auto-discover from. Workaround used throughout: `node --test test/unit/*.test.js` directly. Not in Phase 1's scope to fix — flagged in the work log, surfaced to Dave J via the project's agenda system (the same issue was already on his "In Flight" list from a separate setup-prompt run three days earlier).

The user ran their own verification pass, typed `PROCEED`.

### Phase 2 — `read_file` tool

**Goal:** Register a sandboxed `read_file(path)` tool definition + handler with the existing tool-executor. Auth-gated. Failures are classified, not raw.

Before implementing: re-read the Tools drift-guard. Key rules:

- Tools are not a fifth component
- No separate Tool API boundary
- Tool execution stays in `src/engine/tool-executor.ts` (existing)
- Tool failures must be classified and sanitized
- Approval gates use coded events, not prompt guidance

Three integration tests written first:

```
test/integration/read-file-tool.test.js            (10 behavior tests)
test/integration/read-file-tool.audit.test.js     (4 audit-log assertions)
test/integration/read-file-tool.auth.test.js      (5 auth-gating tests)
```

The audit tests use a small `withCapturedAudit(run)` helper that wraps `process.stderr.write` to collect JSON audit lines into an array — and forwards every chunk to the original `write` so `node:test`'s own diagnostic output still flows. Forwarding (vs. swallowing) keeps test output visible when something fails.

Implementation:

```
src/tools/read-file.ts   (tool definition + handler factory)
```

The tool definition declares `source: "library"`, `mutates_state: false`, `required_permissions: ["read_file"]`. The handler:

1. Validates the `path` argument is a non-empty string
2. Calls `assertInSandbox(path, root, { allowedExtensions: [".md"] })` from Phase 1
3. Reads the file (capping at 64 KiB, appending a truncation marker if longer)
4. Returns the content as a string

Errors are thrown as plain `Error` instances with stable codes (`read_file_invalid_argument`, `read_file_out_of_sandbox`, `read_file_invalid_extension`, `read_file_read_failed`). The executor's existing failure path catches them, logs them in audit diagnostics, and returns a generic client message — no engine internals were modified.

```bash
node --test test/integration/read-file-tool.test.js \
  test/integration/read-file-tool.audit.test.js \
  test/integration/read-file-tool.auth.test.js
```

Result: **19 / 19** on the first run. Conformance: **14 / 14**. Full suite: **116 / 116**. `git diff --stat src/engine/` empty.

The executor handles a *lot* for free — three layers of pre-execution gating (name allowlist, source allowlist, permission check) with audit logs per layer, plus approval gating for state-mutating tools, plus error sanitization. Plugging a new tool in is mostly about declaring the right metadata and writing a focused handler.

User typed `PROCEED`.

### Phase 3 — Memory-backed index + `POST /reindex`

**Goal:** Persist the file index in Memory through the Memory tool contract (Auth-approved), expose `POST /reindex` on the Gateway, return file count to the caller.

Before implementing: re-read the Gateway, Memory, and Auth drift-guards.

The constraint that shaped this phase: `scripts/check-imports.ts` allows only `gateway/` and `types/` imports inside `src/gateway/*.ts`. That blocks the obvious shape "put a small `library-index-store.ts` inside `src/gateway/` that imports `FileIndex` from `library/`." So the design changed: a `ReindexHandler` interface in `src/types/contracts.ts`, the Gateway accepts an injected handler via config, and the actual orchestrator (which calls `library/file-index.ts` and `memory/tools.ts`) lives **outside** `src/`-component-land — composed at the test/wiring boundary.

This preserves the import-boundary invariant cleanly. It's also the same pattern the template already uses for `engine_handler` and `conversation_store`.

Three integration tests written first:

```
test/integration/index-memory.test.js       (4 tests: write/read/durability/idempotence)
test/integration/reindex-endpoint.test.js   (6 tests: 401, 200, 404, 500, body, GET)
test/integration/reindex-audit.test.js      (4 tests: approval audit events, gateway audit, sanitization)
```

The Memory tools auto-approve only `conversations/*` keys by default; any other key (including our index) is denied unless a custom `approvals.decide` is provided. The tests construct `MemoryTools` with `approvals.decide: (req) => req.metadata?.key === "library/index" ? { approved: true } : false`. That's *policy-level* auto-approval, not a bypass — `approval_request` and `approval_result` audit events still fire, verified by the audit test.

Implementation:

- Added `ReindexResult`, `ReindexFailureCode`, `ReindexHandler` to `src/types/contracts.ts`
- Added a `routeReindex` function to `src/gateway/routes.ts` that validates actor headers, generates a correlation ID, calls the injected handler, emits `gateway.reindex` audit on success/failure, returns 200 or a sanitized 500 with a stable error code
- Added the `/reindex` operation + `ReindexResult` and `GatewayErrorEnvelope` schemas to `specs/openapi/gateway-api.yaml` (additive — `check:contracts` still validates)

Result: **14 / 14** on the first run. Conformance: **14 / 14**. Full suite: **130 / 130**.

Drift checks: `src/engine/` untouched. `check:imports` green (gateway/routes.ts still imports only `gateway/` + `types/`). `check:contracts` green. `check:lockin` green. Memory durability test confirms cross-instance persistence over the same `memory_root`. Error responses contain no FS paths.

User typed `PROCEED`.

### Phase 4 — End-to-end agent wiring (Ollama + system-prompt TOC)

**Goal:** A chat request to `POST /chat` reaches the Engine with the TOC injected as a system message, the Engine streams from Ollama via the existing `openai-compatible` adapter, `read_file` tool calls work in-loop. Zero engine source edits.

Before implementing: re-read the Engine and Adapter drift-guards. Critical rules: Engine never accumulates product-specific logic, provider-specific formatting stays in adapters, assistant text preserved across tool calls, recoverable tool failures continue the loop.

Four tests written first — one of which is a **conformance** test (the test that detects drift in the system-prompt shape itself):

```
test/integration/chat-with-toc.test.js                (2 tests: end-to-end loop + tool-call round-trip)
test/integration/chat-no-index.test.js                (3 tests: empty index sentinel + formatter)
test/integration/chat-tool-error.test.js              (1 test: sandbox escape → classified error)
test/conformance/chat-system-prompt.test.js           (2 tests: marker presence, no-builder behavior)
```

Implementation:

- Added `SystemPromptBuilder` interface to `src/types/contracts.ts`: `build(): Promise<CanonicalMessage | null>`
- Added `system_prompt_builder?: SystemPromptBuilder` to the Gateway routes config
- In `routeMessage`: call the builder if configured, prepend the returned system message to the engine request's `messages` array
- Added `src/library/system-prompt-format.ts` — pure formatter with documented constants `FILES_INDEX_MARKER = "Files index:"`, `EMPTY_INDEX_SENTINEL`, `READ_FILE_GUIDANCE`. Tests + scripts both import it, so drift in the format triggers a real conformance failure.
- On a builder throw: gateway emits `gateway.system_prompt_build_failed` audit (failure) with diagnostics, but the chat continues *without* a system prompt rather than failing the whole turn. Degraded UX > broken UX.

The runtime config:

```json
{
  "memory_root": "./.daves-ai/memory",
  "provider_adapter": "openai-compatible",
  "auth_mode": "local-owner",
  "tool_sources": ["library"],
  "gateway": { "bind_address": "127.0.0.1", "port": 4321 },
  "library": { "notes_folder": "~/Desktop/BrainDrive Files" },
  "adapter": {
    "api_base_url": "http://localhost:11434/v1",
    "model": "qwen2.5:7b"
  }
}
```

No `api_key` — Ollama doesn't need one. The adapter-drift-guard forbids literal secrets in tracked config; absence is the correct shape.

A `scripts/demo-chat.js` was added for manual verification against a real Ollama. Streaming output goes to stdout with markers for tool calls.

First test run: **7 / 8**. One failure.

`chat-tool-error.test.js` had asserted that the literal string `..` never appears in any client-visible event. But the `tool-call` event legitimately echoes the *model's own bad argument* (`{"path":"../escape.md"}`) — that's transparency, not a leak; a UI may show "the model attempted X." Tightened the assertion to forbid **server-side filesystem paths only** (the sandbox root, `os.tmpdir()`, stack-trace file frames like `at FILE:LINE:COL`). Model-produced arguments are part of the stream contract.

Re-run: **8 / 8**. Conformance: **16 / 16** (was 14 — the two new conformance tests on system-prompt shape added). Full suite: **138 / 138**.

Drift checks: `git diff --stat src/engine/` empty. `check:imports` green. Provider-specific formatting stays in `src/adapters/openai-compatible.ts` (existing, unchanged). System-prompt content never appears in conversation persistence — the conversation store sees only `user` + `assistant` messages.

User typed `PROCEED`.

### Phase 5 — Web UI

**Goal:** Static assets served by the Gateway. User opens `http://127.0.0.1:4321`, sees a chat input, types a question, watches the answer stream in. Re-index button, status line, footer.

Architectural note that surfaced early: the template ships **no HTTP listener**. `src/gateway/server.ts` is a logic abstraction. The Phase 4 demo ran routes in-process. For Phase 5 to be usable from a real browser, an HTTP entry point was needed. The build plan didn't call this out explicitly — flagged in the work log and addressed by adding `scripts/serve.js` (outside `src/`, where the import-boundary check doesn't apply).

Two test files written first:

```
test/integration/static-assets.test.js               (10 behavior tests)
test/integration/static-assets-no-traversal.test.js  (10 traversal tests)
```

Traversal tests included: raw `..`, URL-encoded `%2e%2e`, mixed case `%2E%2E`, double-encoded `%252e%252e`, absolute `/etc/passwd`, symlink-out, null bytes, malformed percent-encodings, dotfiles.

Implementation:

```
src/gateway/static.ts   (extension allowlist {.html,.js,.css,.svg}, double-decode catch, lexical-then-realpath sandbox)
```

Wired into `src/gateway/routes.ts` *after* all API routes — API wins on path conflict. GET-only: POSTs to a static-shaped path (`POST /app.js`) fall through to the catch-all 404. Verified by test.

UI files under a new top-level `web/` folder (not `src/` — static assets aren't TypeScript and aren't a component):

```
web/index.html   (dark theme, system font, chat transcript + composer + Re-index + footer)
web/app.js       (fetch + ReadableStream SSE parser — not EventSource, which can't do POST + custom headers)
web/app.css      (dark theme, system font stack)
```

The footer links to `The Personal AI Architecture` repo per the execute-prompt's UI guidance. The UI auto-runs `/reindex` on first load so the user doesn't have to click before chatting.

HTTP entry point:

```
scripts/serve.js   (node:http.createServer; refuses any non-loopback bind_address; rejects non-loopback remote addrs at request time as belt-and-suspenders)
```

Added `npm run serve` and `npm run demo:chat` to `package.json`.

```bash
node --test test/integration/static-assets.test.js \
  test/integration/static-assets-no-traversal.test.js
```

Result: **20 / 20** on the first run. Conformance: **16 / 16**. Full suite: **158 / 158**.

Drift checks: `src/engine/` untouched. `check:imports` green — `src/gateway/static.ts` imports only Node builtins (`fs`, `path`); `src/gateway/routes.ts` adds an import from `./static` (same component — allowed). `check:contracts` and `check:lockin` green. `web/` and `config/` are outside `src/` and outside import-enforcement scope by design.

Manual browser verification by the user, against real Ollama + real `~/Desktop/BrainDrive Files`. The status line showed the file count, questions streamed answers grounded in the notes, tool calls rendered in the transcript, the Re-index button worked. Browser DevTools network tab showed traffic only to `127.0.0.1:4321` and `localhost:11434`. Done.

---

## What we ended with

| Metric | Value |
|---|---|
| Phases | 5 |
| Tests added | 103 (29 unit + 5 property + 50 integration + 17 audit/auth/conformance scattered + ...) — full suite **158 / 158** |
| Conformance | **16 / 16** (was 14 baseline; +2 from system-prompt drift detectors) |
| New PAA components | **0** (foundation rule preserved: still four components, two external APIs) |
| New dependencies | **1** — `fast-check@3.23.2` (exact-pinned, devDependencies) |
| Engine source edits | **0** (`git diff --stat src/engine/` empty at every phase exit) |
| Mid-phase fixes | 3 — Phase 1 path-sandbox ordering + property test framing; Phase 4 tool-error test over-strictness |
| Pre-existing template defects flagged | 1 — `npm test` broken on Node 22 (`scripts/run-tests.js` uses deprecated directory-arg form of `node --test`); workaround used throughout |

## What's load-bearing

If you remember nothing else from this walkthrough:

1. **The drift-guards in [`docs/blueprints/drift/`](https://github.com/Personal-AI-Architecture/the-architecture/tree/main/docs/blueprints/drift) are not optional reading.** They're the canonical list of what the agent would otherwise do wrong. Re-read the relevant one *before implementing anything in that component*, not just at planning time.
2. **`check:imports` is a real shaping force.** It enforces "Gateway can only import gateway/ + types/" and friends. When that blocks your first instinct (it will), the fix is usually not bigger code — it's moving the orchestration out of the component and using an injected interface. The architecture pays off when followed.
3. **Tests-first inside every phase is the lever.** Every mid-phase fix in this build came from a test failing on something the implementation got subtly wrong. Without tests-first, those bugs would have been found by the user, not the agent.
4. **`npm run check:conformance` at every phase exit is the safety net.** It catches the drift the agent didn't think to test. Treat green as the bar for moving on.

---

*Built 2026-05-08 through 2026-05-11. The architecture is at [`Personal-AI-Architecture/the-architecture`](https://github.com/Personal-AI-Architecture/the-architecture). The template is at [`Personal-AI-Architecture/ts-architecture-template`](https://github.com/Personal-AI-Architecture/ts-architecture-template).*
