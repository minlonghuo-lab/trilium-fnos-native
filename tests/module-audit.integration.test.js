"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), http = require("node:http"), { spawn } = require("node:child_process"), { test } = require("node:test");
test("audit is separately opt-in, has a same-WebView link, and never contacts backend", async t => {
  let contacts = 0;
  const backend = http.createServer((req, res) => { contacts++; res.writeHead(200, { "content-type": "text/html" }).end('<html><head></head><body><div id="splash"><div class="splash-content"></div></div></body></html>'); });
  await new Promise(resolve => backend.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => backend.close(resolve)));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fnos-ma-i-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  async function run(enabled, diagnostic = "1") {
    const socket = path.join(directory, `a-${enabled}-${diagnostic}.sock`);
    const child = spawn(process.execPath, [path.resolve("trilium-fnos/app/proxy/server.js")], { env: { ...process.env, TRILIUM_PUBLIC_PORT: "0", TRILIUM_BACKEND_PORT: String(backend.address().port), TRILIUM_GATEWAY_SOCKET: socket, TRILIUM_STARTUP_DIAGNOSTICS: diagnostic, TRILIUM_MODULE_AUDIT: enabled ? "1" : "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    t.after(async () => { if (child.exitCode === null) await new Promise(resolve => { child.once("exit", resolve); child.kill("SIGTERM"); }); });
    const request = route => new Promise((resolve, reject) => {
      const req = http.request({ socketPath: socket, path: "/app/trilium-fnos" + route, headers: { host: "nas.example", "user-agent": "iPhone FNAppType/iOS" } }, res => { const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })); }); req.on("error", reject); req.end();
    });
    const deadline = Date.now() + 3000;
    while (!output.includes("proxy listening")) { if (child.exitCode !== null || Date.now() > deadline) throw new Error("Fixture proxy failed"); await new Promise(resolve => setTimeout(resolve, 10)); }
    return { request };
  }
  for (const flags of [[false, "1"], [true, "0"]]) {
    const { request } = await run(...flags);
    assert.equal((await request("/__fnos/module-audit/")).status, 404);
    assert.equal((await request("/src/__fnos_audit/aaaaaaaaaaaaaaaaaaaaaaaa/tiny/tiny.js")).status, 404);
    assert.doesNotMatch((await request("/")).body, /module-audit-link/);
  }
  const { request } = await run(true);
  const before = contacts;
  const page = await request("/__fnos/module-audit/");
  assert.equal(page.status, 200); assert.match(page.body, /\/app\/trilium-fnos\/__fnos\/module-audit/);
  const token = /data-module-audit="([a-f0-9]{24})"/.exec(page.body)[1];
  assert.equal((await request(`/src/__fnos_audit/${token}/graph/leaf-2.js`)).status, 200);
  assert.equal((await request(`/__fnos/module-audit/${token}/event.gif?step=script&test=graph&result=executed`)).status, 200);
  assert.equal(contacts, before);
  assert.match((await request("/")).body, /<script async src="\/app\/trilium-fnos\/__fnos\/assets\/module-audit-link.js/);
  const link = await request("/__fnos/assets/module-audit-link.js");
  assert.match(link.body, /MutationObserver/); assert.doesNotMatch(link.body, /location\.reload|target\s*=\s*["']_blank/);
});
