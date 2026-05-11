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
const { formatSystemPromptBody, EMPTY_INDEX_SENTINEL, FILES_INDEX_MARKER } = require("../../src/library/system-prompt-format.ts");
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
      return { approved: true };
    }
    return false;
  };
}

function makeStreamingAdapter(text) {
  return {
    name: "no-tool-mock",
    async *stream() {
      yield { type: "text-delta", delta: { text } };
      yield { type: "done" };
    }
  };
}

function makeBuilder(memoryTools) {
  return {
    async build() {
      const stored = await memoryTools.read(INDEX_KEY);
      return {
        role: "system",
        content: formatSystemPromptBody(stored ? stored.value : null)
      };
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

test("chat works when no index has been written yet (system prompt carries empty sentinel)", async () => {
  const memoryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "chat-no-index-mem-"));
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), "chat-no-index-files-"));
  try {
    const memoryTools = await createMemoryTools({
      memory_root: memoryRoot,
      approvals: { decide: indexApprovalDecider() }
    });

    const toolDef = createReadFileToolDefinition();
    const toolExecutor = createToolExecutor({
      tools: [toolDef],
      handlers: {
        [READ_FILE_TOOL_NAME]: createReadFileHandler({ sandbox_root: fs.realpathSync(folder) })
      },
      allowed_tool_sources: [READ_FILE_SOURCE]
    });

    let capturedSystem = null;
    const adapter = {
      name: "capture-mock",
      async *stream(request) {
        capturedSystem = request.messages[0];
        yield { type: "text-delta", delta: { text: "I have nothing indexed yet." } };
        yield { type: "done" };
      }
    };

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
      body: { content: "hello", metadata: {} }
    });
    assert.equal(response.status, 200);
    const events = await drainStream(response);
    assert.ok(events.some((e) => e.event === "text-delta"));
    assert.ok(events.some((e) => e.event === "done"));

    assert.ok(capturedSystem);
    assert.equal(capturedSystem.role, "system");
    assert.ok(capturedSystem.content.includes(FILES_INDEX_MARKER));
    assert.ok(capturedSystem.content.includes(EMPTY_INDEX_SENTINEL));
  } finally {
    await fsp.rm(memoryRoot, { recursive: true, force: true });
    await fsp.rm(folder, { recursive: true, force: true });
  }
});

test("formatSystemPromptBody renders an empty index with the sentinel and the read_file guidance", () => {
  const body = formatSystemPromptBody(null);
  assert.ok(body.startsWith(FILES_INDEX_MARKER));
  assert.ok(body.includes(EMPTY_INDEX_SENTINEL));
  assert.ok(body.includes("read_file"));
});

test("formatSystemPromptBody renders files with headings", () => {
  const body = formatSystemPromptBody({
    files: [
      { path: "foo.md", headings: [{ level: 1, text: "Foo" }, { level: 2, text: "Sub" }] },
      { path: "bar.md", headings: [] }
    ]
  });
  assert.ok(body.includes("foo.md"));
  assert.ok(body.includes("bar.md"));
  assert.ok(body.includes("# Foo"));
  assert.ok(body.includes("## Sub"));
  assert.equal(body.includes(EMPTY_INDEX_SENTINEL), false);
});
