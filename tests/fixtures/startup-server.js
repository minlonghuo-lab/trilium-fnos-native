"use strict";

// Local fault injection only. Uses the real proxy and the exact Vite helper
// from the pinned official archive, without needing a NAS or a note database.
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawn, execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const archive = path.join(root, ".cache/upstream/TriliumNotes-Server-v0.106.0-linux-x64.tar.xz");
const helper = execFileSync("tar", ["-xOJf", archive, "TriliumNotes-Server-0.106.0-linux-x64/public/src/preload-helper-uBIymjUX.js"]);
const css = execFileSync("tar", ["-xOJf", archive, "TriliumNotes-Server-0.106.0-linux-x64/public/src/image_compression_dialog-Dv6sENdT.css"]);
const dependencies = new Map([["preload-helper-uBIymjUX.js", helper]]);
for (const name of ["font-DMVOl4cV.js", "splash-BuLZdf1c.js", "theme-DIqmDpk8.js"]) {
  dependencies.set(name, execFileSync("tar", ["-xOJf", archive, `TriliumNotes-Server-0.106.0-linux-x64/public/src/${name}`]));
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ts-"));
const socketPath = path.join(directory, "app.sock");
const counts = new Map();
const blockedByRelay = [];
const transportMode = process.env.TRILIUM_FIXTURE_TRANSPORT === "1";
let proxy;

const backend = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("cache-control", "no-store");
  function send(body, contentType) {
    body = Buffer.from(body);
    res.setHeader("content-type", contentType);
    // Model the actual phone request recorded in the NAS diagnosis.
    if (transportMode && /\bbr\b/.test(req.headers["accept-encoding"] || "")) {
      body = zlib.brotliCompressSync(body);
      res.setHeader("content-encoding", "br");
    }
    res.setHeader("content-length", body.length);
    return res.end(body);
  }
  if (url.pathname === "/src/preload.js") {
    return send(helper, "application/javascript");
  }
  if (dependencies.has(url.pathname.slice(5)) && url.pathname.startsWith("/src/")) {
    return send(dependencies.get(url.pathname.slice(5)), "application/javascript");
  }
  if (url.pathname === "/bootstrap") return send('{}', "application/json");
  if (["/src/entry.js", "/src/index-fixture.js"].includes(url.pathname)) {
    return send(`import {t as preload} from './preload-helper-uBIymjUX.js';
      import './font-DMVOl4cV.js'; import './splash-BuLZdf1c.js'; import './theme-DIqmDpk8.js';
      window.fixtureEntryEvaluations = (window.fixtureEntryEvaluations || 0) + 1;
      const mode = new URLSearchParams(location.search).get('mode') || 'once';
      if (mode !== 'stall') fetch('./bootstrap').then(response => response.json()).then(() => preload(async () => {
        window.glob = {}; // Model official completion, without any note data.
        document.getElementById('splash').remove();
        document.body.appendChild(Object.assign(document.createElement('h1'), {textContent:'Startup recovered'}));
      }, ['./image_compression_dialog-' + mode + '.css'], import.meta.url))
      .catch(error => document.getElementById('splash-status').textContent = error.message);`, "application/javascript");
  }
  if (/^\/src\/image_compression_dialog-[a-z]+\.css$/.test(url.pathname)) {
    const count = (counts.get(url.pathname) || 0) + 1;
    counts.set(url.pathname, count);
    if (!transportMode && (url.pathname.endsWith('-always.css') || count === 1)) {
      res.writeHead(503, { "content-type": "text/plain" });
      return res.end("Injected transient CSS failure");
    }
    return send(css, "text/css");
  }
  if (url.pathname === "/fixture-counts") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ...Object.fromEntries(counts), blockedByRelay }));
  }
  if (url.pathname !== "/") { res.writeHead(404); return res.end(); }
  send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Trilium startup recovery fixture</title>
    <script type="module" crossorigin src="./src/index-fixture.js"></script>
    ${[...dependencies.keys()].map(name => `<link rel="modulepreload" crossorigin href="./src/${name}">`).join("")}</head><body style="background:#242424;color:#ccc;font-family:system-ui">
    <div id="splash"><div class="splash-content"><h1>Trilium Notes</h1><div id="splash-status">Loading…</div></div></div></body></html>`, "text/html; charset=utf-8");
});
// Plain HTTP front door models nginx -> the real application Unix socket.
const gateway = http.createServer((req, res) => {
  const headers = { ...req.headers };
  if (transportMode) headers["accept-encoding"] = "gzip, deflate, br";
  const upstream = http.request({ socketPath, path: req.url, method: req.method, headers }, response => {
    if (transportMode && response.headers["content-encoding"] === "br") {
      // Reproduce the hypothesized fnOS relay fault: backend finishes, phone
      // receives neither a body nor a resource error. No startup fallback helps.
      blockedByRelay.push(req.url);
      response.resume();
      return;
    }
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  upstream.on("error", () => { if (!res.destroyed && !res.headersSent) { res.writeHead(502); res.end(); } });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
});
backend.listen(19288, "127.0.0.1", () => {
  proxy = spawn(process.execPath, [process.env.TRILIUM_FIXTURE_PROXY_FILE || path.join(root, "trilium-fnos/app/proxy/server.js")], {
    env: { ...process.env, TRILIUM_BACKEND_PORT: "19288", TRILIUM_PUBLIC_PORT: "19280", TRILIUM_GATEWAY_SOCKET: socketPath },
    stdio: ["ignore", "inherit", "inherit"]
  });
  gateway.listen(19281, "127.0.0.1", () => console.log("Fixture: http://127.0.0.1:19281/app/trilium-fnos/?mode=once (also always, stall)"));
});
process.on("SIGTERM", () => {
  proxy?.once("exit", () => { fs.rmSync(directory, { recursive: true, force: true }); process.exit(); });
  proxy?.kill("SIGTERM");
  backend.close(); gateway.close();
});
