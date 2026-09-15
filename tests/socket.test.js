"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function child(script, args = [], env = {}) {
  const process = spawn(global.process.execPath, [script, ...args], { env: { ...global.process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  process.stdout.on("data", chunk => { output += chunk; });
  process.stderr.on("data", chunk => { output += chunk; });
  const closed = new Promise(resolve => process.once("exit", code => resolve({ code, output })));
  return { process, closed };
}
const proxy = path.resolve(__dirname, "../trilium-fnos/app/proxy/server.js");

test("socket startup does not delete unrelated files", { timeout: 5000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-"));
  const socket = path.join(dir, "a.sock");
  fs.writeFileSync(socket, "keep me");
  try {
    const result = await child(proxy, [], { TRILIUM_PUBLIC_PORT: "0", TRILIUM_GATEWAY_SOCKET: socket }).closed;
    assert.equal(result.code, 1);
    assert.match(result.output, /not a socket/);
    assert.equal(fs.readFileSync(socket, "utf8"), "keep me");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("socket startup refuses active listener, recovers stale socket, cleans up on stop", { timeout: 10000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-"));
  const socket = path.join(dir, "a.sock");
  let app;
  const owner = child("-e", ['require("node:net").createServer().listen(process.argv[1], () => console.log("ready"))', socket]);
  try {
    await new Promise(resolve => owner.process.stdout.once("data", resolve));
    const result = await child(proxy, [], { TRILIUM_PUBLIC_PORT: "0", TRILIUM_GATEWAY_SOCKET: socket }).closed;
    assert.equal(result.code, 1);
    assert.match(result.output, /already in use/);
    owner.process.kill("SIGKILL");
    await owner.closed;
    assert.ok(fs.lstatSync(socket).isSocket());
    app = child(proxy, [], { TRILIUM_PUBLIC_PORT: "0", TRILIUM_GATEWAY_SOCKET: socket });
    await new Promise(resolve => app.process.stdout.once("data", resolve));
    assert.equal(fs.statSync(socket).mode & 0o777, 0o666);
    app.process.kill("SIGTERM");
    assert.equal((await app.closed).code, 0);
    assert.equal(fs.existsSync(socket), false);
  } finally {
    owner.process.kill("SIGKILL");
    app?.process.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
