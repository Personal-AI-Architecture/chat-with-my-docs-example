#!/usr/bin/env node
/**
 * Daves-AI HTTP server.
 *
 * Binds 127.0.0.1:<port> only. Routes /chat (SSE), /reindex (JSON),
 * /conversations*, and serves the static UI from web/.
 *
 * Prerequisites:
 *   - Ollama running on http://localhost:11434
 *   - Model from config/runtime.json pulled (default: qwen2.5:7b)
 *   - Markdown files in config/runtime.json's library.notes_folder
 *
 * Usage:
 *   node scripts/serve.js
 *   open http://127.0.0.1:4321
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const { installTypeScriptRequire } = require("./ts-require.js");

const INDEX_KEY = "library/index";

function expandHome(p) {
  if (typeof p !== "string" || p.length === 0) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function loadRuntimeConfig() {
  const configPath = path.join(__dirname, "..", "config", "runtime.json");
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw);
  parsed.memory_root = expandHome(parsed.memory_root);
  parsed.library = parsed.library ?? {};
  parsed.library.notes_folder = expandHome(parsed.library.notes_folder);
  return parsed;
}

function approveIndexWrites() {
  return (request) => {
    if (request.metadata && request.metadata.key === INDEX_KEY) {
      return { approved: true, reason: "Auto-approved: library index write." };
    }
    return false;
  };
}

function readRequestBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parsePath(url) {
  if (typeof url !== "string" || url.length === 0) return "/";
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

function isLoopbackRequest(req) {
  const remote = req.socket.remoteAddress ?? "";
  return (
    remote === "127.0.0.1" ||
    remote === "::1" ||
    remote === "::ffff:127.0.0.1"
  );
}

async function buildRoutes(runtime) {
  const restore = installTypeScriptRequire();
  try {
    const { createMemoryTools } = require("../src/memory/tools.ts");
    const { createGatewayConversationStore } = require("../src/gateway/conversation-store.ts");
    const { createGatewayRoutes } = require("../src/gateway/routes.ts");
    const { createEngineChatHandler } = require("../src/engine/index.ts");
    const { createToolExecutor } = require("../src/engine/tool-executor.ts");
    const { createOpenAICompatibleAdapter } = require("../src/adapters/openai-compatible.ts");
    const { createStaticAssetsHandler } = require("../src/gateway/static.ts");
    const { buildIndex } = require("../src/library/file-index.ts");
    const { formatSystemPromptBody } = require("../src/library/system-prompt-format.ts");
    const {
      createReadFileToolDefinition,
      createReadFileHandler,
      READ_FILE_TOOL_NAME,
      READ_FILE_SOURCE
    } = require("../src/tools/read-file.ts");

    fs.mkdirSync(runtime.memory_root, { recursive: true });

    const memoryTools = await createMemoryTools({
      memory_root: runtime.memory_root,
      approvals: { decide: approveIndexWrites() }
    });

    const notesFolder = runtime.library.notes_folder;
    const reindexHandler = {
      async reindex() {
        let index;
        try {
          index = await buildIndex(notesFolder);
        } catch (err) {
          const wrapped = new Error("Reindex failed.");
          wrapped.reindex_code =
            err && err.code === "folder_missing"
              ? "folder_missing"
              : err && err.code === "not_a_directory"
                ? "not_a_directory"
                : "internal_error";
          throw wrapped;
        }
        try {
          await memoryTools.write(INDEX_KEY, index);
        } catch (err) {
          const wrapped = new Error("Reindex failed.");
          wrapped.reindex_code = "memory_write_failed";
          throw wrapped;
        }
        return {
          file_count: index.files.length,
          indexed_at: new Date().toISOString()
        };
      }
    };

    const toolDef = createReadFileToolDefinition();
    const toolExecutor = createToolExecutor({
      tools: [toolDef],
      handlers: {
        [READ_FILE_TOOL_NAME]: createReadFileHandler({ sandbox_root: notesFolder })
      },
      allowed_tool_sources: [READ_FILE_SOURCE]
    });

    const adapter = createOpenAICompatibleAdapter({
      api_base_url: runtime.adapter.api_base_url,
      model: runtime.adapter.model
    });

    const engineHandler = createEngineChatHandler({
      model_adapter: adapter,
      tools: [toolDef],
      tool_executor: toolExecutor,
      allowed_tool_sources: [READ_FILE_SOURCE]
    });

    const systemPromptBuilder = {
      async build() {
        const stored = await memoryTools.read(INDEX_KEY);
        return {
          role: "system",
          content: formatSystemPromptBody(stored ? stored.value : null)
        };
      }
    };

    const webRoot = path.join(__dirname, "..", "web");
    const staticHandler = createStaticAssetsHandler({ web_root: webRoot });

    const routes = createGatewayRoutes({
      conversation_store: createGatewayConversationStore({ memory: memoryTools }),
      engine_handler: engineHandler,
      reindex_handler: reindexHandler,
      system_prompt_builder: systemPromptBuilder,
      static_handler: staticHandler
    });

    return { routes, restore };
  } catch (err) {
    restore();
    throw err;
  }
}

function writeBody(res, body) {
  if (body === undefined || body === null) {
    res.end();
    return;
  }
  if (Buffer.isBuffer(body)) {
    res.end(body);
    return;
  }
  if (typeof body === "string") {
    res.end(body);
    return;
  }
  res.end(JSON.stringify(body));
}

async function writeSseStream(res, stream) {
  for await (const event of stream) {
    const name = typeof event?.event === "string" ? event.event : "message";
    const data = event && event.data !== undefined ? JSON.stringify(event.data) : "";
    res.write(`event: ${name}\n`);
    res.write(`data: ${data}\n\n`);
  }
  res.end();
}

async function handleHttpRequest(routes, req, res) {
  if (!isLoopbackRequest(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "forbidden", message: "Loopback only." } }));
    return;
  }

  let bodyValue;
  if (req.method && req.method !== "GET" && req.method !== "HEAD") {
    try {
      const raw = await readRequestBody(req);
      if (raw.length > 0) {
        const contentType = (req.headers["content-type"] ?? "").toLowerCase();
        if (contentType.includes("application/json")) {
          try {
            bodyValue = JSON.parse(raw.toString("utf8"));
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { code: "invalid_json", message: "Body is not valid JSON." } }));
            return;
          }
        } else {
          bodyValue = raw.toString("utf8");
        }
      } else {
        bodyValue = {};
      }
    } catch (err) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "payload_too_large", message: String(err.message || err) } }));
      return;
    }
  }

  const response = await routes.handle({
    method: req.method,
    path: parsePath(req.url),
    headers: req.headers,
    body: bodyValue
  });

  if (response.stream) {
    res.writeHead(response.status, response.headers ?? {});
    try {
      await writeSseStream(res, response.stream);
    } catch (err) {
      console.error("[serve] stream error:", err && err.message ? err.message : err);
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    return;
  }

  res.writeHead(response.status, response.headers ?? {});
  writeBody(res, response.body);
}

async function main() {
  const runtime = loadRuntimeConfig();
  const port = runtime.gateway?.port ?? 4321;
  const bindAddress = runtime.gateway?.bind_address ?? "127.0.0.1";

  if (bindAddress !== "127.0.0.1") {
    console.error(
      `[serve] refusing to bind to ${bindAddress}; only 127.0.0.1 is allowed.`
    );
    process.exitCode = 1;
    return;
  }

  const { routes } = await buildRoutes(runtime);
  const server = http.createServer((req, res) => {
    handleHttpRequest(routes, req, res).catch((err) => {
      console.error("[serve] request error:", err && err.message ? err.message : err);
      try {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
        }
        res.end(JSON.stringify({ error: { code: "internal_error", message: "Server error." } }));
      } catch {
        /* ignore */
      }
    });
  });

  server.listen(port, bindAddress, () => {
    console.log(`[serve] Daves-AI listening on http://${bindAddress}:${port}`);
    console.log(`[serve] notes folder: ${runtime.library.notes_folder}`);
    console.log(`[serve] model: ${runtime.adapter.model} via ${runtime.adapter.api_base_url}`);
  });

  process.on("SIGINT", () => {
    console.log("\n[serve] shutting down…");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { main };
