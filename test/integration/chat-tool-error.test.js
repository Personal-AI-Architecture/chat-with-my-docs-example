const { installTypeScriptRequire } = require("../../scripts/ts-require.js");
const restoreTypeScriptRequire = installTypeScriptRequire();

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

after(() => restoreTypeScriptRequire());

const { createGatewayRoutes } = require("../../src/gateway/routes.ts");
const { createGatewayConversationStore } = require("../../src/gateway/conversation-store.ts");
const { createMemoryTools } = require("../../src/memory/tools.ts");
const { createEngineChatHandler } = require("../../src/engine/index.ts");
const { createToolExecutor } = require("../../src/engine/tool-executor.ts");
const { formatSystemPromptBody } = require("../../src/library/system-prompt-format.ts");
const {
  createReadFileToolDefinition,
  createReadFileHandler,
  READ_FILE_TOOL_NAME,
  READ_FILE_SOURCE
} = require("../../src/tools/read-file.ts");

const INDEX_KEY = "library/index";

function indexApprovalDecider() {
  return (request) => {
    if (request.metadata && request.metadata.key === INDEX_KEY) return { approved: true };
    return false;
  };
}

function makeBuilder(memoryTools) {
  return {
    async build() {
      const stored = await memoryTools.read(INDEX_KEY);
      return { role: "system", content: formatSystemPromptBody(stored ? stored.value : null) };
    }
  };
}

async function drainStream(response) {
  const events = [];
  if (!response.stream) return events;
  for await (const event of response.stream) events.push(event);
  return events;
}

const ACTOR_HEADERS = {
  "X-Actor-ID": "local-owner",
  "X-Actor-Permissions": "read_file,memory.read,memory.write"
};

test("a model tool-call with an out-of-sandbox path produces a classified error and a clean stream termination", async () => {
  const memoryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "chat-tool-err-mem-"));
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), "chat-tool-err-files-"));
  const realFolder = fs.realpathSync(folder);
  try {
    await fsp.writeFile(path.join(realFolder, "ok.md"), "# fine");

    const memoryTools = await createMemoryTools({
      memory_root: memoryRoot,
      approvals: { decide: indexApprovalDecider() }
    });

    const adapter = {
      name: "evil-mock",
      async *stream() {
        yield {
          type: "tool-call",
          delta: {
            id: "tc-evil",
            type: "function",
            name: READ_FILE_TOOL_NAME,
            arguments: JSON.stringify({ path: "../escape.md" })
          }
        };
        yield { type: "done" };
      }
    };

    const toolDef = createReadFileToolDefinition();
    const toolExecutor = createToolExecutor({
      tools: [toolDef],
      handlers: { [READ_FILE_TOOL_NAME]: createReadFileHandler({ sandbox_root: realFolder }) },
      allowed_tool_sources: [READ_FILE_SOURCE]
    });

    const engineHandler = createEngineChatHandler({
      model_adapter: adapter,
      tools: [toolDef],
      tool_executor: toolExecutor,
      allowed_tool_sources: [READ_FILE_SOURCE]
    });

    const routes = createGatewayRoutes({
      conversation_store: createGatewayConversationStore({ memory: memoryTools }),
      engine_handler: engineHandler,
      system_prompt_builder: makeBuilder(memoryTools)
    });

    const response = await routes.handle({
      method: "POST",
      path: "/chat",
      headers: ACTOR_HEADERS,
      body: { content: "exfiltrate me", metadata: {} }
    });
    assert.equal(response.status, 200);

    const events = await drainStream(response);

    const toolResult = events.find((e) => e.event === "tool-result");
    assert.ok(toolResult, "expected a tool-result event for the failed tool call");
    assert.equal(typeof toolResult.data.error, "string", "tool-result must carry an error field");
    assert.equal(toolResult.data.error, "execution_failed");

    const errorEvent = events.find((e) => e.event === "error");
    assert.ok(errorEvent, "expected a terminal error event after tool failure");
    assert.equal(errorEvent.data.code, "tool_error");

    // No SERVER-side filesystem paths must leak. The model's own tool arguments
    // ('../escape.md') are echoed back in the tool-call event — that's transparency,
    // not a leak; the UI may surface it. What we forbid is canonical FS paths from
    // the server (sandbox root, os.tmpdir(), stack-trace file frames).
    const allEventJson = JSON.stringify(events);
    assert.equal(allEventJson.includes(realFolder), false, "must not leak the sandbox root path");
    assert.equal(allEventJson.includes(os.tmpdir()), false, "must not leak the os tmpdir");
    assert.equal(/\bat .+:\d+:\d+/.test(allEventJson), false, "must not leak stack-trace file frames");
  } finally {
    await fsp.rm(memoryRoot, { recursive: true, force: true });
    await fsp.rm(realFolder, { recursive: true, force: true });
  }
});
