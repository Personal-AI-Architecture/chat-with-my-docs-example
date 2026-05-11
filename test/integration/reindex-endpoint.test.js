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
const { buildIndex } = require("../../src/library/file-index.ts");

const INDEX_KEY = "library/index";

function indexApprovalDecider() {
  return (request) => {
    if (request.metadata && request.metadata.key === INDEX_KEY) {
      return { approved: true, reason: "Auto-approved: library index write." };
    }
    return false;
  };
}

function makeReindexHandler({ folder, memoryTools }) {
  return {
    async reindex(_correlationId) {
      let index;
      try {
        index = await buildIndex(folder);
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
}

// Stubs for the unused-by-/reindex slots in the Gateway config
const stubEngineHandler = {
  // eslint-disable-next-line require-yield
  async *handle() {
    throw new Error("engine handler not exercised by /reindex tests");
  }
};

async function buildRoutes({ folder, memoryTools }) {
  const conversationStore = createGatewayConversationStore({ memory: memoryTools });
  return createGatewayRoutes({
    conversation_store: conversationStore,
    engine_handler: stubEngineHandler,
    reindex_handler: makeReindexHandler({ folder, memoryTools })
  });
}

async function withSetup(run, { skipFolder = false } = {}) {
  const memoryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "reindex-endpoint-mem-"));
  const folderRoot = skipFolder
    ? path.join(os.tmpdir(), `reindex-endpoint-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    : await fsp.mkdtemp(path.join(os.tmpdir(), "reindex-endpoint-files-"));
  const realFolder = skipFolder ? folderRoot : fs.realpathSync(folderRoot);
  const memoryTools = await createMemoryTools({
    memory_root: memoryRoot,
    approvals: { decide: indexApprovalDecider() }
  });
  try {
    await run({ memoryRoot, folder: realFolder, memoryTools });
  } finally {
    await fsp.rm(memoryRoot, { recursive: true, force: true });
    if (!skipFolder) {
      await fsp.rm(realFolder, { recursive: true, force: true });
    }
  }
}

const ACTOR_HEADERS = {
  "X-Actor-ID": "local-owner",
  "X-Actor-Permissions": "read_file,memory.read,memory.write"
};

test("POST /reindex without actor headers returns 401 with a safe error", async () => {
  await withSetup(async ({ folder, memoryTools }) => {
    const routes = await buildRoutes({ folder, memoryTools });
    const res = await routes.handle({ method: "POST", path: "/reindex", headers: {}, body: {} });
    assert.equal(res.status, 401);
    assert.ok(res.body && res.body.error);
    assert.equal(typeof res.body.error.code, "string");
    assert.equal(typeof res.body.error.message, "string");
  });
});

test("POST /reindex with actor headers returns 200 and the expected payload", async () => {
  await withSetup(async ({ folder, memoryTools }) => {
    await fsp.writeFile(path.join(folder, "a.md"), "# a");
    await fsp.writeFile(path.join(folder, "b.md"), "# b\n## sub");
    const routes = await buildRoutes({ folder, memoryTools });
    const res = await routes.handle({
      method: "POST",
      path: "/reindex",
      headers: ACTOR_HEADERS,
      body: {}
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.file_count, 2);
    assert.equal(typeof res.body.indexed_at, "string");
    // ISO-8601-ish: must parse to a valid date
    assert.equal(Number.isNaN(Date.parse(res.body.indexed_at)), false);
  });
});

test("POST /reindex writes the index to Memory (verifiable via memoryTools.read)", async () => {
  await withSetup(async ({ folder, memoryTools }) => {
    await fsp.writeFile(path.join(folder, "alpha.md"), "# alpha");
    const routes = await buildRoutes({ folder, memoryTools });
    await routes.handle({
      method: "POST",
      path: "/reindex",
      headers: ACTOR_HEADERS,
      body: {}
    });
    const stored = await memoryTools.read(INDEX_KEY);
    assert.ok(stored, "index must be persisted in memory after /reindex");
    assert.equal(stored.value.files.length, 1);
    assert.equal(stored.value.files[0].path, "alpha.md");
  });
});

test("POST /reindex returns 500 with a safe error when the folder is missing", async () => {
  await withSetup(
    async ({ folder, memoryTools }) => {
      const routes = await buildRoutes({ folder, memoryTools });
      const res = await routes.handle({
        method: "POST",
        path: "/reindex",
        headers: ACTOR_HEADERS,
        body: {}
      });
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "folder_missing");
      // sanitized: no fs path leak
      assert.equal(res.body.error.message.includes(folder), false);
      assert.equal(res.body.error.message.includes(os.tmpdir()), false);
    },
    { skipFolder: true }
  );
});

test("POST /reindex error responses never leak filesystem paths or stack traces", async () => {
  await withSetup(
    async ({ folder, memoryTools }) => {
      const routes = await buildRoutes({ folder, memoryTools });
      const res = await routes.handle({
        method: "POST",
        path: "/reindex",
        headers: ACTOR_HEADERS,
        body: {}
      });
      assert.equal(res.status, 500);
      const text = JSON.stringify(res.body);
      assert.equal(text.includes("at "), false, "no stack frame fragments");
      assert.equal(text.includes(".ts:"), false, "no source-map locations");
      assert.equal(text.includes(folder), false);
      assert.equal(text.includes(os.tmpdir()), false);
    },
    { skipFolder: true }
  );
});

test("GET /reindex returns 404 (only POST is defined)", async () => {
  await withSetup(async ({ folder, memoryTools }) => {
    const routes = await buildRoutes({ folder, memoryTools });
    const res = await routes.handle({
      method: "GET",
      path: "/reindex",
      headers: ACTOR_HEADERS
    });
    assert.equal(res.status, 404);
  });
});
