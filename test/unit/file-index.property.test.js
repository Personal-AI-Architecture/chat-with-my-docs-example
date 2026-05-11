const { installTypeScriptRequire } = require("../../scripts/ts-require.js");
const restoreTypeScriptRequire = installTypeScriptRequire();

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");
const fc = require("fast-check");

after(() => restoreTypeScriptRequire());

const { buildIndex } = require("../../src/library/file-index.ts");

const FILENAME_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_".split("");

const filenameArb = fc
  .array(fc.constantFrom(...FILENAME_CHARS), { minLength: 1, maxLength: 16 })
  .map((chars) => chars.join(""));

const headingLineArb = fc
  .tuple(fc.integer({ min: 1, max: 6 }), fc.string({ minLength: 1, maxLength: 30 }))
  .map(([level, text]) => {
    const safeText = text.replace(/[\r\n]/g, " ").trim() || "h";
    return `${"#".repeat(level)} ${safeText}`;
  });

const fileContentArb = fc.array(headingLineArb, { minLength: 0, maxLength: 6 }).map((lines) =>
  lines.join("\n")
);

const fileRecordArb = fc.record({
  name: filenameArb,
  content: fileContentArb
});

const fileSetArb = fc.uniqueArray(fileRecordArb, {
  selector: (r) => r.name.toLowerCase(),
  minLength: 0,
  maxLength: 6
});

test("property: building the index twice on the same folder yields deep-equal results", async () => {
  await fc.assert(
    fc.asyncProperty(fileSetArb, async (files) => {
      const folder = await fsp.mkdtemp(path.join(os.tmpdir(), "file-index-prop-"));
      const realFolder = fs.realpathSync(folder);
      try {
        for (const f of files) {
          await fsp.writeFile(path.join(realFolder, `${f.name}.md`), f.content);
        }
        const first = await buildIndex(realFolder);
        const second = await buildIndex(realFolder);
        assert.deepEqual(first, second);
        return true;
      } finally {
        await fsp.rm(realFolder, { recursive: true, force: true });
      }
    }),
    { numRuns: 30 }
  );
});

test("property: the file count in the index equals the number of .md files written", async () => {
  await fc.assert(
    fc.asyncProperty(fileSetArb, async (files) => {
      const folder = await fsp.mkdtemp(path.join(os.tmpdir(), "file-index-prop-count-"));
      const realFolder = fs.realpathSync(folder);
      try {
        for (const f of files) {
          await fsp.writeFile(path.join(realFolder, `${f.name}.md`), f.content);
        }
        const index = await buildIndex(realFolder);
        return index.files.length === files.length;
      } finally {
        await fsp.rm(realFolder, { recursive: true, force: true });
      }
    }),
    { numRuns: 30 }
  );
});

test("property: index file paths are returned in sorted order", async () => {
  await fc.assert(
    fc.asyncProperty(fileSetArb, async (files) => {
      const folder = await fsp.mkdtemp(path.join(os.tmpdir(), "file-index-prop-sort-"));
      const realFolder = fs.realpathSync(folder);
      try {
        for (const f of files) {
          await fsp.writeFile(path.join(realFolder, `${f.name}.md`), f.content);
        }
        const index = await buildIndex(realFolder);
        const paths = index.files.map((f) => f.path);
        const sorted = [...paths].sort();
        assert.deepEqual(paths, sorted);
        return true;
      } finally {
        await fsp.rm(realFolder, { recursive: true, force: true });
      }
    }),
    { numRuns: 30 }
  );
});
