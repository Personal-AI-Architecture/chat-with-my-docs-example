# chat-with-my-docs-example

A worked example of building on the [Personal AI Architecture TypeScript template](https://github.com/Personal-AI-Architecture/ts-architecture-template) using the **5-step build workflow** (interview → spec → build plan → execute → test).

The feature: a local, single-user web app that lets you chat with your Markdown notes through a browser. Fully on-device — no cloud calls, no embeddings. Built in five phases, tests-first, with the architecture's conformance check as the safety net.

## What's in this repo

| File / folder | What it is |
|---|---|
| [`docs/interview.md`](docs/interview.md) | The recorded pre-build interview — Q&A, five rounds, plus the summary that produced the spec |
| [`docs/spec.md`](docs/spec.md) | The feature spec produced from the interview |
| [`docs/build-plan.md`](docs/build-plan.md) | The phased build plan (5 phases, tests-first, drift considerations) — and the work log that was filled in as each phase completed |
| [`docs/WALKTHROUGH.md`](docs/WALKTHROUGH.md) | A long-form, phase-by-phase narrative of how the build actually went: commands run, test counts, decisions, mid-phase fixes |
| `src/` | The code: PAA components (`memory/`, `engine/`, `auth/`, `gateway/`), utility folders (`library/`, `tools/`), and shared (`types/`, `adapters/`, `config/`) |
| `web/` | The browser UI — `index.html`, `app.js`, `app.css` (vanilla, no framework) |
| `scripts/serve.js` | HTTP entry point — `node:http` server, binds `127.0.0.1` only |
| `scripts/demo-chat.js` | One-shot chat from the terminal against your real Ollama |
| `test/` | All tests — unit, integration, and conformance |
| `specs/` | OpenAPI for the Gateway API, Engine contract, and Model API |
| `prompts/` | The five-step prompt files (interview, spec, build plan, execute, test) inherited from the template |

## Architecture in one paragraph

The browser hits the Gateway on `127.0.0.1:4321`. The Gateway serves a small HTML/JS UI as static assets, exposes the existing `POST /chat` (SSE-streamed) and a `POST /reindex` control endpoint. Re-index scans `~/Desktop/BrainDrive Files`, builds a Markdown TOC, and writes it to Memory through the Memory tool contract (Auth-approved). On every chat turn the Gateway prepends a system message containing the TOC, then hands off to the existing Agent Loop. The Engine streams via the template's existing `openai-compatible` adapter pointed at `http://localhost:11434/v1`. When the model calls the single registered tool — `read_file(path)` — the executor runs a path-sandboxed filesystem read. **Engine source code is not modified.** No new architectural component, no embedding model, no second API surface.

## Quick start

Prerequisites:

- Node >= 20
- [Ollama](https://ollama.com) running on `localhost:11434`
- A model pulled: `ollama pull qwen2.5:7b` (or edit `config/runtime.json` to use a different one)
- A folder of Markdown files at `~/Desktop/BrainDrive Files` (or edit the path in `config/runtime.json`)

```bash
npm ci
npm run check:conformance   # 16/16 architecture conformance tests should pass
node --test test/unit/*.test.js test/integration/*.test.js test/conformance/*.test.js  # full suite — 158/158
npm run serve               # http://127.0.0.1:4321
```

Open the URL in your browser. The status line will say `<N> files indexed` after the first auto-index. Ask a question; the answer streams in token by token. Add or edit a note in the folder, click **Re-index**, and ask another question.

## Read it in order

If you're learning the workflow, read the artifacts in the order they were produced:

1. [`prompts/01-interview.md`](prompts/01-interview.md) — the interview prompt
2. [`docs/interview.md`](docs/interview.md) — the actual interview that ran
3. [`prompts/02-spec.md`](prompts/02-spec.md) — the spec prompt + template
4. [`docs/spec.md`](docs/spec.md) — the filled-in spec
5. [`prompts/03-build-plan.md`](prompts/03-build-plan.md) — the build plan prompt
6. [`docs/build-plan.md`](docs/build-plan.md) — the actual phased plan + per-phase work log
7. [`prompts/04-execute.md`](prompts/04-execute.md) — the execute prompt
8. [`docs/WALKTHROUGH.md`](docs/WALKTHROUGH.md) — what happened during execute, phase by phase
9. The code itself

## Related

- **The template:** [`Personal-AI-Architecture/ts-architecture-template`](https://github.com/Personal-AI-Architecture/ts-architecture-template) — start here if you want to build your own feature
- **The architecture:** [`Personal-AI-Architecture/the-architecture`](https://github.com/Personal-AI-Architecture/the-architecture) — the architecture spec + drift guards this build matched against
- **Project home:** [personalaiarchitecture.org](https://personalaiarchitecture.org)

## License

MIT — see [`LICENSE`](LICENSE).
