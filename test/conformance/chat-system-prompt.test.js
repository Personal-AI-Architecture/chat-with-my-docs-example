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
const { formatSystemPromptBody, FILES_INDEX_MARKER } = require("../../src/library/system-prompt-format.ts");
const {
  createReadFileToolDefinition,
  createReadFileHandler,
  READ_FILE_TOOL_NAME,
  READ_FILE_SOURCE
} = require("../../src/tools/read-file.ts");

const INDEX_KEY = "library/index";
const ACTOR_HEADERS = {
  "X-Actor-ID": "local-owner",
  "X-Actor-Permissions": "read_file,memory.read,memory.write"
};

function approveIndexWrites() {
  return (request) => {
    if (request.metadata && request.metadata.key === INDEX_KEY) return { approved: true };
    return false;
  };
}

function drainStreamSync(response) {
  return (async () => {
    const events = [];
    if (!response.stream) return events;
    for await (const event of response.stream) events.push(event);
    return events;
  })();
}

test("conformance: the engine request's first message is system role and carries the Files-index marker", async () => {
  const memoryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "conf-sysprompt-mem-"));
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), "conf-sysprompt-files-"));
  const realFolder = fs.realpathSync(folder);
  try {
    await fsp.writeFile(path.join(realFolder, "alpha.md"), "# Alpha");

    const memoryTools = await createMemoryTools({
      memory_root: memoryRoot,
      approvals: { decide: approveIndexWrites() }
    });
    const { buildIndex } = require("../../src/library/file-index.ts");
    await memoryTools.write(INDEX_KEY, await buildIndex(realFolder));

    let capturedRequest = null;
    const adapter = {
      name: "capture-mock",
      async *stream(request) {
        capturedRequest = request;
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

    const builder = {
      async build() {
        const stored = await memoryTools.read(INDEX_KEY);
        return { role: "system", content: formatSystemPromptBody(stored ? stored.value : null) };
      }
    };

    const routes = createGatewayRoutes({
      conversation_store: createGatewayConversationStore({ memory: memoryTools }),
      engine_handler: engineHandler,
      system_prompt_builder: builder
    });

    const response = await routes.handle({
      method: "POST",
      path: "/chat",
      headers: ACTOR_HEADERS,
      body: { content: "hi", metadata: {} }
    });
    await drainStreamSync(response);

    assert.ok(capturedRequest, "adapter must have been called");
    const firstMessage = capturedRequest.messages[0];
    assert.equal(firstMessage.role, "system", "first message must be role=system");
    assert.ok(
      firstMessage.content.includes(FILES_INDEX_MARKER),
      `system content must contain the marker "${FILES_INDEX_MARKER}" — drift detected`
    );
    assert.ok(firstMessage.content.includes("alpha.md"), "indexed file paths must appear in the prompt");

    // The user message must still be present immediately after the system message
    const userMessage = capturedRequest.messages[1];
    assert.equal(userMessage.role, "user");
    assert.equal(userMessage.content, "hi");
  } finally {
    await fsp.rm(memoryRoot, { recursive: true, force: true });
    await fsp.rm(realFolder, { recursive: true, force: true });
  }
});

test("conformance: when no system_prompt_builder is configured, no system message is injected (engine receives messages as-is)", async () => {
  const memoryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "conf-sysprompt-off-mem-"));
  try {
    const memoryTools = await createMemoryTools({
      memory_root: memoryRoot,
      approvals: { decide: approveIndexWrites() }
    });

    let capturedRequest = null;
    const adapter = {
      name: "capture-mock",
      async *stream(request) {
        capturedRequest = request;
        yield { type: "done" };
      }
    };

    const engineHandler = createEngineChatHandler({
      model_adapter: adapter,
      tools: [],
      allowed_tool_sources: []
    });

    const routes = createGatewayRoutes({
      conversation_store: createGatewayConversationStore({ memory: memoryTools }),
      engine_handler: engineHandler
      // no system_prompt_builder
    });

    const response = await routes.handle({
      method: "POST",
      path: "/chat",
      headers: ACTOR_HEADERS,
      body: { content: "hi", metadata: {} }
    });
    await drainStreamSync(response);

    assert.ok(capturedRequest);
    assert.equal(capturedRequest.messages[0].role, "user", "without a builder, first message must be the user message");
  } finally {
    await fsp.rm(memoryRoot, { recursive: true, force: true });
  }
});
