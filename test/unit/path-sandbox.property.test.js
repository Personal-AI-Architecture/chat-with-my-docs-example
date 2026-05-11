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

const {
  assertInSandbox,
  PathSandboxError
} = require("../../src/library/path-sandbox.ts");

async function makeRoot() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "path-sandbox-prop-"));
  return fs.realpathSync(root);
}

test("property: assertInSandbox never returns a path outside the root", async () => {
  const root = await makeRoot();
  // pre-populate the root with one valid file so SOME inputs can succeed
  await fsp.writeFile(path.join(root, "valid.md"), "# hi");
  try {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 200 }), (anyInput) => {
        let result = null;
        try {
          result = assertInSandbox(anyInput, root);
        } catch (err) {
          // every rejection MUST be a typed PathSandboxError
          return err instanceof PathSandboxError;
        }
        // if it returned, the canonical path MUST be inside root
        const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
        return result === root || result.startsWith(rootWithSep);
      }),
      { numRuns: 500 }
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("property: inputs that lexically escape the root are rejected with code='out_of_sandbox'", async () => {
  const root = await makeRoot();
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  try {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("..", "subdir", "."), { minLength: 1, maxLength: 8 }),
        (parts) => {
          const candidate = parts.join("/");
          const lexicallyResolved = path.resolve(root, candidate);
          // Only assert against inputs that ACTUALLY escape the root
          // (e.g. "subdir/.." cancels out and legitimately resolves back to root)
          const escapes =
            lexicallyResolved !== root && !lexicallyResolved.startsWith(rootWithSep);
          if (!escapes) return true;
          try {
            assertInSandbox(candidate, root);
            return false; // it escaped — that's a sandbox leak
          } catch (err) {
            return err instanceof PathSandboxError && err.code === "out_of_sandbox";
          }
        }
      ),
      { numRuns: 200 }
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("property: absolute paths outside root are always rejected", async () => {
  const root = await makeRoot();
  try {
    // generate absolute paths under common system roots that are NOT inside our temp root
    const arbForeignAbs = fc.oneof(
      fc.constant("/etc/passwd"),
      fc.constant("/etc/hosts"),
      fc.constant("/var/log/system.log"),
      fc.constant("/usr/bin/env"),
      fc.tuple(
        fc.constantFrom("/tmp", "/var", "/private"),
        fc.string({ minLength: 1, maxLength: 50 })
      ).map(([prefix, rest]) => `${prefix}/${rest.replace(/\0/g, "")}`)
    );
    fc.assert(
      fc.property(arbForeignAbs, (abs) => {
        try {
          assertInSandbox(abs, root);
          return false;
        } catch (err) {
          return err instanceof PathSandboxError;
        }
      }),
      { numRuns: 200 }
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
