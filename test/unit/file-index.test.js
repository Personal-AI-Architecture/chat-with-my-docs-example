const { installTypeScriptRequire } = require("../../scripts/ts-require.js");
const restoreTypeScriptRequire = installTypeScriptRequire();

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

after(() => restoreTypeScriptRequire());

const { buildIndex, FileIndexError } = require("../../src/library/file-index.ts");

async function withTempFolder(run) {
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), "file-index-test-"));
  const realFolder = fs.realpathSync(folder);
  try {
    await run(realFolder);
  } finally {
    await fsp.rm(realFolder, { recursive: true, force: true });
  }
}

test("empty folder returns { files: [] }", async () => {
  await withTempFolder(async (folder) => {
    const index = await buildIndex(folder);
    assert.deepEqual(index, { files: [] });
  });
});

test("indexes a single markdown file with headings", async () => {
  await withTempFolder(async (folder) => {
    await fsp.writeFile(path.join(folder, "note.md"), "# Title\n\n## Subtitle\nbody");
    const index = await buildIndex(folder);
    assert.deepEqual(index, {
      files: [
        {
          path: "note.md",
          headings: [
            { level: 1, text: "Title" },
            { level: 2, text: "Subtitle" }
          ]
        }
      ]
    });
  });
});

test("ignores non-markdown files", async () => {
  await withTempFolder(async (folder) => {
    await fsp.writeFile(path.join(folder, "note.md"), "# Real");
    await fsp.writeFile(path.join(folder, "note.txt"), "plain");
    await fsp.writeFile(path.join(folder, "image.png"), "");
    const index = await buildIndex(folder);
    assert.equal(index.files.length, 1);
    assert.equal(index.files[0].path, "note.md");
  });
});

test("ignores dotfiles like .DS_Store and .hidden.md", async () => {
  await withTempFolder(async (folder) => {
    await fsp.writeFile(path.join(folder, ".DS_Store"), "");
    await fsp.writeFile(path.join(folder, ".hidden.md"), "# hidden");
    await fsp.writeFile(path.join(folder, "visible.md"), "# visible");
    const index = await buildIndex(folder);
    assert.equal(index.files.length, 1);
    assert.equal(index.files[0].path, "visible.md");
  });
});

test("recursively indexes markdown in subfolders", async () => {
  await withTempFolder(async (folder) => {
    const sub = path.join(folder, "sub");
    await fsp.mkdir(sub);
    await fsp.writeFile(path.join(folder, "top.md"), "# Top");
    await fsp.writeFile(path.join(sub, "nested.md"), "# Nested");
    const index = await buildIndex(folder);
    const paths = index.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ["sub/nested.md", "top.md"]);
  });
});

test("skips dot-prefixed subfolders", async () => {
  await withTempFolder(async (folder) => {
    const hidden = path.join(folder, ".git");
    await fsp.mkdir(hidden);
    await fsp.writeFile(path.join(hidden, "config.md"), "# secret");
    await fsp.writeFile(path.join(folder, "visible.md"), "# visible");
    const index = await buildIndex(folder);
    assert.equal(index.files.length, 1);
    assert.equal(index.files[0].path, "visible.md");
  });
});

test("returns files in sorted order (deterministic)", async () => {
  await withTempFolder(async (folder) => {
    const names = ["zeta.md", "alpha.md", "mid.md", "beta.md"];
    for (const name of names) {
      await fsp.writeFile(path.join(folder, name), "# x");
    }
    const index = await buildIndex(folder);
    const paths = index.files.map((f) => f.path);
    assert.deepEqual(paths, ["alpha.md", "beta.md", "mid.md", "zeta.md"]);
  });
});

test("throws FileIndexError for a missing folder", async () => {
  await assert.rejects(
    () => buildIndex(path.join(os.tmpdir(), `does-not-exist-${Date.now()}`)),
    (err) => err instanceof FileIndexError && err.code === "folder_missing"
  );
});

test("throws FileIndexError when path points to a file, not a directory", async () => {
  await withTempFolder(async (folder) => {
    const file = path.join(folder, "not-a-dir.md");
    await fsp.writeFile(file, "# hi");
    await assert.rejects(
      () => buildIndex(file),
      (err) => err instanceof FileIndexError && err.code === "not_a_directory"
    );
  });
});

test("does not follow symlinks that exit the folder", async () => {
  await withTempFolder(async (folder) => {
    const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), "file-index-outside-"));
    const realOutside = fs.realpathSync(outsideDir);
    try {
      await fsp.writeFile(path.join(realOutside, "secret.md"), "# secret");
      await fsp.symlink(path.join(realOutside, "secret.md"), path.join(folder, "linked.md"));
      await fsp.writeFile(path.join(folder, "real.md"), "# real");
      const index = await buildIndex(folder);
      const paths = index.files.map((f) => f.path);
      assert.deepEqual(paths, ["real.md"]);
    } finally {
      await fsp.rm(realOutside, { recursive: true, force: true });
    }
  });
});

test("returns a file with empty headings when the markdown has none", async () => {
  await withTempFolder(async (folder) => {
    await fsp.writeFile(path.join(folder, "prose.md"), "just prose, no headings");
    const index = await buildIndex(folder);
    assert.deepEqual(index, {
      files: [{ path: "prose.md", headings: [] }]
    });
  });
});
