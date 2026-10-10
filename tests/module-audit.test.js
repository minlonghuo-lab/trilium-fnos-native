"use strict";
const assert = require("node:assert/strict"), http = require("node:http"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), zlib = require("node:zlib"), vm = require("node:vm");
const { test } = require("node:test");
const { createModuleAudit, source, OFFICIAL } = require("../trilium-fnos/app/proxy/module-audit");
async function fixture(t, options = {}) {
  const logs = [], directory = fs.mkdtempSync(path.join(os.tmpdir(), "fnos-ma-"));
  for (const name of Object.values(OFFICIAL)) fs.writeFileSync(path.join(directory, name), "/* official public fixture */");
  const audit = createModuleAudit({ log: value => logs.push(value), assetsDir: path.resolve(__dirname, "../trilium-fnos/app/proxy/public"), publicDir: directory, ...options });
  const server = http.createServer((req, res) => { if (!audit.handle(req, res, new URL(req.url, "http://localhost").pathname, "/app/trilium-fnos")) res.writeHead(418).end(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const request = (url, method = "GET") => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, path: url, method }, res => { const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); });
    req.on("error", reject); req.end();
  });
  const page = await request("/__fnos/module-audit/");
  const token = /data-module-audit="([a-f0-9]{24})"/.exec(page.body.toString())?.[1];
  return { request, token, logs, directory, page };
}
test("standalone page stays on gateway with fresh, bounded nonce and strict CSP", async t => {
  const { token, page, request } = await fixture(t);
  assert.ok(token); assert.match(page.body.toString(), new RegExp(`/app/trilium-fnos/__fnos/module-audit/${token}/client.js`));
  assert.equal(page.headers["cache-control"], "no-store, no-transform");
  assert.match(page.headers["content-security-policy"], /script-src 'self'/);
  assert.doesNotMatch(page.body.toString(), /type="module"|modulepreload|bootstrap|__PREFIX__|__ATTEMPT__/);
  assert.equal((await request("/__fnos/module-audit/", "HEAD")).body.length, 0);
});
test("synthetic tiny, large and whole fresh dependency graph are valid and inert", async t => {
  const { token, request } = await fixture(t);
  const small = await request(`/src/__fnos_audit/${token}/tiny/tiny.js`);
  const normal = await request(`/src/__fnos_audit/${token}/large/large.js`);
  const ecma = await request(`/src/__fnos_audit/${token}/ecma/large.js`);
  assert.ok(small.body.length < 256); assert.ok(normal.body.length > 48000);
  assert.ok(zlib.gzipSync(normal.body).length > 10000, "large script also has a nontrivial compressed body");
  assert.deepEqual(normal.body, ecma.body); assert.match(ecma.headers["content-type"], /application\/ecmascript/);
  assert.equal(ecma.headers["content-encoding"], undefined, "outer encoding must still be measured separately");
  assert.equal(ecma.headers["access-control-allow-origin"], undefined); assert.equal(ecma.headers["set-cookie"], undefined);
  for (const profile of ["graph", "credentials", "preload", "graph-ecma"]) {
    const entry = (await request(`/src/__fnos_audit/${token}/${profile}/entry.js`)).body.toString();
    assert.match(entry, /from '\.\/branch.js'/); assert.doesNotMatch(entry, /bootstrap|fetch\(|localFetch|\/src\//);
    const branch = (await request(`/src/__fnos_audit/${token}/${profile}/branch.js`)).body.toString();
    assert.equal([...branch.matchAll(/from '\.\/leaf-[0-9]+\.js'/g)].length, 24);
    for (let i = 0; i < 24; i++) assert.equal((await request(`/src/__fnos_audit/${token}/${profile}/leaf-${i}.js`)).status, 200);
  }
  new vm.Script(source("classic", "large.js"));
});
test("public official aliases are exact allowlist, never arbitrary files or upstream", async t => {
  const { token, request, directory } = await fixture(t);
  for (const [key, name] of Object.entries(OFFICIAL)) {
    const response = await request(`/__fnos/module-audit/${token}/official/${key}`);
    assert.equal(response.status, 200); assert.deepEqual(response.body, fs.readFileSync(path.join(directory, name)));
  }
  for (const url of [`/__fnos/module-audit/${token}/official/database.db`, `/src/__fnos_audit/${token}/graph/leaf-24.js`, `/src/__fnos_audit/${token}/arbitrary/entry.js`, `/src/__fnos_audit/${token}/tiny/tiny.js?cookie=private`, `/__fnos/module-audit/${"a".repeat(24)}/client.js`]) assert.ok([400, 404].includes((await request(url)).status));
  assert.equal((await request("/bootstrap")).status, 418);
});
test("client reports reject raw errors, queries and repeated fields; HEAD never reports", async t => {
  const { token, request, logs } = await fixture(t);
  const url = `/__fnos/module-audit/${token}/event.gif`;
  const valid = "?step=error&test=graph&result=module&asset=leaf-5.js&line=4&column=9";
  const before = logs.length;
  assert.equal((await request(url + valid, "HEAD")).body.length, 0); assert.equal(logs.length, before);
  assert.equal((await request(url + valid)).status, 200);
  for (const query of [valid + "&message=private-note", valid + "&test=graph", "?step=error&test=graph&result=module&asset=https://secret.example/note", "?step=start&test=none&result=bad"]) assert.equal((await request(url + query)).status, 400);
  assert.doesNotMatch(logs.join("\n"), /private-note|secret.example/);
  assert.equal((await request(url + valid, "POST")).status, 405);
});
test("TTL, live attempt saturation and per-attempt budgets fail closed", async t => {
  let clock = 100;
  const { request, token } = await fixture(t, { now: () => clock, ttlMs: 100, maxAttempts: 1 });
  assert.equal((await request("/__fnos/module-audit/")).status, 429);
  assert.equal((await request(`/__fnos/module-audit/${token}/client.js`)).status, 200);
  for (let i = 0; i < 80; i++) assert.equal((await request(`/__fnos/module-audit/${token}/event.gif?step=finish&test=none&result=done`)).status, 200);
  assert.equal((await request(`/__fnos/module-audit/${token}/event.gif?step=finish&test=none&result=done`)).status, 429);
  clock = 200; assert.equal((await request(`/__fnos/module-audit/${token}/client.js`)).status, 404);
  assert.equal((await request("/__fnos/module-audit/")).status, 200);
});
