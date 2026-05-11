// Daves-AI — minimal browser client for /chat (SSE) and /reindex.
// Uses fetch + ReadableStream (not EventSource) because EventSource cannot
// POST or send custom actor headers.

(() => {
  const ACTOR_HEADERS = {
    "X-Actor-ID": "local-owner",
    "X-Actor-Permissions": "read_file,memory.read,memory.write"
  };

  const transcriptEl = document.getElementById("transcript");
  const statusEl = document.getElementById("status");
  const reindexBtn = document.getElementById("reindex");
  const composerEl = document.getElementById("composer");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("send");

  let isStreaming = false;

  function setStatus(text, state) {
    statusEl.textContent = text;
    if (state) statusEl.dataset.state = state;
    else delete statusEl.dataset.state;
  }

  function setStreaming(streaming) {
    isStreaming = streaming;
    sendBtn.disabled = streaming;
    reindexBtn.disabled = streaming;
  }

  function autoSize() {
    inputEl.style.height = "auto";
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 200)}px`;
  }

  function appendMessage(role) {
    const wrap = document.createElement("div");
    wrap.className = `msg ${role}`;
    const roleEl = document.createElement("div");
    roleEl.className = "msg-role";
    roleEl.textContent = role;
    const body = document.createElement("div");
    body.className = "msg-body";
    wrap.append(roleEl, body);
    transcriptEl.append(wrap);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
    return body;
  }

  function appendText(body, text) {
    body.textContent += text;
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  function appendSystemNote(text, isError = false) {
    const wrap = document.createElement("div");
    wrap.className = isError ? "msg error" : "msg system";
    const roleEl = document.createElement("div");
    roleEl.className = "msg-role";
    roleEl.textContent = isError ? "error" : "system";
    const body = document.createElement("div");
    body.className = "msg-body";
    body.textContent = text;
    wrap.append(roleEl, body);
    transcriptEl.append(wrap);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  // SSE wire format: blocks separated by \n\n, each containing zero or more
  // "event: NAME" and "data: JSON" lines.
  function* parseSseEvents(buffer) {
    let start = 0;
    while (true) {
      const boundary = buffer.indexOf("\n\n", start);
      if (boundary === -1) return { rest: buffer.slice(start) };
      const block = buffer.slice(start, boundary);
      start = boundary + 2;
      const event = { name: "message", data: "" };
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) {
          event.name = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          event.data += (event.data ? "\n" : "") + line.slice(5).trim();
        }
      }
      yield event;
    }
  }

  async function readSseStream(response, onEvent) {
    if (!response.body) {
      throw new Error("Response has no body to read.");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let scan = 0;
      while (true) {
        const boundary = buffer.indexOf("\n\n", scan);
        if (boundary === -1) break;
        const block = buffer.slice(scan, boundary);
        scan = boundary + 2;
        let name = "message";
        let dataAcc = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) {
            dataAcc += (dataAcc ? "\n" : "") + line.slice(5).trim();
          }
        }
        let data = null;
        if (dataAcc) {
          try {
            data = JSON.parse(dataAcc);
          } catch {
            data = { raw: dataAcc };
          }
        }
        onEvent({ name, data });
      }
      buffer = buffer.slice(scan);
    }
  }

  async function sendMessage(content) {
    if (!content.trim() || isStreaming) return;
    setStreaming(true);

    appendMessage("user").textContent = content;
    const assistantBody = appendMessage("assistant");

    let response;
    try {
      response = await fetch("/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...ACTOR_HEADERS
        },
        body: JSON.stringify({
          content,
          metadata: { channel: "web-ui" }
        })
      });
    } catch (err) {
      appendSystemNote(`Network error: ${err && err.message ? err.message : err}`, true);
      setStreaming(false);
      return;
    }

    if (!response.ok) {
      let detail = "";
      try {
        const errBody = await response.json();
        detail = errBody?.error?.message ?? "";
      } catch {
        /* ignore */
      }
      appendSystemNote(
        `Request failed (HTTP ${response.status})${detail ? ": " + detail : ""}.`,
        true
      );
      setStreaming(false);
      return;
    }

    try {
      await readSseStream(response, ({ name, data }) => {
        if (name === "text-delta") {
          const text = typeof data?.text === "string" ? data.text : "";
          if (text) appendText(assistantBody, text);
        } else if (name === "tool-call") {
          appendSystemNote(
            `→ tool call: ${data?.name ?? "unknown"}(${data?.arguments ?? ""})`
          );
        } else if (name === "tool-result") {
          if (data?.error) {
            appendSystemNote(`← tool error: ${data.error}`, true);
          } else {
            const out = typeof data?.output === "string" ? data.output : "";
            const preview =
              out.length > 80 ? out.slice(0, 80) + "…" : out;
            appendSystemNote(`← tool result (${out.length} chars): ${preview}`);
          }
        } else if (name === "error") {
          appendSystemNote(
            `Error: ${data?.code ?? "unknown"}${data?.message ? " — " + data.message : ""}`,
            true
          );
        }
        // "done" and "approval-*" — no UI for v1
      });
    } catch (err) {
      appendSystemNote(
        `Stream interrupted: ${err && err.message ? err.message : err}`,
        true
      );
    } finally {
      setStreaming(false);
    }
  }

  async function reindex() {
    if (isStreaming) return;
    setStreaming(true);
    setStatus("re-indexing…");
    try {
      const response = await fetch("/reindex", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...ACTOR_HEADERS
        },
        body: "{}"
      });
      if (!response.ok) {
        let detail = "";
        try {
          const body = await response.json();
          detail = body?.error?.message ?? "";
        } catch {
          /* ignore */
        }
        setStatus(`re-index failed${detail ? " — " + detail : ""}`, "error");
        return;
      }
      const body = await response.json();
      setStatus(`${body.file_count} files indexed`);
    } catch (err) {
      setStatus(
        `re-index failed — ${err && err.message ? err.message : err}`,
        "error"
      );
    } finally {
      setStreaming(false);
    }
  }

  composerEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const content = inputEl.value;
    inputEl.value = "";
    autoSize();
    sendMessage(content);
  });

  inputEl.addEventListener("input", autoSize);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      composerEl.requestSubmit();
    }
  });

  reindexBtn.addEventListener("click", reindex);

  // Auto-index on first load so the agent has something to work with.
  reindex();
})();
