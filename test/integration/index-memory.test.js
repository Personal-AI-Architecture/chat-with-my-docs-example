const { installTypeScriptRequire } = require("../../scripts/ts-require.js");
const restoreTypeScriptRequire = installTypeScriptRequire();

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

after(() => restoreTypeScriptRequire());

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

async function withTempPaths(run) {
  const memoryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "index-memory-mem-"));
  const folderRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "index-memory-files-"));
  const realFolderRoot = fs.realpathSync(folderRoot);
  try {
    await run({ memoryRoot, folder: realFolderRoot });
  } finally {
    await fsp.rm(memoryRoot, { recursive: true, force: true });
    await fsp.rm(realFolderRoot, { recursive: true, force: true });
  }
}

test("writing the index goes through an Auth-approved memory write and round-trips", async () => {
  await withTempPaths(async ({ memoryRoot, folder }) => {
    await fsp.writeFile(path.join(folder, "alpha.md"), "# Alpha\n## sub");
    await fsp.writeFile(path.join(folder, "beta.md"), "# Beta");

    const memoryTools = await createMemoryTools({
      memory_root: memoryRoot,
      approvals: { decide: indexApprovalDecider() }
    });

    const index = await buildIndex(folder);
    const written = await memoryTools.write(INDEX_KEY, index);
    assert.equal(written.key, INDEX_KEY);
    assert.deepEqual(written.value, index);

    const readBack = await memoryTools.read(INDEX_KEY);
    assert.ok(readBack);
    assert.deepEqual(readBack.value, index);
    assert.equal(readBack.value.files.length, 2);
  });
});

test("re-instantiating MemoryTools on the same memory_root preserves the index (durability)", async () => {
  await withTempPaths(async ({ memoryRoot, folder }) => {
    await fsp.writeFile(path.join(folder, "note.md"), "# durable");

    const writer = await createMemoryTools({
      memory_root: memoryRoot,
      approvals: { decide: indexApprovalDecider() }
    });
    const index = await buildIndex(folder);
    await writer.write(INDEX_KEY, index);

    // simulate process restart: brand-new MemoryTools on same root
    const reader = await createMemoryTools({
      memory_root: memoryRoot,
      approvals: { decide: indexApprovalDecider() }
    });
    const readBack = await reader.read(INDEX_KEY);
    assert.ok(readBack, "index should still be present after restart");
    assert.deepEqual(readBack.value, index);
  });
});

test("writing the index without an explicit approval is denied (gate is real)", async () => {
  await withTempPaths(async ({ memoryRoot, folder }) => {
    await fsp.writeFile(path.join(folder, "note.md"), "# x");
    // No approval decider — default policy denies non-conversation writes
    const memoryTools = await createMemoryTools({ memory_root: memoryRoot });
    const index = await buildIndex(folder);
    await assert.rejects(
      () => memoryTools.write(INDEX_KEY, index),
      /requires approval/i
    );
    const readBack = await memoryTools.read(INDEX_KEY);
    assert.equal(readBack, null, "denied write must not have persisted");
  });
});

test("re-indexing replaces the previous index in Memory and updates updated_at", async () => {
  await withTempPaths(async ({ memoryRoot, folder }) => {
    const memoryTools = await createMemoryTools({
      memory_root: memoryRoot,
      approvals: { decide: indexApprovalDecider() }
    });

    await fsp.writeFile(path.join(folder, "one.md"), "# one");
    const first = await buildIndex(folder);
    const firstWrite = await memoryTools.write(INDEX_KEY, first);

    // add a file, re-index
    await fsp.writeFile(path.join(folder, "two.md"), "# two");
    // small delay to ensure ISO timestamps differ at second resolution if needed
    await new Promise((r) => setTimeout(r, 5));
    const second = await buildIndex(folder);
    const secondWrite = await memoryTools.write(INDEX_KEY, second);

    assert.equal(secondWrite.value.files.length, 2);
    assert.equal(firstWrite.created_at, secondWrite.created_at, "created_at preserved on re-write");
    assert.notEqual(firstWrite.updated_at, secondWrite.updated_at, "updated_at advanced");
  });
});
