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
const { createStaticAssetsHandler } = require("../../src/gateway/static.ts");

const stubEngineHandler = {
  // eslint-disable-next-line require-yield
  async *handle() {
    throw new Error("engine handler not exercised");
  }
};

async function withSandboxes(run) {
  const memoryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "static-trav-mem-"));
  const webRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "static-trav-web-"));
  const realWebRoot = fs.realpathSync(webRoot);
  // a sibling "secrets" directory; we never want static to serve from here
  const secrets = await fsp.mkdtemp(path.join(os.tmpdir(), "static-trav-secrets-"));
  const realSecrets = fs.realpathSync(secrets);
  try {
    await fsp.writeFile(path.join(realWebRoot, "index.html"), "<title>Daves-AI</title>");
    await fsp.writeFile(path.join(realWebRoot, "app.js"), "// app");
    await fsp.writeFile(path.join(realSecrets, "secret.html"), "<title>SECRET</title>");
    const memoryTools = await createMemoryTools({ memory_root: memoryRoot });
    const routes = createGatewayRoutes({
      conversation_store: createGatewayConversationStore({ memory: memoryTools }),
      engine_handler: stubEngineHandler,
      static_handler: createStaticAssetsHandler({ web_root: realWebRoot })
    });
    await run({ routes, webRoot: realWebRoot, secrets: realSecrets });
  } finally {
    await fsp.rm(memoryRoot, { recursive: true, force: true });
    await fsp.rm(realWebRoot, { recursive: true, force: true });
    await fsp.rm(realSecrets, { recursive: true, force: true });
  }
}

function ensure404(res) {
  assert.equal(res.status, 404);
  return res;
}

test("rejects raw '..' traversal: GET /../package.json", async () => {
  await withSandboxes(async ({ routes }) => {
    ensure404(await routes.handle({ method: "GET", path: "/../package.json", headers: {} }));
  });
});

test("rejects URL-encoded traversal: GET /%2e%2e/package.json", async () => {
  await withSandboxes(async ({ routes }) => {
    ensure404(await routes.handle({ method: "GET", path: "/%2e%2e/package.json", headers: {} }));
  });
});

test("rejects mixed-case URL-encoded traversal: GET /%2E%2E/package.json", async () => {
  await withSandboxes(async ({ routes }) => {
    ensure404(await routes.handle({ method: "GET", path: "/%2E%2E/package.json", headers: {} }));
  });
});

test("rejects double-encoded traversal: GET /%252e%252e/package.json", async () => {
  await withSandboxes(async ({ routes }) => {
    ensure404(await routes.handle({ method: "GET", path: "/%252e%252e/package.json", headers: {} }));
  });
});

test("rejects an absolute-path-looking request: GET /etc/passwd", async () => {
  await withSandboxes(async ({ routes }) => {
    ensure404(await routes.handle({ method: "GET", path: "/etc/passwd", headers: {} }));
  });
});

test("rejects an attempt to read package.json via the web/ prefix: GET /web/../package.json", async () => {
  await withSandboxes(async ({ routes }) => {
    ensure404(await routes.handle({ method: "GET", path: "/web/../package.json", headers: {} }));
  });
});

test("rejects a symlink whose canonical target is outside the web_root", async () => {
  await withSandboxes(async ({ routes, webRoot, secrets }) => {
    const linkPath = path.join(webRoot, "leak.html");
    await fsp.symlink(path.join(secrets, "secret.html"), linkPath);
    const res = await routes.handle({ method: "GET", path: "/leak.html", headers: {} });
    assert.equal(res.status, 404);
  });
});

test("rejects a null byte in the path", async () => {
  await withSandboxes(async ({ routes }) => {
    const res = await routes.handle({ method: "GET", path: "/app%00.js", headers: {} });
    assert.equal(res.status, 404);
  });
});

test("rejects malformed percent-encodings without crashing", async () => {
  await withSandboxes(async ({ routes }) => {
    const res = await routes.handle({ method: "GET", path: "/%E0%A4%A", headers: {} });
    assert.equal(res.status, 404);
  });
});

test("rejects paths that would resolve to a dotfile in the web_root (e.g. /.env)", async () => {
  await withSandboxes(async ({ routes, webRoot }) => {
    await fsp.writeFile(path.join(webRoot, ".env"), "SECRET=1");
    // .env has no allowed extension (.env is the whole filename); should 404
    const res = await routes.handle({ method: "GET", path: "/.env", headers: {} });
    assert.equal(res.status, 404);
  });
});
