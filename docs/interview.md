# Interview — Chat With My Docs

> Pre-build alignment interview using the Personal AI Architecture template's [Step 1 — Interview](prompts/01-interview.md) workflow. The goal: gather enough alignment to write a confident spec without inventing details. Output is in [`spec.md`](spec.md).

- **User:** Dave Waring
- **Agent:** Claude (Opus 4.7) running in Claude Code
- **Date:** 2026-05-08
- **Spec written:** 2026-05-11

---

## Round 1 — What are we building?

**Agent:**
1. What do you want to build on this template? One or two sentences in plain language.
2. Who is it for? Just you, you + a small group, public users? How technical are they?
3. What's the pain that pushed you to build this?
4. Is this a prototype or production?

**Dave:**
1. I want to build a chat with your documents app.
2. For me. I want a UI for everything.
3. I want to chat with my documents without having to send any info off my computer to a cloud AI model.
4. Prototype for now, but I would like to make it production in the future.

---

## Round 2 — The shape of the feature

**Agent:**
1. What kinds of documents? PDFs, Markdown, Word, code, plain text, a mix? Roughly how many — tens, hundreds, thousands?
2. How do documents get into the system? Drag-and-drop, point-at-a-folder once, or watch-a-folder?
3. Do you already have a local model running on this machine?
4. Citations: when the AI answers, do you want it to show which document the answer came from?

**Dave:**
1. Let's start with Markdown, but I'd like to be able to add others later.
2. I have a folder on my desktop named `BrainDrive Files` where the files are.
3. Yes, I have Ollama.
4. Just give me the answer is fine for v1.

---

## Round 3 — Behavior and the UI

**Agent:**
1. Conversation history: single rolling chat, or multiple saved conversations?
2. What happens when the folder changes? Auto-detect, manual re-index button, or scan on app start?
3. What Ollama models do you have? We'll need a chat model and an embedding model.
4. UI form factor: local web app at `localhost`, Electron, terminal, etc.?

**Dave:**
1. Single rolling convo at first. We'll add multiple chats later.
2. Re-index button.
3. Let's use `qwen2.5:7b`. Do we need an embedding model? Can't we just have an index of the docs like a table of contents that it crawls?
4. Yes, local web app.

> **Agent then explained two retrieval approaches:**
>
> - **Embedding-based RAG** — chunk every doc, embed chunks, store vectors, do semantic search at query time.
> - **Index/TOC-based** — build a structured index of file paths + heading hierarchy; the LLM gets the TOC and a `read_file` tool to fetch full content when it decides it needs to.
>
> For Markdown specifically, the index approach is genuinely good — Markdown already has structure (`#`, `##`, etc.), so the TOC is rich and meaningful. No second model, no vector store, much simpler. Trade-off: it can miss things where the heading doesn't reflect the body content.
>
> **Recommendation:** index/TOC + read-file-as-tool for v1. Cleaner build, fewer moving parts, maps well onto the PAA architecture. If the corpus outgrows it later, embeddings can be added without a rewrite.

---

## Round 4 — Confirming the retrieval shape and corpus size

**Agent:**
1. Confirm the TOC approach — sound good?
2. Corpus size: how many Markdown files and total folder size?
3. UI layout: chat-only or chat + sidebar with file list?
4. Streaming responses or wait for complete?

**Dave:**
1. Yes.
2. About 20 files and they are not very long.
3. Chat only.
4. Yes, streaming.

---

## Round 5 — Persistence, network, and what's NOT in v1

**Agent:**
1. Conversation persistence across restarts — yes or no?
2. Network access — localhost only (recommended) or LAN-accessible?
3. Lock down "out of scope" — confirm this list of things we're NOT building in v1.

**Dave:**
1. Fresh chat every launch for v1.
2. Yes, localhost only initially.
3. Looks good.

---

## Interview Summary

**Feature:** A local web app that lets Dave chat with his Markdown notes — fully on-device, no cloud, single user.

**Target user:** Dave (you). Technical, wants UI for everything, comfortable with terminal for setup but lives in the UI day-to-day.

**Problem:** Wants an AI advisor that already understands his situation by having read his personal notes — not a generic chatbot operating blind. The privacy constraint (nothing leaves the machine) is what makes that context safe to share in the first place. Today's workaround — pasting selected files into a cloud chat one piece at a time — is laborious, error-prone, and leaks data.

> *Clarified by Dave after the first spec draft: the framing isn't "search for things in my notes." It's "give the AI the context it needs to advise me."*

### Core mechanics

| Decision | Value |
|---|---|
| Document type (v1) | Markdown only |
| Document location | `~/Desktop/BrainDrive Files` (~20 short files) |
| Retrieval approach | TOC/index (file paths + heading hierarchy) injected into context; agent has a `read_file` tool for full content |
| Chat model | Ollama — `qwen2.5:7b` |
| Embedding model | None — TOC + read-file tool replaces it |
| Indexing | Manual re-index button (no folder watcher) |
| Conversation | Single rolling chat |
| Conversation persistence | None — fresh every launch (v1) |
| UI | Chat-only, local web app, browser-based |
| Streaming | Token-by-token (SSE) |
| Citations | No |
| Network | Localhost (`127.0.0.1`) only |
| Auth | Trivial — single local user, no login UI |
| Quality bar | Prototype, path-to-production later |

### PAA component mapping

- **Memory** — stores the file index (TOC), restored across restarts
- **Agent Loop** — runs the chat, handles `read_file` tool calls
- **Auth** — exists architecturally; v1 trusts the local user, no real gating
- **Gateway** — serves the UI + chat API (`POST /messages` with SSE stream) + re-index endpoint
- **External — Model:** Ollama (`qwen2.5:7b`)
- **External — Client:** browser
- **External — Tool:** `read_file(path)` over the BrainDrive Files folder

### Out of scope for v1 (locked)

Cloud models, multi-user/auth login, in-app file editing *(deferred to v1.1)*, in-app upload, non-Markdown files, multiple/saved conversations, citations, mobile/native, folder auto-watch.

### Planned for v1.1 (first follow-on)

After v1 ships, the first capability Dave plans to add is **document editing via the AI** — the AI proposes a diff, Dave approves it in the UI, then it's written to disk. Sandboxed to the same folder as v1. Deferred from v1 because it has a materially bigger blast radius (the AI can alter Dave's own record of past decisions) and needs a real approval UX rather than v1's auto-approve.

### Open questions (deferred to spec or build plan)

- Port number — default to `4321`, flag as configurable
- UI framework — plain HTML/JS vs minimal SPA, decided during build plan
- "Ollama not running" UX — designed during build plan
- Memory approval semantics — v1 auto-approves writes (single trusted user); spec notes the path
- Spec location — root `spec.md` for prototype, or `projects/chat-with-my-docs/spec.md`? Default to root unless instructed otherwise.

---

**Next step:** [`spec.md`](spec.md) — the filled-in spec produced from this interview.
