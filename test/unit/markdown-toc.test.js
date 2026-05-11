const { installTypeScriptRequire } = require("../../scripts/ts-require.js");
const restoreTypeScriptRequire = installTypeScriptRequire();

const assert = require("node:assert/strict");
const { after, test } = require("node:test");

after(() => restoreTypeScriptRequire());

const { parseHeadings } = require("../../src/library/markdown-toc.ts");

test("parses a single H1", () => {
  const headings = parseHeadings("# Hello");
  assert.deepEqual(headings, [{ level: 1, text: "Hello" }]);
});

test("parses nested heading levels", () => {
  const md = "# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six";
  assert.deepEqual(parseHeadings(md), [
    { level: 1, text: "One" },
    { level: 2, text: "Two" },
    { level: 3, text: "Three" },
    { level: 4, text: "Four" },
    { level: 5, text: "Five" },
    { level: 6, text: "Six" }
  ]);
});

test("returns empty array for content with no headings", () => {
  assert.deepEqual(parseHeadings("just some prose\n\nmore prose"), []);
});

test("ignores headings inside fenced code blocks", () => {
  const md = "# Real heading\n\n```\n# not a heading\n## also not\n```\n\n## Real two";
  assert.deepEqual(parseHeadings(md), [
    { level: 1, text: "Real heading" },
    { level: 2, text: "Real two" }
  ]);
});

test("ignores tilde fenced code blocks too", () => {
  const md = "# Real heading\n\n~~~\n# not a heading\n~~~\n\n## Real two";
  assert.deepEqual(parseHeadings(md), [
    { level: 1, text: "Real heading" },
    { level: 2, text: "Real two" }
  ]);
});

test("skips YAML frontmatter", () => {
  const md = "---\ntitle: Foo\n# inside frontmatter is not a heading\n---\n\n# Real heading";
  assert.deepEqual(parseHeadings(md), [{ level: 1, text: "Real heading" }]);
});

test("strips trailing closing hashes", () => {
  assert.deepEqual(parseHeadings("# heading #"), [{ level: 1, text: "heading" }]);
  assert.deepEqual(parseHeadings("## heading ##"), [{ level: 2, text: "heading" }]);
  assert.deepEqual(parseHeadings("### heading ###  "), [{ level: 3, text: "heading" }]);
});

test("preserves unicode and emoji in heading text", () => {
  assert.deepEqual(parseHeadings("# 你好 🎉 hello"), [
    { level: 1, text: "你好 🎉 hello" }
  ]);
});

test("allows up to three leading spaces of indent", () => {
  const md = " # one\n  ## two\n   ### three\n    #### four spaces is a code block";
  assert.deepEqual(parseHeadings(md), [
    { level: 1, text: "one" },
    { level: 2, text: "two" },
    { level: 3, text: "three" }
  ]);
});

test("ignores invalid ATX (no space after hashes)", () => {
  assert.deepEqual(parseHeadings("#NotAHeading"), []);
  assert.deepEqual(parseHeadings("##AlsoNot"), []);
});

test("ignores levels above 6 (####### is not a heading)", () => {
  assert.deepEqual(parseHeadings("####### too many"), []);
});

test("trims whitespace around heading text", () => {
  assert.deepEqual(parseHeadings("#    spacey   "), [{ level: 1, text: "spacey" }]);
});

test("handles CRLF line endings", () => {
  const md = "# A\r\n## B\r\n### C\r\n";
  assert.deepEqual(parseHeadings(md), [
    { level: 1, text: "A" },
    { level: 2, text: "B" },
    { level: 3, text: "C" }
  ]);
});

test("returns empty array for empty input", () => {
  assert.deepEqual(parseHeadings(""), []);
});
