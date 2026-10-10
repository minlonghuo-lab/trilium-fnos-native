"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), http = require("node:http"), os = require("node:os"), path = require("node:path"), zlib = require("node:zlib");
const { spawn } = require("node:child_process");
const { before, after, test } = require("node:test");
const { ROOT, adapterName } = require("../trilium-fnos/app/proxy/asset-namespace");
const prefix = "/app/trilium-fnos", port = 19681, backendPort = 19688;
let dir, socketPath, backend, proxy;
const requests = [];
const files = {
  "src/index-fixture.js": 'import "./child.js"; export const dynamic=()=>import("./lazy.js");',
  "src/child.js": 'export const child=1;', "src/lazy.js": 'export const lazy=1;',
  "src/style.css": '@font-face{font-family:test;src:url(./font.woff2)}', "src/font.woff2": "font fixture",
  "assets/worker.js": 'self.onmessage=()=>{};', "stylesheets/theme.css": '@import "./nested.css";', "stylesheets/nested.css": ".note{color:red}"
};
const html = '<html><head><script type="module" src="./src/index-fixture.js"></script><link rel="stylesheet" href="./src/style.css"></head><body>Original Trilium</body></html>';
function request(route, { direct = false, method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(direct ? { hostname: "127.0.0.1", port, path: route, method, headers } : { socketPath, path: prefix + route, method, headers }, res => {
      const chunks = []; res.on("data", b => chunks.push(b)); res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }); req.on("error", reject); req.setTimeout(4000, () => req.destroy(new Error("Test timeout"))); req.end();
  });
}
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tnsi-")); socketPath = path.join(dir, "a.sock");
  for (const [name, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), body); }
  backend = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, encoding: req.headers["accept-encoding"] });
    const p = new URL(req.url, "http://localhost").pathname;
    let body, mime;
    if (p === "/") { body = html; mime = "text/html"; }
    else if (p === "/bootstrap") { body = JSON.stringify({ assetPath: "assets/v0.106.0", loggedIn: false, customThemeCssUrl: "api/notes/download/custom" }); mime = "application/json"; }
    else if (p === "/attachment.html") { body = html; mime = "text/html"; }
    else if (p.startsWith("/api/")) { body = '{ "unchanged": true }'; mime = "application/json"; }
    else { const name = p.replace(/^\/assets\/v0\.106\.0\//, "").replace(/^\//, ""); body = files[name]; if (p.startsWith("/assets/v0.106.0/assets/")) body = undefined; mime = name.endsWith("js") ? "application/javascript" : name.endsWith("css") ? "text/css" : "application/octet-stream"; }
    if (body === undefined) return res.writeHead(404).end();
    // Misbehaving origin sends Brotli even when the proxy asked for identity.
    const compressed = zlib.brotliCompressSync(Buffer.from(body), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
    res.writeHead(200, { "content-type": mime, "content-encoding": "br", "content-length": compressed.length, "cache-control": "public, max-age=31536000", etag: '"old-encoded"' });
    res.end(req.method === "HEAD" ? undefined : compressed);
  });
  await new Promise(resolve => backend.listen(backendPort, "127.0.0.1", resolve));
  proxy = spawn(process.execPath, [path.resolve("trilium-fnos/app/proxy/server.js")], { env: { ...process.env, TRILIUM_BACKEND_PORT: String(backendPort), TRILIUM_PUBLIC_PORT: String(port), TRILIUM_GATEWAY_SOCKET: socketPath, TRILIUM_ASSET_NAMESPACE: "1", TRILIUM_PUBLIC_ASSET_DIR: dir, TRILIUM_IOS_ENTRY: "deferred" }, stdio: ["ignore", "ignore", "pipe"] });
  proxy.stderr.on("data", b => process.stderr.write(b));
  for (let i = 0; i < 60; i++) { try { await request("/"); return; } catch { await new Promise(r => setTimeout(r, 50)); } }
  throw new Error("Proxy did not start");
});
after(async () => {
  if (proxy?.exitCode === null) await new Promise(resolve => { proxy.once("exit", resolve); proxy.kill("SIGTERM"); });
  if (backend) await new Promise(resolve => backend.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});
test("gateway rewrites entry/preloads/styles while direct HTML and attachment bodies keep original resource paths", async () => {
  const page = await request("/", { headers: { "user-agent": "FNAppType/iOS" } });
  assert.ok(page.body.toString().includes(`data-fnos-entry-src=".${ROOT}/src/index-fixture.js"`));
  assert.ok(page.body.toString().includes(`href=".${ROOT}/src/style.css"`));
  assert.ok(page.body.toString().includes(`/__fnos/assets/${adapterName("startup.js")}`));
  assert.match((await request("/", { direct: true })).body.toString(), /src="\.\/src\/index-fixture.js"/);
  const attachment = await request("/attachment.html");
  assert.equal(attachment.body.toString(), html);
});
test("whole static tree uses exact decoded bytes, rejects old validators and does not redirect to cached old addresses", async () => {
  for (const [name, original] of Object.entries(files)) {
    const response = await request(`${ROOT}/${name}`, { headers: { "accept-encoding": "br, gzip", "if-none-match": '"old-encoded"' } });
    assert.equal(response.status, 200, name); assert.equal(response.body.toString(), original, name);
    assert.equal(response.headers["content-encoding"], undefined);
    assert.equal(response.headers.location, undefined);
    assert.equal(response.headers.etag, undefined);
    assert.equal(response.headers["cache-control"], "no-store, no-transform");
  }
  assert.ok(requests.some(r => r.url === "/assets/worker.js" && r.encoding === "identity"));
  assert.equal((await request(`${ROOT}/src/child.js`, { method: "HEAD" })).body.length, 0);
});
test("bootstrap changes only static metadata; direct bootstrap and all API addresses remain unchanged", async () => {
  const response = await request("/bootstrap?mobile");
  assert.deepEqual(JSON.parse(response.body), { assetPath: ROOT.slice(1), loggedIn: false, customThemeCssUrl: "api/notes/download/custom" });
  assert.match(response.headers["cache-control"], /no-store/);
  const direct = await request("/bootstrap", { direct: true });
  assert.equal(JSON.parse(zlib.brotliDecompressSync(direct.body)).assetPath, "assets/v0.106.0");
  assert.equal((await request("/api/sync/updates?cursor=1")).body.toString(), '{ "unchanged": true }');
});
test("unsafe namespace routes never reach API, private files or origin; direct namespace is unavailable", async () => {
  const count = requests.length;
  for (const route of [`${ROOT}/src/%2e%2e/api/options`, `${ROOT}/../../api/options`, `${ROOT}/api/options`, `${ROOT}/src/no.js`, "/__fnos/static/v-old/src/index-fixture.js"]) assert.equal((await request(route)).status, 404, route);
  assert.equal((await request(`${ROOT}/src/child.js`, { method: "POST" })).status, 405);
  assert.equal((await request(`${ROOT}/src/child.js`, { direct: true })).status, 404);
  assert.equal(requests.length, count);
  assert.equal((await request(`/__fnos/assets/${adapterName("startup.js")}`)).status, 200);
});
