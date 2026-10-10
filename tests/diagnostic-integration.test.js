"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { before, after, test } = require("node:test");
const root = path.resolve(__dirname, "..");
const backendPort = 19779;
const publicPort = 19778;
const prefix = "/app/trilium-fnos";
let backend, proxy, directory, socketPath;
let output = "";
let requests = 0;

function request(route, { gateway = true, method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(gateway ? { socketPath, host: "nas.example", path: prefix + route, method, headers } : { host: "127.0.0.1", port: publicPort, path: route, method, headers }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "td-"));
  socketPath = path.join(directory, "a.sock");
  backend = http.createServer((req, res) => {
    requests++;
    if (req.url.startsWith("/src/")) {
      res.writeHead(200, { "content-type": req.url.includes(".css") ? "text/css" : "application/javascript" });
      return res.end("/* public unchanged */");
    }
    if (req.url === "/bootstrap") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end('{"secret":"private bootstrap data"}');
    }
    res.writeHead(200, { "content-type": "text/html", "content-security-policy": "default-src 'self'; frame-ancestors 'self'" });
    res.end('<html><head><script type="module" crossorigin src="./src/index-test.js"></script><link rel="modulepreload" href="./src/font-test.js"></head><body><div id="splash">loading</div></body></html>');
  });
  await new Promise(resolve => backend.listen(backendPort, "127.0.0.1", resolve));
  proxy = spawn(process.execPath, [path.join(root, "trilium-fnos/app/proxy/server.js")], {
    env: { ...process.env, TRILIUM_IOS_ENTRY: "deferred", TRILIUM_STARTUP_DIAGNOSTICS: "1", TRILIUM_PUBLIC_PORT: String(publicPort), TRILIUM_BACKEND_PORT: String(backendPort), TRILIUM_GATEWAY_SOCKET: socketPath },
    stdio: ["ignore", "pipe", "pipe"]
  });
  proxy.stdout.on("data", chunk => { output += chunk; });
  proxy.stderr.on("data", chunk => { output += chunk; });
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const check = () => http.get(`http://127.0.0.1:${publicPort}/`, res => { res.resume(); resolve(); })
      .on("error", () => Date.now() > deadline ? reject(new Error("Proxy startup timed out")) : setTimeout(check, 30));
    check();
  });
});

after(async () => {
  if (proxy && proxy.exitCode === null) await new Promise(resolve => { proxy.once("exit", resolve); proxy.kill("SIGTERM"); });
  if (backend) await new Promise(resolve => backend.close(resolve));
  fs.rmSync(directory, { recursive: true, force: true });
});

async function attempt(gateway = true) {
  const page = await request("/", { gateway });
  const html = page.body.toString();
  const nonce = /data-fnos-diagnostic="([a-f0-9]{24})"/.exec(html)?.[1];
  assert.ok(nonce, "a diagnostic page has a bounded attempt");
  return { nonce, html, page };
}

test("diagnostic HTML preserves official module and uses an async classic observer", async () => {
  const { nonce, html, page } = await attempt();
  assert.match(html, new RegExp(`startup\\.js\\?d=${nonce}`));
  assert.match(html, /<script async src="\/app\/trilium-fnos\/__fnos\/assets\/diagnostics\.js/);
  assert.match(html, /<script type="module" crossorigin src="\.\/src\/index-test\.js"><\/script>/);
  assert.equal(page.headers["cache-control"], "no-store, no-transform");
  const source = await request(`/__fnos/assets/diagnostics.js?d=${nonce}`);
  assert.equal(source.status, 200);
  assert.equal(source.headers["cache-control"], "no-store, no-transform");
  assert.match(source.body.toString(), /fnos:probe-executed/);
});

test("iOS App gateway receives deferred entry but Safari and direct sync port do not", async () => {
  const headers = { "user-agent": "Mozilla/5.0 (iPhone) FNAppType/iOS FNAppVer/1.37.0" };
  const phone = await request("/", { headers });
  const html = phone.body.toString();
  assert.match(html, /data-fnos-entry="deferred"/);
  assert.match(html, /data-fnos-deferred-entry/);
  assert.doesNotMatch(html, /type="module"|rel="modulepreload"/);
  assert.match(output, /"event":"document-mode".*"mode":"deferred"/);
  for (const options of [{ headers, gateway: false }, { headers: { "user-agent": "Mozilla/5.0 iPhone Safari/604" } }]) {
    const original = (await request("/", options)).body.toString();
    assert.match(original, /type="module" crossorigin src="\.\/src\/index-test\.js"/);
    assert.match(original, /rel="modulepreload"/);
    assert.doesNotMatch(original, /data-fnos-entry="deferred"/);
  }
});

test("valid image beacons and tiny scripts stay on the gateway and never reach upstream", async () => {
  const { nonce } = await attempt();
  const previous = requests;
  const beacon = await request(`/__fnos/diagnostics/${nonce}/start.gif?ready=loading`);
  assert.equal(beacon.status, 200);
  assert.equal(beacon.headers["content-type"], "image/gif");
  for (const mode of ["classic", "anonymous", "credentials"]) {
    const probe = await request(`/src/__fnos_probe_${mode}.js?d=${nonce}`);
    assert.equal(probe.status, 200);
    assert.equal(probe.headers["access-control-allow-origin"], undefined);
    assert.equal(probe.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(Number(probe.headers["content-length"]), probe.body.length);
  }
  assert.equal(requests, previous);
});

test("diagnostic nonces and strict schema reject arbitrary data without logging it", async () => {
  const { nonce } = await attempt();
  assert.equal((await request(`/__fnos/diagnostics/${nonce}/start.gif?raw_url=private-note-secret`)).status, 400);
  assert.equal((await request(`/__fnos/diagnostics/${nonce}/start.gif`, { method: "POST" })).status, 405);
  assert.equal((await request("/src/__fnos_probe_classic.js?d=aaaaaaaaaaaaaaaaaaaaaaaa")).status, 404);
  assert.doesNotMatch(output, /private-note-secret/);
});

test("direct port gets its own same-route diagnostic URLs without changing the gateway prefix", async () => {
  const { nonce, html } = await attempt(false);
  assert.match(html, /src="\/__fnos\/assets\/diagnostics\.js/);
  assert.doesNotMatch(html, /src="\/app\/trilium-fnos\/__fnos\/assets\/diagnostics/);
  assert.equal((await request(`/__fnos/diagnostics/${nonce}/dom.gif?entry=root`, { gateway: false })).status, 200);
});

test("local response traces classify MIME and length without private payload or request queries", async () => {
  const { nonce } = await attempt();
  await request(`/__fnos/assets/startup.js?d=${nonce}`);
  await request(`/__fnos/assets/diagnostics.js?d=${nonce}`);
  await request("/src/index-test.js?token=private-query-token");
  await request("/src/test.css");
  await request("/src/index-test.js", { method: "HEAD" });
  await request("/bootstrap");
  await new Promise(resolve => setTimeout(resolve, 20));
  const records = output.split("\n").filter(line => line.includes("fnos-diag ")).map(line => JSON.parse(line.split("fnos-diag ")[1]));
  const responses = records.filter(record => record.event === "server-response");
  for (const mime of ["js", "css", "html"]) {
    assert.ok(responses.some(record => record.mime === mime && record.bytes > 0 && record.finish), `real ${mime} MIME and content length`);
  }
  assert.ok(responses.some(record => record.mime === "json" && record.path === "bootstrap"));
  assert.ok(responses.some(record => record.path === "src/index-test.js" && record.method === "HEAD" && record.bytes === 0));
  for (const name of ["startup.js", "diagnostics.js"]) {
    assert.ok(responses.some(record => record.path === `injected/${name}` && record.attempt === nonce && record.bytes > 0));
  }
  const association = records.find(record => record.event === "document-attempt" && record.attempt === nonce);
  assert.ok(association && responses.some(record => record.request === association.request && record.path === "document"));
  assert.doesNotMatch(output, /private-query-token|private bootstrap data/);
});

test("diagnostic issuance is globally capped without breaking normal HTML startup", async () => {
  // Readiness GET and previous cases consumed some attempts. Saturation must
  // stop diagnostic injection, not stop serving the original application.
  let normalPages = 0;
  for (let index = 0; index < 34; index++) {
    const response = await request("/");
    assert.equal(response.status, 200);
    if (!response.body.toString().includes("data-fnos-diagnostic=")) normalPages++;
    assert.match(response.body.toString(), /src="\.\/src\/index-test\.js"/);
  }
  assert.ok(normalPages > 0);
});
