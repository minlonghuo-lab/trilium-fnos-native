"use strict";

const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const crypto = require("node:crypto");
const { GATEWAY_PREFIX, gatewayRoute, applyFramePolicy, gatewayResponseHeaders, gatewayRequestCookies, upstreamHeaders } = require("./gateway");
const { getConnectionInfo } = require("./connections");
const { authenticatedTriliumSession } = require("./authentication");
const { hasResponseBody, responseDecoders, clearChangedEntityHeaders, gatewayTransportHeaders, readResponse, pipeline } = require("./transport");
const { createDiagnostics } = require("./diagnostics");
const { createModuleAudit } = require("./module-audit");
const { needsDeferredEntry, deferEntry } = require("./ios-entry");
const { createAssetNamespace, SOURCE_ROOT, adapterName } = require("./asset-namespace");

const PUBLIC_PORT = Number(process.env.TRILIUM_PUBLIC_PORT || 8080);
const BACKEND_PORT = Number(process.env.TRILIUM_BACKEND_PORT || 18888);
const BACKEND_HOST = "127.0.0.1";
const GATEWAY_SOCKET = process.env.TRILIUM_GATEWAY_SOCKET;
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_STARTUP_ASSET_BYTES = 32 * 1024 * 1024;
const loggedGatewayAssets = new Set();
// Cache immutable local assets once, not once per browser request.
const assets = new Map();
let assetNamespaceMode = process.env.TRILIUM_ASSET_NAMESPACE === "1";
try {
  assetNamespaceMode ||= JSON.parse(fs.readFileSync(path.join(__dirname, "asset-namespace-mode.json"), "utf8")).enabled === true;
} catch { /* This transport revision is explicitly enabled for NAS validation. */ }
const assetNamespace = assetNamespaceMode ? createAssetNamespace(process.env.TRILIUM_PUBLIC_ASSET_DIR || path.join(__dirname, "../server/public")) : null;
let iosEntryMode = process.env.TRILIUM_IOS_ENTRY === "deferred" ? "deferred" : "parser";
try {
  if (JSON.parse(fs.readFileSync(path.join(__dirname, "ios-entry-mode.json"), "utf8")).mode === "deferred") iosEntryMode = "deferred";
} catch { /* The compatibility candidate must be explicitly enabled. */ }
let diagnosticMode = process.env.TRILIUM_STARTUP_DIAGNOSTICS === "1";
try {
  diagnosticMode ||= JSON.parse(fs.readFileSync(path.join(__dirname, "diagnostic-mode.json"), "utf8")).enabled === true;
} catch { /* Normal packages have no diagnostic marker. Invalid markers stay disabled. */ }
const diagnostics = diagnosticMode ? createDiagnostics({ log }) : null;
let moduleAuditMode = diagnosticMode && process.env.TRILIUM_MODULE_AUDIT === "1";
try {
  moduleAuditMode ||= diagnosticMode && JSON.parse(fs.readFileSync(path.join(__dirname, "module-audit-mode.json"), "utf8")).enabled === true;
} catch { /* Independent experiments require their own temporary marker. */ }
const moduleAudit = moduleAuditMode ? createModuleAudit({ log, assetsDir: PUBLIC_DIR, publicDir: path.join(__dirname, "../server/public/src") }) : null;
let diagnosticAttempts = 0;
let diagnosticRequests = 0;
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
      "cache-control": diagnosticMode ? "no-store, no-transform" : "no-cache",
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
  const files = { "/__fnos/assets/startup.js": ["startup.js", "application/javascript; charset=utf-8"],
    "/__fnos/assets/sync.js": ["sync.js", "application/javascript; charset=utf-8"],
    "/__fnos/assets/sync.css": ["sync.css", "text/css; charset=utf-8"],
    "/__fnos/assets/logo.png": ["logo.png", "image/png"] };
  if (diagnosticMode) files["/__fnos/assets/diagnostics.js"] = ["diagnostics.js", "application/javascript; charset=utf-8"];
  if (moduleAuditMode) files["/__fnos/assets/module-audit-link.js"] = ["module-audit-link.js", "application/javascript; charset=utf-8"];
  if (assetNamespace && gateway) {
    for (const [route, file] of Object.entries(files)) {
      const alias = adapterName(file[0]);
      if (alias !== file[0]) files[route.slice(0, route.lastIndexOf("/") + 1) + alias] = file;
    }
  }
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

function injectManager(html, prefix = "", diagnosticAttempt = null, deferredEntry = false) {
  if (html.includes("data-trilium-fnos-manager")) return html;
  const namespaced = Boolean(prefix && assetNamespace);
  const name = filename => namespaced ? adapterName(filename) : filename;
  const tags = `<link rel="stylesheet" href="${prefix}/__fnos/assets/${name("sync.css")}" data-trilium-fnos-manager><script defer src="${prefix}/__fnos/assets/${name("sync.js")}" data-trilium-fnos-manager></script>`
    + (moduleAuditMode ? `<script async src="${prefix}/__fnos/assets/${name("module-audit-link.js")}" data-trilium-fnos-module-audit></script>` : "");
  // Register resource recovery before any official module/preload can fail.
  const diagnostic = diagnosticAttempt && /^[a-f0-9]{24}$/.test(diagnosticAttempt);
  const query = diagnostic ? `?d=${diagnosticAttempt}` : "";
  const attributes = (diagnostic ? ` data-fnos-diagnostic="${diagnosticAttempt}"` : "")
    + (deferredEntry ? ' data-fnos-entry="deferred"' : "")
    + (namespaced ? ` data-fnos-resource-root="${SOURCE_ROOT}"` : "");
  const startup = `<script src="${prefix}/__fnos/assets/${name("startup.js")}${query}" data-trilium-fnos-startup${attributes}></script>`
    + (diagnostic ? `<script async src="${prefix}/__fnos/assets/${name("diagnostics.js")}${query}" data-fnos-diagnostic="${diagnosticAttempt}"${namespaced ? ` data-fnos-resource-root="${SOURCE_ROOT}"` : ""} data-trilium-fnos-diagnostics></script>` : "");
  html = html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}${startup}`);
  return html.includes("</head>") ? html.replace("</head>", `${tags}</head>`) : `${tags}${html}`;
}

function diagnosticTrace(req, res, pathname, gateway) {
  if (!diagnostics || diagnosticRequests >= 1024) return;
  const asset = /^\/(?:assets\/v[0-9.]+\/)?src\/([a-zA-Z0-9_.-]{1,160}\.(?:js|css))$/.exec(pathname);
  const injectedMatch = /^\/__fnos\/assets\/(startup|diagnostics|sync)(?:-v0\.106\.0-p1)?\.(js|css)$/.exec(pathname);
  const injected = injectedMatch ? [injectedMatch[0], `${injectedMatch[1]}.${injectedMatch[2]}`] : null;
  if (!asset && !injected && !["/", "/bootstrap"].includes(pathname)) return;
  const request = ++diagnosticRequests;
  const started = Date.now();
  const ua = String(req.headers["user-agent"] || "");
  const client = /FNAppType\/iOS/.test(ua) ? "ios" : /FNAppType\//.test(ua) ? "app-other" : /iPhone|iPad/.test(ua) ? "ios-unmarked" : "browser";
  const mode = ["cors", "no-cors", "same-origin", "navigate"].includes(req.headers["sec-fetch-mode"]) ? req.headers["sec-fetch-mode"] : "unknown";
  const method = ["GET", "HEAD"].includes(req.method) ? req.method : "other";
  const metadata = { request, path: asset ? `src/${asset[1]}` : injected ? `injected/${injected[1]}` : pathname === "/" ? "document" : "bootstrap", gateway, client, mode, method };
  const attempt = injected && new URL(req.url, "http://localhost").searchParams.get("d");
  if (attempt && /^[a-f0-9]{24}$/.test(attempt)) metadata.attempt = attempt;
  req.fnosDiagnosticRequest = request;
  log(`fnos-diag ${JSON.stringify({ event: "server-request", ...metadata })}`);
  // writeHead's explicit headers are not exposed by getHeader(). Observe only
  // these two public response fields without changing any outgoing headers.
  let sentContentType, sentContentLength;
  const originalWriteHead = res.writeHead;
  res.writeHead = function (...args) {
    const headers = typeof args[1] === "string" ? args[2] : args[1];
    const pairs = Array.isArray(headers) ? Array.from({ length: Math.floor(headers.length / 2) }, (_, index) => [headers[index * 2], headers[index * 2 + 1]]) : Object.entries(headers || {});
    for (const [name, value] of pairs) {
      if (String(name).toLowerCase() === "content-type") sentContentType = value;
      if (String(name).toLowerCase() === "content-length") sentContentLength = value;
    }
    return originalWriteHead.apply(this, args);
  };
  let recorded = false;
  const complete = finish => {
    if (recorded) return;
    recorded = true;
    const contentType = String(sentContentType ?? res.getHeader("content-type") ?? "");
    const mime = /javascript/i.test(contentType) ? "js" : /text\/css/i.test(contentType) ? "css" : /text\/html/i.test(contentType) ? "html" : /json/i.test(contentType) ? "json" : "other";
    const length = Number(sentContentLength ?? res.getHeader("content-length"));
    // These bytes are the LOCAL response representation, not proof that the
    // phone received it. Never log body contents, headers, queries or note URLs.
    const bytes = req.method === "HEAD" || res.statusCode === 304 ? 0 : Number.isSafeInteger(length) && length >= 0 ? length : -1;
    log(`fnos-diag ${JSON.stringify({ event: "server-response", ...metadata, status: res.statusCode, mime, bytes, finish, ms: Math.max(0, Date.now() - started) })}`);
  };
  res.once("finish", () => complete(true));
  res.once("close", () => complete(false));
}

function proxyHttp(req, res, gateway = false) {
  const headers = upstreamHeaders(req, gateway);
  const pathname = new URL(req.url, "http://localhost").pathname;
  const isAppDocument = pathname === "/";
  const isBootstrap = Boolean(gateway && assetNamespace && pathname === "/bootstrap" && ["GET", "HEAD"].includes(req.method));
  const isStartupAsset = /^\/src\/[a-zA-Z0-9_.-]+\.(css|js)$/.test(pathname);
  if (isStartupAsset && new URL(req.url, "http://localhost").searchParams.has("fnos_resource_retry")) {
    delete headers["if-none-match"];
    delete headers["if-modified-since"];
    headers["cache-control"] = "no-cache";
  }
  if (isAppDocument) headers["accept-encoding"] = "identity";
  // Avoid reusing pre-r5 HTML with old CSP/updater paths from browser caches.
  if (req.headers["sec-fetch-dest"] === "iframe" || req.headers["sec-fetch-dest"] === "document" || req.url === "/") {
    delete headers["if-none-match"];
    delete headers["if-modified-since"];
  }

  let responseReceived = false;
  const upstream = http.request({
    host: BACKEND_HOST,
    port: BACKEND_PORT,
    method: req.method,
    path: req.url,
    headers
  }, async (upstreamRes) => {
    responseReceived = true;
    const responseHeaders = { ...upstreamRes.headers };
    if (gateway) gatewayResponseHeaders(responseHeaders, req.headers["x-forwarded-proto"] === "https");
    const contentType = String(upstreamRes.headers["content-type"] || "");
    if (isStartupAsset && (upstreamRes.statusCode >= 400 || contentType.includes("text/html"))) {
      // Only allowlisted public asset names; no cookies, queries or note URLs.
      log(`startup asset ${pathname} status=${upstreamRes.statusCode} html=${contentType.includes("text/html")}`);
    }
    if (isStartupAsset && upstreamRes.statusCode >= 400) responseHeaders["cache-control"] = "no-store";
    const status = upstreamRes.statusCode || 502;
    const appHtml = isAppDocument && contentType.includes("text/html") && status !== 206;
    if (appHtml) {
      applyFramePolicy(responseHeaders, req.headers.host || "localhost", gateway);
      responseHeaders["cache-control"] = "no-store";
    }
    try {
      const encoded = Boolean(responseHeaders["content-encoding"] && responseHeaders["content-encoding"] !== "identity");
      const decoders = gateway || appHtml ? responseDecoders(responseHeaders, req.method, status) : [];
      if (gateway) gatewayTransportHeaders(responseHeaders, encoded, isStartupAsset);
      if (req.fnosStaticNamespace) responseHeaders["cache-control"] = "no-store, no-transform";
      if (!hasResponseBody(req.method, status)) {
        if (appHtml) delete responseHeaders["content-length"];
        res.writeHead(status, responseHeaders);
        upstreamRes.resume();
        return res.end();
      }
      if (appHtml || isBootstrap || (gateway && isStartupAsset)) {
        // Fixed-length startup responses also avoid exposing backend chunked
        // compression framing to fnOS, including large split Vite modules.
        let body = await readResponse(upstreamRes, decoders, appHtml || isBootstrap ? MAX_HTML_BYTES : MAX_STARTUP_ASSET_BYTES);
        if (appHtml) {
          // Bound the diagnostic package globally as well as per page. Normal
          // startup remains available if all diagnostic attempt slots are used.
          let attempt = null;
          if (diagnostics && diagnosticAttempts < 32) {
            attempt = diagnostics.issueAttempt();
            if (attempt) {
              diagnosticAttempts++;
              log(`fnos-diag ${JSON.stringify({ event: "document-attempt", request: req.fnosDiagnosticRequest || 0, attempt })}`);
            }
          }
          const document = iosEntryMode === "deferred" && needsDeferredEntry(req.headers, gateway) ? deferEntry(body.toString("utf8")) : { html: body.toString("utf8"), deferred: false };
          if (gateway && assetNamespace) document.html = assetNamespace.rewriteDocument(document.html);
          if (attempt) log(`fnos-diag ${JSON.stringify({ event: "document-mode", request: req.fnosDiagnosticRequest || 0, attempt, mode: document.deferred ? "deferred" : "parser" })}`);
          body = Buffer.from(injectManager(document.html, gateway ? GATEWAY_PREFIX : "", attempt, document.deferred));
        }
        if (isBootstrap && status === 200 && /application\/json/i.test(contentType)) {
          body = assetNamespace.rewriteBootstrap(body);
          responseHeaders["cache-control"] = "no-store, no-transform";
        }
        if (appHtml || isBootstrap || decoders.length) clearChangedEntityHeaders(responseHeaders);
        else delete responseHeaders["transfer-encoding"];
        responseHeaders["content-length"] = body.length;
        if (gateway && isStartupAsset && status === 200 && /javascript|text\/css/i.test(contentType)) {
          // Validate the exact decoded bytes, not the backend's old compressed
          // representation. Subsequent launches can reuse the identity cache.
          const tag = `W/"fnos-identity-${crypto.createHash("sha256").update(body).digest("hex")}"`;
          if (!req.fnosStaticNamespace) responseHeaders.etag = tag;
          const candidates = String(req.headers["if-none-match"] || "").split(",").map(value => value.trim());
          if (!req.fnosStaticNamespace && req.method === "GET" && candidates.some(value => value.replace(/^W\//, "") === tag.slice(2))) {
            delete responseHeaders["content-length"];
            res.writeHead(304, responseHeaders);
            return res.end();
          }
        }
        if (gateway && isStartupAsset && loggedGatewayAssets.size < 256 && !loggedGatewayAssets.has(pathname)) {
          loggedGatewayAssets.add(pathname);
          res.once("finish", () => log(`gateway asset ${pathname} status=${status} encoding=identity bytes=${body.length}`));
        }
        res.writeHead(status, responseHeaders);
        return res.end(body);
      }
      res.writeHead(status, responseHeaders);
      await pipeline(upstreamRes, ...decoders, res);
    } catch (error) {
      upstreamRes.destroy();
      if (isStartupAsset) log(`startup asset ${pathname} transport-error=${error.code || "DECODE_ERROR"}`);
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      json(res, 502, { error: "Invalid upstream response", code: error.code || "DECODE_ERROR" });
    }
  });

  upstream.on("error", (error) => {
    if (res.destroyed || res.writableEnded) return;
    // The response pipeline owns errors after the backend has answered. Do not
    // race its 502 handler or turn an interrupted stream into a successful end.
    if (responseReceived) return;
    if (res.headersSent) return res.destroy(error);
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
      // Inspect the unnormalized URL before URL parsing can erase dot segments.
      // The static allowlist can never forward into an API or private file.
      const staticRoute = gateway && assetNamespace ? assetNamespace.route(req.url, req.method) : null;
      if (staticRoute) {
        if (staticRoute.status) return json(res, staticRoute.status, { error: "Invalid static resource" });
        req.url = staticRoute.upstream;
        req.fnosStaticNamespace = true;
        diagnosticTrace(req, res, new URL(req.url, "http://localhost").pathname, gateway);
        return proxyHttp(req, res, gateway);
      }
      if (pathname.startsWith("/__fnos/static/") || pathname === "/__fnos/static") return json(res, 404, { error: "Static namespace disabled" });
      if (moduleAudit?.handle(req, res, pathname, gateway ? GATEWAY_PREFIX : "")) return;
      if (pathname === "/__fnos/module-audit" || pathname.startsWith("/__fnos/module-audit/") || pathname.startsWith("/src/__fnos_audit/")) return json(res, 404, { error: "Module audit disabled" });
      if (diagnostics?.handle(req, res, pathname)) return;
      if (pathname === "/__fnos/diagnostics" || pathname.startsWith("/__fnos/diagnostics/") || pathname.startsWith("/src/__fnos_probe_")) {
        return json(res, 404, { error: "Diagnostics disabled" });
      }
      diagnosticTrace(req, res, pathname, gateway);
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
