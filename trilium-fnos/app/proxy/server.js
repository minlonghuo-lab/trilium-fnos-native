"use strict";

const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { GATEWAY_PREFIX, gatewayRoute, applyFramePolicy, gatewayResponseHeaders, gatewayRequestCookies, upstreamHeaders } = require("./gateway");
const { getConnectionInfo } = require("./connections");
const { authenticatedTriliumSession } = require("./authentication");

const PUBLIC_PORT = Number(process.env.TRILIUM_PUBLIC_PORT || 8080);
const BACKEND_PORT = Number(process.env.TRILIUM_BACKEND_PORT || 18888);
const BACKEND_HOST = "127.0.0.1";
const GATEWAY_SOCKET = process.env.TRILIUM_GATEWAY_SOCKET;
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_HTML_BYTES = 8 * 1024 * 1024;
// Cache immutable local assets once, not once per browser request.
const assets = new Map();
function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stdout.write(line);
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(payload);
}

function sendAsset(res, filename, contentType) {
  try {
    if (!assets.has(filename)) assets.set(filename, fs.readFileSync(path.join(PUBLIC_DIR, filename)));
    const body = assets.get(filename);
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": body.length,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff"
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}

async function isAuthenticated(req) {
  return authenticatedTriliumSession(req, `http://${BACKEND_HOST}:${BACKEND_PORT}`);
}

async function handleManager(req, res, pathname, gateway) {
  // Exact allowlist: removed update/check/progress routes never reach upstream.
  const files = { "/__fnos/assets/sync.js": ["sync.js", "application/javascript; charset=utf-8"],
    "/__fnos/assets/sync.css": ["sync.css", "text/css; charset=utf-8"],
    "/__fnos/assets/logo.png": ["logo.png", "image/png"] };
  if (!["GET", "HEAD"].includes(req.method)) return json(res, 405, { error: "Read-only endpoint" });
  if (Object.hasOwn(files, pathname)) return sendAsset(res, ...files[pathname]);
  if (!["/__fnos", "/__fnos/", "/__fnos/api/connections"].includes(pathname)) return json(res, 404, { error: "Not found" });
  if (!await isAuthenticated(req)) return json(res, 401, { error: "请先登录 Trilium，再打开电脑端同步。" });
  if (pathname === "/__fnos/api/connections") return json(res, 200, getConnectionInfo(PUBLIC_PORT));
  if (pathname === "/__fnos") {
    res.writeHead(308, { location: (gateway ? GATEWAY_PREFIX : "") + "/__fnos/", "cache-control": "no-store" });
    return res.end();
  }
  const body = fs.readFileSync(path.join(PUBLIC_DIR, "sync.html"));
  const headers = {
    "content-type": "text/html; charset=utf-8", "content-length": body.length,
    "cache-control": "no-store", "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'"
  };
  applyFramePolicy(headers, req.headers.host || "localhost", gateway);
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}

function injectManager(html, prefix = "") {
  if (html.includes("data-trilium-fnos-manager")) return html;
  const tags = `<link rel="stylesheet" href="${prefix}/__fnos/assets/sync.css" data-trilium-fnos-manager><script defer src="${prefix}/__fnos/assets/sync.js" data-trilium-fnos-manager></script>`;
  return html.includes("</head>") ? html.replace("</head>", `${tags}</head>`) : `${tags}${html}`;
}

function proxyHttp(req, res, gateway = false) {
  const headers = upstreamHeaders(req, gateway);
  const isAppDocument = new URL(req.url, "http://localhost").pathname === "/";
  if (isAppDocument) headers["accept-encoding"] = "identity";
  // Avoid reusing pre-r5 HTML with old CSP/updater paths from browser caches.
  if (req.headers["sec-fetch-dest"] === "iframe" || req.headers["sec-fetch-dest"] === "document" || req.url === "/") {
    delete headers["if-none-match"];
    delete headers["if-modified-since"];
  }

  const upstream = http.request({
    host: BACKEND_HOST,
    port: BACKEND_PORT,
    method: req.method,
    path: req.url,
    headers
  }, (upstreamRes) => {
    const responseHeaders = { ...upstreamRes.headers };
    if (gateway) gatewayResponseHeaders(responseHeaders, req.headers["x-forwarded-proto"] === "https");
    const contentType = String(upstreamRes.headers["content-type"] || "");
    upstreamRes.on("error", () => res.destroy());
    if (!isAppDocument || !contentType.includes("text/html")) {
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      upstreamRes.pipe(res);
      return;
    }
    applyFramePolicy(responseHeaders, req.headers.host || "localhost", gateway);
    responseHeaders["cache-control"] = "no-store";
    if (req.method === "HEAD") {
      delete responseHeaders["content-length"];
      res.writeHead(upstreamRes.statusCode || 200, responseHeaders);
      upstreamRes.resume();
      return res.end();
    }

    const chunks = [];
    let size = 0;
    upstreamRes.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_HTML_BYTES) chunks.push(chunk);
    });
    upstreamRes.on("end", () => {
      if (size > MAX_HTML_BYTES) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end("Trilium HTML response is unexpectedly large.");
        return;
      }
      const body = Buffer.from(injectManager(Buffer.concat(chunks).toString("utf8"), gateway ? GATEWAY_PREFIX : ""));
      delete responseHeaders["content-length"];
      delete responseHeaders["content-encoding"];
      delete responseHeaders["transfer-encoding"];
      delete responseHeaders.etag;
      responseHeaders["content-length"] = body.length;
      res.writeHead(upstreamRes.statusCode || 200, responseHeaders);
      res.end(body);
    });
  });

  upstream.on("error", (error) => {
    if (res.headersSent) return res.end();
    if (!isAppDocument) return json(res, 503, { error: "Trilium backend unavailable", code: error.code || "ECONNREFUSED" });
    const body = Buffer.from(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Trilium 正在启动</title><style>body{margin:0;background:#2d2d2d;color:#eee;font:15px system-ui;display:grid;place-items:center;min-height:100vh}.card{padding:28px 32px;border-radius:14px;background:#383838;box-shadow:0 12px 45px #0006}h1{font-size:20px;margin:0 0 10px;color:#b5a4ff}</style><div class="card"><h1>Trilium 正在启动…</h1><div>页面将自动重试。</div><small>${String(error.code || "ECONNREFUSED")}</small></div></html>`);
    const errorHeaders = { "content-type": "text/html; charset=utf-8", "content-length": body.length, "retry-after": "3", "cache-control": "no-store" };
    applyFramePolicy(errorHeaders, req.headers.host || "localhost", gateway);
    res.writeHead(503, errorHeaders);
    res.end(body);
  });
  req.on("aborted", () => upstream.destroy());
  upstream.setTimeout(300000, () => upstream.destroy(new Error("Upstream inactivity timeout")));
  res.on("close", () => { if (!res.writableEnded) upstream.destroy(); });
  req.pipe(upstream);
}

function createRequestHandler(gateway) {
  return async (req, res) => {
    try {
      if (gateway) {
        const route = gatewayRoute(req.url);
        if (!route) return json(res, 404, { error: "Outside application gateway" });
        if (route.redirect) {
          res.writeHead(308, { location: route.redirect, "cache-control": "no-store" });
          return res.end();
        }
        req.url = route.upstream;
        gatewayRequestCookies(req);
        if (req.headers["sec-fetch-dest"] === "iframe" || req.url === "/") {
          res.once("finish", () => log(`gateway document ${req.method} status=${res.statusCode}`));
        }
      }
      const pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
      if (pathname === "/__fnos" || pathname.startsWith("/__fnos/")) return await handleManager(req, res, pathname, gateway);
      return proxyHttp(req, res, gateway);
    } catch (error) {
      log(`request error: ${error.stack || error}`);
      if (!res.headersSent) json(res, 500, { error: "Internal server error" });
      else res.end();
    }
  };
}

function proxyWebSocket(req, clientSocket, head, gateway) {
  if (gateway) {
    const route = gatewayRoute(req.url);
    if (!route?.upstream) return clientSocket.destroy();
    req.url = route.upstream;
    gatewayRequestCookies(req);
  }
  let connected = false;
  const upstreamSocket = net.connect(BACKEND_PORT, BACKEND_HOST, () => {
    connected = true;
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    const headers = {
      ...upstreamHeaders(req, gateway),
      connection: "Upgrade",
      upgrade: "websocket"
    };
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined) lines.push(`${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
    }
    upstreamSocket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstreamSocket.write(head);
    clientSocket.pipe(upstreamSocket).pipe(clientSocket);
  });
  upstreamSocket.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => upstreamSocket.destroy());
  clientSocket.on("close", () => upstreamSocket.destroy());
  upstreamSocket.on("close", () => clientSocket.destroy());
  const timer = setTimeout(() => { if (!connected) upstreamSocket.destroy(); }, 10000);
  timer.unref();
  upstreamSocket.on("close", () => clearTimeout(timer));
}

const sockets = new Set();
function createServer(gateway) {
  const server = http.createServer(createRequestHandler(gateway));
  server.on("upgrade", (req, socket, head) => proxyWebSocket(req, socket, head, gateway));
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return server;
}
const server = createServer(false);
const gatewayServer = GATEWAY_SOCKET ? createServer(true) : null;
const servers = [server, gatewayServer].filter(Boolean);

async function prepareSocket() {
  let entry;
  try { entry = fs.lstatSync(GATEWAY_SOCKET); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!entry.isSocket()) throw new Error("Gateway path exists and is not a socket; refusing to remove it");
  await new Promise((resolve, reject) => {
    const probe = net.connect(GATEWAY_SOCKET);
    probe.once("connect", () => { probe.destroy(); reject(new Error("Gateway socket is already in use")); });
    probe.once("error", (error) => {
      if (error.code === "ECONNREFUSED") {
        try {
          const current = fs.lstatSync(GATEWAY_SOCKET);
          if (!current.isSocket() || current.ino !== entry.ino || current.dev !== entry.dev) {
            return reject(new Error("Gateway socket changed during startup"));
          }
          fs.unlinkSync(GATEWAY_SOCKET);
          resolve();
        } catch (error) { reject(error); }
      } else reject(error);
    });
    probe.setTimeout(2000, () => { probe.destroy(); reject(new Error("Gateway socket probe timed out")); });
  });
}
function listen(server, address, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, host, resolve);
  });
}
async function startServers() {
  if (gatewayServer) {
    await prepareSocket();
    await listen(gatewayServer, GATEWAY_SOCKET);
    // fnOS nginx runs under a different account and needs to connect locally.
    fs.chmodSync(GATEWAY_SOCKET, 0o666);
    log(`fnOS gateway listening on ${GATEWAY_PREFIX}/ via Unix socket`);
  }
  await listen(server, PUBLIC_PORT, "0.0.0.0");
  log(`Trilium fnOS proxy listening on ${PUBLIC_PORT}, backend ${BACKEND_HOST}:${BACKEND_PORT}`);
}
startServers().catch((error) => {
  log(`proxy startup failed: ${error.message}`);
  shutdown(1);
});

let shuttingDown = false;
function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  let remaining = servers.length;
  for (const listener of servers) listener.close(() => { if (--remaining === 0) process.exit(exitCode); });
  for (const socket of sockets) socket.destroy();
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());

module.exports = { injectManager };
