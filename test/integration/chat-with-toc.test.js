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
const { buildIndex } = require("../../src/library/file-index.ts");
const { formatSystemPromptBody, FILES_INDEX_MARKER } = require("../../src/library/system-prompt-format.ts");
const {
  createReadFileToolDefinition,
  createReadFileHandler,
  READ_FILE_TOOL_NAME,
  READ_FILE_SOURCE
} = require("../../src/tools/read-file.ts");

const INDEX_KEY = "library/index";

function indexApprovalDecider() {
  return (request) => {
    if (request.metadata && request.metadata.key === INDEX_KEY) {
      return { approved: true, reason: "Auto-approved." };
    }
    return false;
  };
}

function createScriptedAdapter(scripts) {
  const captured = [];
  return {
    name: "scripted-mock",
    async *stream(request) {
      captured.push(request);
      const index = Math.min(captured.length - 1, scripts.length - 1);
      const chunks = scripts[index];
      for (const chunk of chunks) {
        yield chunk;
      }
      if (!chunks.some((c) => c.type === "done")) {
        yield { type: "done" };
      }
    },
    getCaptured() {
      return captured;
    }
  };
}

function createIndexReaderBuilder(memoryTools) {
  return {
    async build() {
      const stored = await memoryTools.read(INDEX_KEY);
      const index = stored ? stored.value : null;
      const body = formatSystemPromptBody(index);
      return { role: "system", content: body };
    }
  };
}

async function drainStream(response) {
  const events = [];
  if (!response.stream) return events;
  for await (const event of response.stream) {
    events.push(event);
  }
  return events;
}

async function withSetup(run) {
  const memoryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "chat-toc-mem-"));
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), "chat-toc-files-"));
  const realFolder = fs.realpathSync(folder);
  try {
    await run({ memoryRoot, folder: realFolder });
  } finally {
    await fsp.rm(memoryRoot, { recursive: true, force: true });
    await fsp.rm(realFolder, { recursive: true, force: true });
  }
}

const ACTOR_HEADERS = {
  "X-Actor-ID": "local-owner",
  "X-Actor-Permissions": "read_file,memory.read,memory.write"
};

async function wireFullStack({ folder, memoryRoot, adapter }) {
  const memoryTools = await createMemoryTools({
    memory_root: memoryRoot,
    approvals: { decide: indexApprovalDecider() }
  });
  const index = await buildIndex(folder);
  await memoryTools.write(INDEX_KEY, index);

  const toolDef = createReadFileToolDefinition();
  const toolExecutor = createToolExecutor({
    tools: [toolDef],
    handlers: {
      [READ_FILE_TOOL_NAME]: createReadFileHandler({ sandbox_root: folder })
    },
    allowed_tool_sources: [READ_FILE_SOURCE]
  });

  const engineHandler = createEngineChatHandler({
    model_adapter: adapter,
    tools: [toolDef],
    tool_executor: toolExecutor,
    allowed_tool_sources: [READ_FILE_SOURCE]
  });

  const conversationStore = createGatewayConversationStore({ memory: memoryTools });
  const routes = createGatewayRoutes({
    conversation_store: conversationStore,
    engine_handler: engineHandler,
    system_prompt_builder: createIndexReaderBuilder(memoryTools)
  });

  return { routes, memoryTools };
}

test("full chat loop: system prompt injected, read_file tool called, final assistant text streams", async () => {
  await withSetup(async ({ memoryRoot, folder }) => {
    await fsp.writeFile(path.join(folder, "alpha.md"), "# Alpha\n## intro\nhello world");
    await fsp.writeFile(path.join(folder, "beta.md"), "# Beta\nbody");

    const adapter = createScriptedAdapter([
      [
        {
          type: "tool-call",
          delta: {
            id: "tc-1",
            type: "function",
            name: READ_FILE_TOOL_NAME,
            arguments: JSON.stringify({ path: "alpha.md" })
          }
        },
        { type: "done" }
      ],
      [
        { type: "text-delta", delta: { text: "Your alpha note " } },
        { type: "text-delta", delta: { text: "says hello world." } },
        { type: "done" }
      ]
    ]);

    const { routes } = await wireFullStack({ folder, memoryRoot, adapter });

    const response = await routes.handle({
      method: "POST",
      path: "/chat",
      headers: ACTOR_HEADERS,
      body: { content: "What does alpha say?", metadata: {} }
    });
    assert.equal(response.status, 200);
    const events = await drainStream(response);

    const eventNames = events.map((e) => e.event);
    assert.ok(eventNames.includes("tool-call"), `expected tool-call, got ${eventNames.join(",")}`);
    assert.ok(eventNames.includes("tool-result"), `expected tool-result, got ${eventNames.join(",")}`);
    assert.ok(eventNames.includes("text-delta"), "expected text-delta");
    assert.ok(eventNames.includes("done"), "expected done");

    const calls = adapter.getCaptured();
    assert.ok(calls.length >= 2, `expected at least 2 adapter calls (got ${calls.length})`);

    const firstMessage = calls[0].messages[0];
    assert.equal(firstMessage.role, "system", "first message to model must be system");
    assert.ok(
      firstMessage.content.includes(FILES_INDEX_MARKER),
      "system content must include the Files index marker"
    );
    assert.ok(firstMessage.content.includes("alpha.md"));
    assert.ok(firstMessage.content.includes("beta.md"));

    const textEvents = events.filter((e) => e.event === "text-delta");
    const streamedText = textEvents.map((e) => e.data && e.data.text).join("");
    assert.ok(streamedText.includes("hello world") || streamedText.includes("alpha"));

    const toolResult = events.find((e) => e.event === "tool-result");
    assert.equal(toolResult.data.id, "tc-1");
    assert.ok(toolResult.data.output);
  });
});

test("read_file tool result content reflects the actual file contents", async () => {
  await withSetup(async ({ memoryRoot, folder }) => {
    await fsp.writeFile(path.join(folder, "alpha.md"), "# Alpha\n## intro\nhello world");

    const adapter = createScriptedAdapter([
      [
        {
          type: "tool-call",
          delta: {
            id: "tc-1",
            type: "function",
            name: READ_FILE_TOOL_NAME,
            arguments: JSON.stringify({ path: "alpha.md" })
          }
        },
        { type: "done" }
      ],
      [{ type: "text-delta", delta: { text: "final" } }, { type: "done" }]
    ]);

    const { routes } = await wireFullStack({ folder, memoryRoot, adapter });
    const response = await routes.handle({
      method: "POST",
      path: "/chat",
      headers: ACTOR_HEADERS,
      body: { content: "read alpha", metadata: {} }
    });
    const events = await drainStream(response);
    const toolResult = events.find((e) => e.event === "tool-result");
    assert.ok(toolResult, "expected a tool-result event");
    assert.ok(
      toolResult.data.output && toolResult.data.output.includes("hello world"),
      "tool result must contain the file body"
    );

    // The second adapter call should now include the tool result in messages
    const calls = adapter.getCaptured();
    const secondMessages = calls[1].messages;
    const toolMessage = secondMessages.find((m) => m.role === "tool");
    assert.ok(toolMessage, "second model call must include the tool message");
    assert.ok(toolMessage.content.includes("hello world"));
  });
});
