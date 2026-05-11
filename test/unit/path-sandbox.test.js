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
  assertInSandbox,
  PathSandboxError
} = require("../../src/library/path-sandbox.ts");

async function withTempRoot(run) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "path-sandbox-test-"));
  // realpath, in case tmpdir itself resolves through a symlink (macOS does this)
  const realRoot = fs.realpathSync(root);
  try {
    await run(realRoot);
  } finally {
    await fsp.rm(realRoot, { recursive: true, force: true });
  }
}

test("accepts a file inside the root via a relative path", async () => {
  await withTempRoot(async (root) => {
    await fsp.writeFile(path.join(root, "note.md"), "# hi");
    const canonical = assertInSandbox("note.md", root);
    assert.equal(canonical, path.join(root, "note.md"));
  });
});

test("accepts a file inside the root via an absolute path", async () => {
  await withTempRoot(async (root) => {
    const target = path.join(root, "note.md");
    await fsp.writeFile(target, "# hi");
    const canonical = assertInSandbox(target, root);
    assert.equal(canonical, target);
  });
});

test("rejects a relative path that traverses out with ..", async () => {
  await withTempRoot(async (root) => {
    assert.throws(
      () => assertInSandbox("../escape.md", root),
      (err) => err instanceof PathSandboxError && err.code === "out_of_sandbox"
    );
  });
});

test("rejects an absolute path outside the root", async () => {
  await withTempRoot(async (root) => {
    assert.throws(
      () => assertInSandbox("/etc/passwd", root),
      (err) => err instanceof PathSandboxError
    );
  });
});

test("rejects a non-existent path", async () => {
  await withTempRoot(async (root) => {
    assert.throws(
      () => assertInSandbox("does-not-exist.md", root),
      (err) => err instanceof PathSandboxError
    );
  });
});

test("rejects a symlink whose canonical target is outside the root", async () => {
  await withTempRoot(async (root) => {
    // create an "outside" target file in a sibling tmp dir
    const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), "path-sandbox-outside-"));
    const realOutsideDir = fs.realpathSync(outsideDir);
    const outsideTarget = path.join(realOutsideDir, "secret.md");
    await fsp.writeFile(outsideTarget, "secret");
    try {
      const linkPath = path.join(root, "linked.md");
      await fsp.symlink(outsideTarget, linkPath);
      assert.throws(
        () => assertInSandbox("linked.md", root),
        (err) => err instanceof PathSandboxError && err.code === "out_of_sandbox"
      );
    } finally {
      await fsp.rm(realOutsideDir, { recursive: true, force: true });
    }
  });
});

test("rejects a non-.md file when allowedExtensions=['.md']", async () => {
  await withTempRoot(async (root) => {
    await fsp.writeFile(path.join(root, "note.txt"), "plain");
    assert.throws(
      () => assertInSandbox("note.txt", root, { allowedExtensions: [".md"] }),
      (err) => err instanceof PathSandboxError && err.code === "invalid_extension"
    );
  });
});

test("accepts an uppercase .MD when allowedExtensions=['.md'] (case-insensitive)", async () => {
  await withTempRoot(async (root) => {
    await fsp.writeFile(path.join(root, "NOTE.MD"), "# hi");
    const canonical = assertInSandbox("NOTE.MD", root, { allowedExtensions: [".md"] });
    assert.equal(canonical, path.join(root, "NOTE.MD"));
  });
});

test("rejects empty or non-string inputs", () => {
  assert.throws(
    () => assertInSandbox("", "/tmp"),
    (err) => err instanceof PathSandboxError && err.code === "invalid_path"
  );
  assert.throws(
    () => assertInSandbox("foo", ""),
    (err) => err instanceof PathSandboxError && err.code === "invalid_path"
  );
  assert.throws(
    () => assertInSandbox(null, "/tmp"),
    (err) => err instanceof PathSandboxError && err.code === "invalid_path"
  );
});

test("rejects a path with an embedded null byte", async () => {
  await withTempRoot(async (root) => {
    assert.throws(
      () => assertInSandbox("note\0.md", root),
      (err) => err instanceof PathSandboxError
    );
  });
});

test("error messages do not leak the full filesystem path", async () => {
  await withTempRoot(async (root) => {
    try {
      assertInSandbox("../escape.md", root);
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof PathSandboxError);
      assert.equal(typeof err.message, "string");
      // Safe error messages must not echo the requested path back to the caller
      assert.equal(err.message.includes(".."), false, "error message should not echo the unsafe input");
    }
  });
});
