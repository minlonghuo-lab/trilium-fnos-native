"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { after, before, test } = require("node:test");

const root = path.resolve(__dirname, "..");
const backendPort = 18888;
const publicPort = 19181;
let backend;
let proxy;

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function waitFor(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http.get(url, (res) => {
        res.resume();
        resolve();
      }).on("error", () => {
        if (Date.now() >= deadline) reject(new Error(`Timed out waiting for ${url}`));
        else setTimeout(attempt, 80);
      });
    };
    attempt();
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }).on("error", reject);
  });
}

before(async () => {
  backend = http.createServer((req, res) => {
    if (req.url === "/api/options") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end('{"error":"not logged in"}');
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "x-frame-options": "SAMEORIGIN",
      "content-security-policy": "default-src 'self'; frame-ancestors 'self'"
    });
    res.end("<!doctype html><html><head><title>Fake Trilium</title></head><body>hello</body></html>");
  });
  await listen(backend, backendPort);

  proxy = spawn(process.execPath, [path.join(root, "trilium-fnos/app/proxy/server.js")], {
    env: {
      ...process.env,
      TRILIUM_PUBLIC_PORT: String(publicPort),
      TRILIUM_DATA_DIR: root,
      TRILIUM_BACKUP_DIR: root,
      TRILIUM_FAILED_DIR: root,
      TRILIUM_RUNTIME_ROOT: root,
      TRILIUM_CURRENT_LINK: path.join(root, ".test-current"),
      TRILIUM_VERSION_FILE: path.join(root, ".test-version"),
      TRILIUM_RELEASE_ARCH: "linux-x64",
      TRILIUM_BACKEND_PID_FILE: path.join(root, ".test-backend.pid"),
      TRILIUM_BACKEND_LOG_FILE: path.join(root, ".test-backend.log")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  proxy.stdout.on("data", () => {});
  proxy.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await waitFor(`http://127.0.0.1:${publicPort}/`);
});

after(async () => {
  if (proxy) proxy.kill("SIGTERM");
  if (backend) await new Promise((resolve) => backend.close(resolve));
});

test("injects updater assets into Trilium HTML", async () => {
  const response = await get(`http://127.0.0.1:${publicPort}/`);
  assert.equal(response.status, 200);
  assert.match(response.body, /data-trilium-fnos-manager/);
  assert.match(response.body, /\/__fnos\/assets\/update\.js/);
});

test("serves bundled updater assets", async () => {
  const response = await get(`http://127.0.0.1:${publicPort}/__fnos/assets/update.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /application\/javascript/);
  assert.match(response.body, /triliumFnosUpdaterLoaded/);
});

test("permits same-NAS fnOS frame ports while preserving other CSP directives", async () => {
  const response = await get(`http://127.0.0.1:${publicPort}/`);
  assert.equal(response.headers["x-frame-options"], undefined);
  assert.equal(response.headers["content-security-policy"],
    "default-src 'self'; frame-ancestors 'self' http://127.0.0.1:* https://127.0.0.1:*");
});

test("does not expose manager API without a Trilium session", async () => {
  const response = await get(`http://127.0.0.1:${publicPort}/__fnos/api/status`);
  assert.equal(response.status, 401);
});
