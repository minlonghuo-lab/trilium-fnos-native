"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { after, before, test } = require("node:test");

const root = path.resolve(__dirname, "..");
const backendPort = 18888;
const publicPort = 19181;
let backend;
let proxy;
let socketDir;
let socketPath;
const prefix = "/app/trilium-fnos";

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

function get(url, options = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }).on("error", reject);
  });
}

before(async () => {
  // Keep Unix socket paths short on macOS as well as Linux.
  socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-"));
  socketPath = path.join(socketDir, "a.sock");
  backend = http.createServer((req, res) => {
    if (req.url === "/api/options") {
      if (req.headers.cookie === "trilium.sid=test-session") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end('{}');
      }
      res.writeHead(401, { "content-type": "application/json" });
      return res.end('{"error":"not logged in"}');
    }
    if (req.url === "/echo?encoded=a%2Fb") {
      const chunks = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ url: req.url, method: req.method, body: Buffer.concat(chunks).toString(), proto: req.headers["x-forwarded-proto"], cookie: req.headers.cookie }));
      });
      return;
    }
    if (req.url === "/login") {
      res.writeHead(302, { location: "/?login", "set-cookie": ["trilium.sid=test-session; Path=/; HttpOnly; SameSite=Lax"] });
      return res.end();
    }
    if (req.url === "/api/login/sync") {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json", "set-cookie": ["trilium.sid=sync-session; Path=/; HttpOnly; SameSite=Lax"] });
        res.end(JSON.stringify({ method: req.method, body }));
      });
      return;
    }
    if (req.url.startsWith("/api/sync/")) {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        res.writeHead(req.headers.cookie === "trilium.sid=sync-session" ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify({ method: req.method, body, cookie: req.headers.cookie, contentType: req.headers["content-type"], lastSync: req.headers["x-last-sync-id"], url: req.url }));
      });
      return;
    }
    if (req.url === "/binary") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end("unaltered /api/ and /__fnos/ note contents");
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "x-frame-options": "SAMEORIGIN",
      "content-security-policy": "default-src 'self'; frame-ancestors 'self'"
    });
    res.end("<!doctype html><html><head><title>Fake Trilium</title></head><body>hello</body></html>");
  });
  backend.on("upgrade", (req, socket, head) => {
    if (req.url !== "/?ws=1") return socket.destroy();
    const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    if (head.length) socket.write(head);
    socket.on("data", chunk => socket.write(chunk));
  });
  await listen(backend, backendPort);

  proxy = spawn(process.execPath, [path.join(root, "trilium-fnos/app/proxy/server.js")], {
    env: {
      ...process.env,
      TRILIUM_PUBLIC_PORT: String(publicPort),
      TRILIUM_GATEWAY_SOCKET: socketPath,
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
  if (proxy && proxy.exitCode === null) {
    await new Promise(resolve => { proxy.once("exit", resolve); proxy.kill("SIGTERM"); });
  }
  if (backend) await new Promise((resolve) => backend.close(resolve));
  fs.rmSync(socketDir, { recursive: true, force: true });
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

function postDirect(route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: publicPort, path: route, method: "POST", headers }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("desktop sync login and paged updates preserve authentication, paths and bytes on the direct port", async () => {
  // The fake server validates transport, not Trilium's cryptographic handshake.
  const loginBody = JSON.stringify({ timestamp: "2026-10-07T00:00:00Z", hmac: "fixture-hmac" });
  const login = await postDirect("/api/login/sync", loginBody, { "content-type": "application/json" });
  assert.equal(login.status, 200);
  assert.deepEqual(JSON.parse(login.body), { method: "POST", body: loginBody });
  assert.match(login.headers["set-cookie"][0], /^trilium.sid=sync-session; Path=\/;/);
  const cookie = login.headers["set-cookie"][0].split(";")[0];
  const payload = JSON.stringify({ notes: [{ content: "笔记 /api/ 保持原样" }], lastSyncId: 42 });
  const update = await postDirect("/api/sync/update?lastSyncId=42", payload, { cookie, "content-type": "application/json", "x-last-sync-id": "42" });
  assert.equal(update.status, 200);
  assert.deepEqual(JSON.parse(update.body), { method: "POST", body: payload, cookie, contentType: "application/json", lastSync: "42", url: "/api/sync/update?lastSyncId=42" });
  const check = await get(`http://127.0.0.1:${publicPort}/api/sync/check`, { headers: { cookie } });
  assert.equal(check.status, 200);
  assert.equal(JSON.parse(check.body).method, "GET");
  assert.equal((await get(`http://127.0.0.1:${publicPort}/api/sync/check`)).status, 401);
});

function gateway(url, options = {}) {
  return get(`http://nas.example${url}`, { ...options, socketPath });
}

test("gateway page stays same-origin and injects prefixed update resources", async () => {
  const response = await gateway(`${prefix}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-security-policy"], "default-src 'self'; frame-ancestors 'self'");
  assert.equal(response.headers["x-frame-options"], undefined);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(response.body, /src="\/app\/trilium-fnos\/__fnos\/assets\/update.js"/);
  assert.equal((await gateway(`${prefix}/__fnos/assets/update.js`)).status, 200);
});

test("gateway redirects missing trailing slash while preserving query", async () => {
  const response = await gateway(`${prefix}?login`);
  assert.equal(response.status, 308);
  assert.equal(response.headers.location, `${prefix}/?login`);
  assert.equal((await gateway(`${prefix}-other/`)).status, 404);
  assert.equal((await gateway("/api/options")).status, 404);
});

test("gateway login scopes cookies and redirects without changing direct access", async () => {
  const response = await gateway(`${prefix}/login`);
  assert.equal(response.headers.location, `${prefix}/?login`);
  assert.equal(response.headers["set-cookie"][0], `trilium.sid=test-session; Path=${prefix}/; HttpOnly; SameSite=Lax`);
  const direct = await get(`http://127.0.0.1:${publicPort}/login`);
  assert.equal(direct.headers.location, "/?login");
  assert.match(direct.headers["set-cookie"][0], /Path=\/;/);
  assert.equal((await gateway(`${prefix}/__fnos/api/progress`, { headers: { cookie: "trilium.sid=test-session" } })).status, 200);
  assert.equal((await gateway(`${prefix}/__fnos/api/progress`)).status, 401);
});

test("gateway HEAD carries frame policy without fabricating an HTML body", async () => {
  const response = await gateway(`${prefix}/`, { method: "HEAD" });
  assert.equal(response.body, "");
  assert.equal(response.headers["content-security-policy"], "default-src 'self'; frame-ancestors 'self'");
});

test("gateway streams chunked POST with unchanged bytes and encoded queries", async () => {
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: `${prefix}/echo?encoded=a%2Fb`, method: "POST", headers: { host: "nas.example", "x-forwarded-proto": "https", cookie: "trilium.sid=test-session" } }, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve(JSON.parse(body)));
    });
    req.on("error", reject);
    req.write("笔记 ");
    req.end("/api/原文");
  });
  assert.deepEqual(result, { url: "/echo?encoded=a%2Fb", method: "POST", body: "笔记 /api/原文", proto: "https", cookie: "trilium.sid=test-session" });
  assert.equal((await gateway(`${prefix}/binary`)).body, "unaltered /api/ and /__fnos/ note contents");
});

test("gateway WebSocket upgrades and relays bytes bidirectionally", { timeout: 5000 }, async () => {
  await new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffered = Buffer.alloc(0);
    let upgraded = false;
    // A masked text frame with payload 'hi'.
    const frame = Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0x68 ^ 1, 0x69 ^ 2]);
    socket.on("connect", () => socket.write(`GET ${prefix}/?ws=1 HTTP/1.1\r\nHost: nas.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`));
    socket.on("error", reject);
    socket.on("data", chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!upgraded) {
        const end = buffered.indexOf("\r\n\r\n");
        if (end < 0) return;
        if (!buffered.toString().startsWith("HTTP/1.1 101")) { socket.destroy(); return reject(new Error("Upgrade failed")); }
        buffered = buffered.subarray(end + 4);
        upgraded = true;
        socket.write(frame);
      }
      if (buffered.length >= frame.length) {
        socket.destroy();
        try { assert.deepEqual(buffered, frame); resolve(); } catch (error) { reject(error); }
      }
    });
  });
});
