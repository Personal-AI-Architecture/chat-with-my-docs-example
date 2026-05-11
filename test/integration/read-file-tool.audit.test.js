const { installTypeScriptRequire } = require("../../scripts/ts-require.js");
const restoreTypeScriptRequire = installTypeScriptRequire();

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

after(() => restoreTypeScriptRequire());

const {
  createReadFileToolDefinition,
  createReadFileHandler,
  READ_FILE_TOOL_NAME,
  READ_FILE_SOURCE
} = require("../../src/tools/read-file.ts");
const { createToolExecutor } = require("../../src/engine/tool-executor.ts");

async function withTempRoot(run) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "read-file-audit-test-"));
  const realRoot = fs.realpathSync(root);
  try {
    await run(realRoot);
  } finally {
    await fsp.rm(realRoot, { recursive: true, force: true });
  }
}

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

function makeExecutor(root) {
  const def = createReadFileToolDefinition();
  return createToolExecutor({
    tools: [def],
    handlers: { [READ_FILE_TOOL_NAME]: createReadFileHandler({ sandbox_root: root }) },
    allowed_tool_sources: [READ_FILE_SOURCE]
  });
}

function makeCall(id, args) {
  return {
    id,
    type: "function",
    function: { name: READ_FILE_TOOL_NAME, arguments: JSON.stringify(args) }
  };
}

const ctx = (perms = ["read_file"]) => ({
  metadata: { correlation_id: "corr-audit", actor_id: "local-owner", actor_permissions: perms }
});

test("successful call emits tool_call 'received' and 'completed' audit entries with the correlation id", async () => {
  await withTempRoot(async (root) => {
    await fsp.writeFile(path.join(root, "note.md"), "# hi");
    const executor = makeExecutor(root);
    await withCapturedAudit(async (captured) => {
      const [r] = await executor.executeMany([makeCall("c1", { path: "note.md" })], ctx());
      assert.equal(r.ok, true);
      const toolCalls = captured.filter(
        (e) => e.action === "tool_call" && e.target === READ_FILE_TOOL_NAME
      );
      const received = toolCalls.find((e) => e.details && e.details.stage === "received");
      const completed = toolCalls.find((e) => e.details && e.details.stage === "completed");
      assert.ok(received, "expected a tool_call 'received' entry");
      assert.ok(completed, "expected a tool_call 'completed' entry");
      assert.equal(received.outcome, "success");
      assert.equal(completed.outcome, "success");
      assert.equal(received.correlation_id, "corr-audit");
      assert.equal(completed.correlation_id, "corr-audit");
      assert.equal(received.actor_id, "local-owner");
    });
  });
});

test("failure call emits a tool_call 'failure' audit entry with diagnostics", async () => {
  await withTempRoot(async (root) => {
    const executor = makeExecutor(root);
    await withCapturedAudit(async (captured) => {
      const [r] = await executor.executeMany(
        [makeCall("c1", { path: "../escape.md" })],
        ctx()
      );
      assert.equal(r.ok, false);
      const failure = captured.find(
        (e) =>
          e.action === "tool_call" &&
          e.outcome === "failure" &&
          e.target === READ_FILE_TOOL_NAME
      );
      assert.ok(failure, "expected a tool_call failure audit entry");
      assert.equal(failure.correlation_id, "corr-audit");
      assert.ok(failure.diagnostics, "expected diagnostics on failure entry");
    });
  });
});

test("client-visible failure message does not echo the requested path, the root, or the file name", async () => {
  await withTempRoot(async (root) => {
    const executor = makeExecutor(root);
    const [r] = await executor.executeMany(
      [makeCall("c1", { path: "../escape.md" })],
      ctx()
    );
    assert.equal(r.ok, false);
    assert.equal(r.message.includes(".."), false);
    assert.equal(r.message.includes(root), false);
    assert.equal(r.message.includes("escape"), false);
    assert.equal(r.message, "Tool execution failed.");
  });
});

test("audit entries carry actor_id and correlation_id consistently across multiple calls", async () => {
  await withTempRoot(async (root) => {
    await fsp.writeFile(path.join(root, "a.md"), "# a");
    await fsp.writeFile(path.join(root, "b.md"), "# b");
    const executor = makeExecutor(root);
    await withCapturedAudit(async (captured) => {
      await executor.executeMany(
        [makeCall("ca", { path: "a.md" }), makeCall("cb", { path: "b.md" })],
        ctx()
      );
      const ours = captured.filter((e) => e.target === READ_FILE_TOOL_NAME);
      assert.ok(ours.length >= 4, `expected >=4 audit entries, got ${ours.length}`);
      for (const entry of ours) {
        assert.equal(entry.correlation_id, "corr-audit");
        assert.equal(entry.actor_id, "local-owner");
      }
    });
  });
});
