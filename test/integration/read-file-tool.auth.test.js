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
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "read-file-auth-test-"));
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

function makeExecutor(root, allowedSources = [READ_FILE_SOURCE]) {
  const def = createReadFileToolDefinition();
  return createToolExecutor({
    tools: [def],
    handlers: { [READ_FILE_TOOL_NAME]: createReadFileHandler({ sandbox_root: root }) },
    allowed_tool_sources: allowedSources
  });
}

function makeCall(id, args) {
  return {
    id,
    type: "function",
    function: { name: READ_FILE_TOOL_NAME, arguments: JSON.stringify(args) }
  };
}

const ctx = (perms) => ({
  metadata: { correlation_id: "corr-auth", actor_id: "local-owner", actor_permissions: perms }
});

test("actor with read_file permission can call the tool", async () => {
  await withTempRoot(async (root) => {
    await fsp.writeFile(path.join(root, "note.md"), "# hi");
    const executor = makeExecutor(root);
    const [r] = await executor.executeMany(
      [makeCall("c1", { path: "note.md" })],
      ctx(["read_file"])
    );
    assert.equal(r.ok, true);
  });
});

test("actor with wildcard '*' permission can call the tool", async () => {
  await withTempRoot(async (root) => {
    await fsp.writeFile(path.join(root, "note.md"), "# hi");
    const executor = makeExecutor(root);
    const [r] = await executor.executeMany(
      [makeCall("c1", { path: "note.md" })],
      ctx(["*"])
    );
    assert.equal(r.ok, true);
  });
});

test("actor with unrelated permissions is denied (failure_code='unauthorized') and emits tool_authorization_check deny", async () => {
  await withTempRoot(async (root) => {
    await fsp.writeFile(path.join(root, "note.md"), "# hi");
    const executor = makeExecutor(root);
    await withCapturedAudit(async (captured) => {
      const [r] = await executor.executeMany(
        [makeCall("c1", { path: "note.md" })],
        ctx(["unrelated"])
      );
      assert.equal(r.ok, false);
      assert.equal(r.failure_code, "unauthorized");
      const deny = captured.find(
        (e) =>
          e.action === "tool_authorization_check" &&
          e.outcome === "deny" &&
          e.target === READ_FILE_TOOL_NAME
      );
      assert.ok(deny, "expected tool_authorization_check deny audit entry");
      assert.equal(deny.correlation_id, "corr-auth");
    });
  });
});

test("actor with empty permissions is denied", async () => {
  await withTempRoot(async (root) => {
    await fsp.writeFile(path.join(root, "note.md"), "# hi");
    const executor = makeExecutor(root);
    const [r] = await executor.executeMany(
      [makeCall("c1", { path: "note.md" })],
      ctx([])
    );
    assert.equal(r.ok, false);
    assert.equal(r.failure_code, "unauthorized");
  });
});

test("a call outside allowed_tool_sources is denied with scope_violation", async () => {
  await withTempRoot(async (root) => {
    await fsp.writeFile(path.join(root, "note.md"), "# hi");
    // executor restricts to "memory" tools only — our library tool should NOT be in scope
    const executor = makeExecutor(root, ["memory"]);
    await withCapturedAudit(async (captured) => {
      const [r] = await executor.executeMany(
        [makeCall("c1", { path: "note.md" })],
        ctx(["read_file"])
      );
      assert.equal(r.ok, false);
      assert.equal(r.failure_code, "scope_violation");
      const deny = captured.find(
        (e) =>
          e.action === "tool_scope_check" &&
          e.outcome === "deny" &&
          e.target === READ_FILE_TOOL_NAME
      );
      assert.ok(deny, "expected tool_scope_check deny audit entry");
    });
  });
});
