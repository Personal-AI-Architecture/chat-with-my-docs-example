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
      const index = await buildIndex(folder);
      await memoryTools.write(INDEX_KEY, index);
      return {
        file_count: index.files.length,
        indexed_at: new Date().toISOString()
      };
    }
  };
}

const stubEngineHandler = {
  // eslint-disable-next-line require-yield
  async *handle() {
    throw new Error("engine handler not exercised");
  }
};

function withCapturedAudit(run) {
  const captured = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = function (chunk, ...rest) {
    try {
      const text = typeof chunk === "string" ? chunk : chunk.toString();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj && obj.category && obj.action && obj.outcome && obj.timestamp) {
            captured.push(obj);
          }
        } catch {}
      }
    } catch {}
    return originalWrite(chunk, ...rest);
  };
  return Promise.resolve(run(captured)).finally(() => {
    process.stderr.write = originalWrite;
  });
}

const ACTOR_HEADERS = {
  "X-Actor-ID": "local-owner",
  "X-Actor-Permissions": "read_file,memory.read,memory.write"
};

async function withSetup(run) {
  const memoryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "reindex-audit-mem-"));
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), "reindex-audit-files-"));
  const realFolder = fs.realpathSync(folder);
  const memoryTools = await createMemoryTools({
    memory_root: memoryRoot,
    approvals: { decide: indexApprovalDecider() }
  });
  try {
    await run({ memoryRoot, folder: realFolder, memoryTools });
  } finally {
    await fsp.rm(memoryRoot, { recursive: true, force: true });
    await fsp.rm(realFolder, { recursive: true, force: true });
  }
}

test("a successful re-index emits Memory approval_request + approval_result + write success audit entries", async () => {
  await withSetup(async ({ folder, memoryTools }) => {
    await fsp.writeFile(path.join(folder, "note.md"), "# hi");
    const conversationStore = createGatewayConversationStore({ memory: memoryTools });
    const routes = createGatewayRoutes({
      conversation_store: conversationStore,
      engine_handler: stubEngineHandler,
      reindex_handler: makeReindexHandler({ folder, memoryTools })
    });

    await withCapturedAudit(async (captured) => {
      const res = await routes.handle({
        method: "POST",
        path: "/reindex",
        headers: ACTOR_HEADERS,
        body: {}
      });
      assert.equal(res.status, 200);

      const memoryEntries = captured.filter((e) => e.category === "memory" && e.target === INDEX_KEY);
      const approvalReq = memoryEntries.find((e) => e.action === "approval_request");
      const approvalRes = memoryEntries.find((e) => e.action === "approval_result");
      const writeOk = memoryEntries.find((e) => e.action === "write" && e.outcome === "success");

      assert.ok(approvalReq, "expected memory.approval_request audit entry for the index key");
      assert.ok(approvalRes, "expected memory.approval_result audit entry for the index key");
      assert.equal(approvalRes.outcome, "allow");
      assert.ok(writeOk, "expected memory.write success audit entry");
    });
  });
});

test("the gateway emits a reindex success audit entry carrying actor_id and a correlation_id", async () => {
  await withSetup(async ({ folder, memoryTools }) => {
    await fsp.writeFile(path.join(folder, "note.md"), "# hi");
    const conversationStore = createGatewayConversationStore({ memory: memoryTools });
    const routes = createGatewayRoutes({
      conversation_store: conversationStore,
      engine_handler: stubEngineHandler,
      reindex_handler: makeReindexHandler({ folder, memoryTools })
    });

    await withCapturedAudit(async (captured) => {
      const res = await routes.handle({
        method: "POST",
        path: "/reindex",
        headers: ACTOR_HEADERS,
        body: {}
      });
      assert.equal(res.status, 200);
      const gatewayReindex = captured.find(
        (e) => e.category === "gateway" && e.action === "reindex" && e.outcome === "success"
      );
      assert.ok(gatewayReindex, "expected gateway.reindex success audit entry");
      assert.equal(gatewayReindex.actor_id, "local-owner");
      assert.equal(typeof gatewayReindex.correlation_id, "string");
      assert.ok(gatewayReindex.correlation_id.length > 0);
    });
  });
});

test("a failed re-index (folder missing) emits a gateway.reindex failure audit entry with diagnostics", async () => {
  const memoryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "reindex-audit-fail-mem-"));
  try {
    const memoryTools = await createMemoryTools({
      memory_root: memoryRoot,
      approvals: { decide: indexApprovalDecider() }
    });
    const conversationStore = createGatewayConversationStore({ memory: memoryTools });
    const missingFolder = path.join(os.tmpdir(), `reindex-missing-${Date.now()}`);
    const routes = createGatewayRoutes({
      conversation_store: conversationStore,
      engine_handler: stubEngineHandler,
      reindex_handler: makeReindexHandler({ folder: missingFolder, memoryTools })
    });

    await withCapturedAudit(async (captured) => {
      const res = await routes.handle({
        method: "POST",
        path: "/reindex",
        headers: ACTOR_HEADERS,
        body: {}
      });
      assert.equal(res.status, 500);
      const failure = captured.find(
        (e) => e.category === "gateway" && e.action === "reindex" && e.outcome === "failure"
      );
      assert.ok(failure, "expected gateway.reindex failure audit entry");
      assert.ok(failure.diagnostics, "expected diagnostics on failure entry");
    });
  } finally {
    await fsp.rm(memoryRoot, { recursive: true, force: true });
  }
});

test("audit entries from a /reindex run never include the absolute folder path", async () => {
  await withSetup(async ({ folder, memoryTools }) => {
    await fsp.writeFile(path.join(folder, "note.md"), "# hi");
    const conversationStore = createGatewayConversationStore({ memory: memoryTools });
    const routes = createGatewayRoutes({
      conversation_store: conversationStore,
      engine_handler: stubEngineHandler,
      reindex_handler: makeReindexHandler({ folder, memoryTools })
    });

    await withCapturedAudit(async (captured) => {
      await routes.handle({
        method: "POST",
        path: "/reindex",
        headers: ACTOR_HEADERS,
        body: {}
      });
      // gateway-emitted entries (the new audit) — assert they don't echo the folder path
      const gatewayEntries = captured.filter((e) => e.category === "gateway" && e.action === "reindex");
      for (const entry of gatewayEntries) {
        const json = JSON.stringify(entry);
        assert.equal(json.includes(folder), false, "gateway audit must not leak the folder path");
      }
    });
  });
});
