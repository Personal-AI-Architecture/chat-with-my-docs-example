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
  READ_FILE_MAX_BYTES,
  READ_FILE_SOURCE
} = require("../../src/tools/read-file.ts");
const { createToolExecutor } = require("../../src/engine/tool-executor.ts");

async function withTempRoot(run) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "read-file-tool-test-"));
  const realRoot = fs.realpathSync(root);
  try {
    await run(realRoot);
  } finally {
    await fsp.rm(realRoot, { recursive: true, force: true });
  }
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

function makeContext(perms) {
  return {
    metadata: {
      correlation_id: "corr-test",
      actor_id: "local-owner",
      actor_permissions: perms ?? ["read_file"]
    }
  };
}

test("returns the markdown content for an in-sandbox .md file", async () => {
  await withTempRoot(async (root) => {
    await fsp.writeFile(path.join(root, "note.md"), "# Hello\nworld");
    const executor = makeExecutor(root);
    const [r] = await executor.executeMany(
      [makeCall("c1", { path: "note.md" })],
      makeContext()
    );
    assert.equal(r.ok, true);
    assert.equal(r.content, "# Hello\nworld");
  });
});

test("reads a file given an absolute path inside the sandbox", async () => {
  await withTempRoot(async (root) => {
    const absolute = path.join(root, "abs.md");
    await fsp.writeFile(absolute, "# absolute");
    const executor = makeExecutor(root);
    const [r] = await executor.executeMany(
      [makeCall("c1", { path: absolute })],
      makeContext()
    );
    assert.equal(r.ok, true);
    assert.equal(r.content, "# absolute");
  });
});

test("rejects an out-of-sandbox path with execution_failed and a safe message", async () => {
  await withTempRoot(async (root) => {
    const executor = makeExecutor(root);
    const [r] = await executor.executeMany(
      [makeCall("c1", { path: "../escape.md" })],
      makeContext()
    );
    assert.equal(r.ok, false);
    assert.equal(r.failure_code, "execution_failed");
    assert.equal(r.message, "Tool execution failed.");
  });
});

test("rejects a non-.md extension with execution_failed", async () => {
  await withTempRoot(async (root) => {
    await fsp.writeFile(path.join(root, "note.txt"), "plain");
    const executor = makeExecutor(root);
    const [r] = await executor.executeMany(
      [makeCall("c1", { path: "note.txt" })],
      makeContext()
    );
    assert.equal(r.ok, false);
    assert.equal(r.failure_code, "execution_failed");
  });
});

test("rejects a non-existent path with execution_failed", async () => {
  await withTempRoot(async (root) => {
    const executor = makeExecutor(root);
    const [r] = await executor.executeMany(
      [makeCall("c1", { path: "missing.md" })],
      makeContext()
    );
    assert.equal(r.ok, false);
    assert.equal(r.failure_code, "execution_failed");
  });
});

test("truncates content above the 64 KiB cap and appends a visible marker", async () => {
  await withTempRoot(async (root) => {
    const header = "# Title\n";
    const body = "x".repeat(READ_FILE_MAX_BYTES + 256);
    const original = header + body;
    await fsp.writeFile(path.join(root, "big.md"), original);
    const executor = makeExecutor(root);
    const [r] = await executor.executeMany(
      [makeCall("c1", { path: "big.md" })],
      makeContext()
    );
    assert.equal(r.ok, true);
    assert.ok(r.content.startsWith(header), "preserved file start");
    assert.ok(r.content.length < original.length, "content is bounded");
    assert.ok(r.content.includes("[... truncated"), "truncation marker present");
  });
});

test("does not truncate when content is exactly the cap or smaller", async () => {
  await withTempRoot(async (root) => {
    const content = "x".repeat(READ_FILE_MAX_BYTES);
    await fsp.writeFile(path.join(root, "edge.md"), content);
    const executor = makeExecutor(root);
    const [r] = await executor.executeMany(
      [makeCall("c1", { path: "edge.md" })],
      makeContext()
    );
    assert.equal(r.ok, true);
    assert.equal(r.content, content);
    assert.equal(r.content.includes("[... truncated"), false);
  });
});

test("rejects missing or invalid arguments with execution_failed", async () => {
  await withTempRoot(async (root) => {
    const executor = makeExecutor(root);
    const [a] = await executor.executeMany([makeCall("a", {})], makeContext());
    assert.equal(a.ok, false);
    const [b] = await executor.executeMany([makeCall("b", { path: "" })], makeContext());
    assert.equal(b.ok, false);
    const [c] = await executor.executeMany([makeCall("c", { path: 42 })], makeContext());
    assert.equal(c.ok, false);
  });
});

test("rejects a symlink that escapes the sandbox", async () => {
  await withTempRoot(async (root) => {
    const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), "read-file-tool-outside-"));
    const realOutside = fs.realpathSync(outsideDir);
    try {
      const outsideFile = path.join(realOutside, "secret.md");
      await fsp.writeFile(outsideFile, "secret");
      await fsp.symlink(outsideFile, path.join(root, "linked.md"));
      const executor = makeExecutor(root);
      const [r] = await executor.executeMany(
        [makeCall("c1", { path: "linked.md" })],
        makeContext()
      );
      assert.equal(r.ok, false);
      assert.equal(r.failure_code, "execution_failed");
    } finally {
      await fsp.rm(realOutside, { recursive: true, force: true });
    }
  });
});

test("exposes a canonical tool definition with required permissions and source", () => {
  const def = createReadFileToolDefinition();
  assert.equal(def.type, "function");
  assert.equal(def.function.name, READ_FILE_TOOL_NAME);
  assert.equal(def.source, READ_FILE_SOURCE);
  assert.equal(def.mutates_state, false);
  assert.deepEqual(def.required_permissions, ["read_file"]);
  assert.ok(typeof def.function.description === "string" && def.function.description.length > 0);
  assert.ok(def.function.parameters && def.function.parameters.type === "object");
});
