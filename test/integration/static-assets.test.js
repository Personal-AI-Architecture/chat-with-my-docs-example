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

async function withWebRoot(run) {
  const memoryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "static-mem-"));
  const webRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "static-web-"));
  const realWebRoot = fs.realpathSync(webRoot);
  try {
    await fsp.writeFile(
      path.join(realWebRoot, "index.html"),
      "<!doctype html><html><head><title>Daves-AI</title></head><body>hi</body></html>"
    );
    await fsp.writeFile(path.join(realWebRoot, "app.js"), "console.log('app');");
    await fsp.writeFile(path.join(realWebRoot, "app.css"), "body{color:#eee;}");
    const memoryTools = await createMemoryTools({ memory_root: memoryRoot });
    const routes = createGatewayRoutes({
      conversation_store: createGatewayConversationStore({ memory: memoryTools }),
      engine_handler: stubEngineHandler,
      static_handler: createStaticAssetsHandler({ web_root: realWebRoot })
    });
    await run({ routes, webRoot: realWebRoot });
  } finally {
    await fsp.rm(memoryRoot, { recursive: true, force: true });
    await fsp.rm(realWebRoot, { recursive: true, force: true });
  }
}

function bodyString(body) {
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  return typeof body === "string" ? body : JSON.stringify(body);
}

test("GET / returns the index.html with text/html content type and the Daves-AI title", async () => {
  await withWebRoot(async ({ routes }) => {
    const res = await routes.handle({ method: "GET", path: "/", headers: {} });
    assert.equal(res.status, 200);
    assert.ok(res.headers["Content-Type"]);
    assert.ok(/text\/html/i.test(res.headers["Content-Type"]));
    assert.ok(bodyString(res.body).includes("<title>Daves-AI</title>"));
  });
});

test("GET /index.html returns the same asset as GET /", async () => {
  await withWebRoot(async ({ routes }) => {
    const res = await routes.handle({ method: "GET", path: "/index.html", headers: {} });
    assert.equal(res.status, 200);
    assert.ok(bodyString(res.body).includes("Daves-AI"));
  });
});

test("GET /app.js returns the JS file with text/javascript content type", async () => {
  await withWebRoot(async ({ routes }) => {
    const res = await routes.handle({ method: "GET", path: "/app.js", headers: {} });
    assert.equal(res.status, 200);
    assert.ok(/text\/javascript|application\/javascript/i.test(res.headers["Content-Type"]));
    assert.ok(bodyString(res.body).includes("console.log"));
  });
});

test("GET /app.css returns the CSS file with text/css content type", async () => {
  await withWebRoot(async ({ routes }) => {
    const res = await routes.handle({ method: "GET", path: "/app.css", headers: {} });
    assert.equal(res.status, 200);
    assert.ok(/text\/css/i.test(res.headers["Content-Type"]));
    assert.ok(bodyString(res.body).includes("#eee"));
  });
});

test("GET on a non-existent asset returns 404", async () => {
  await withWebRoot(async ({ routes }) => {
    const res = await routes.handle({ method: "GET", path: "/missing.js", headers: {} });
    assert.equal(res.status, 404);
  });
});

test("GET on a disallowed extension returns 404 even if the file exists", async () => {
  await withWebRoot(async ({ routes, webRoot }) => {
    await fsp.writeFile(path.join(webRoot, "evil.exe"), "binary");
    const res = await routes.handle({ method: "GET", path: "/evil.exe", headers: {} });
    assert.equal(res.status, 404);
  });
});

test("static handler does not intercept the API routes (GET /conversations still wins)", async () => {
  await withWebRoot(async ({ routes }) => {
    const res = await routes.handle({ method: "GET", path: "/conversations", headers: {} });
    // Conversations route returns 200 with { conversations: [] }
    assert.equal(res.status, 200);
    assert.ok(res.body && Array.isArray(res.body.conversations));
  });
});

test("POST requests for static-shaped paths are NOT served as static (404 from the catch-all)", async () => {
  await withWebRoot(async ({ routes }) => {
    const res = await routes.handle({
      method: "POST",
      path: "/app.js",
      headers: {},
      body: {}
    });
    assert.equal(res.status, 404);
  });
});

test("static asset responses do not advertise long-lived caching for a prototype build", async () => {
  await withWebRoot(async ({ routes }) => {
    const res = await routes.handle({ method: "GET", path: "/", headers: {} });
    assert.equal(res.status, 200);
    const cacheControl = res.headers["Cache-Control"] ?? res.headers["cache-control"];
    if (cacheControl !== undefined) {
      assert.equal(/max-age=\d{6,}/.test(cacheControl), false, "no long max-age caching");
    }
  });
});

test("static handler with an empty/missing web_root falls through to the catch-all 404", async () => {
  const memoryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "static-no-root-mem-"));
  try {
    const memoryTools = await createMemoryTools({ memory_root: memoryRoot });
    const routes = createGatewayRoutes({
      conversation_store: createGatewayConversationStore({ memory: memoryTools }),
      engine_handler: stubEngineHandler,
      static_handler: createStaticAssetsHandler({
        web_root: path.join(os.tmpdir(), `static-missing-root-${Date.now()}`)
      })
    });
    const res = await routes.handle({ method: "GET", path: "/", headers: {} });
    assert.equal(res.status, 404);
  } finally {
    await fsp.rm(memoryRoot, { recursive: true, force: true });
  }
});
