"use strict";
// Development-only fixture. Addresses are simulated; never part of the FPK.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../../trilium-fnos/app/proxy/public");
let failNext = false;
http.createServer((req, res) => {
  const route = new URL(req.url, "http://localhost").pathname.replace(/^\/app\/trilium-fnos/, "");
  const send = (status, type, body) => { res.writeHead(status, { "content-type": type, "cache-control": "no-store" }); res.end(body); };
  if (route === "/__fixture/fail") { failNext = true; return send(200, "text/plain", "Next read fails once"); }
  if (route === "/__fnos/api/connections") {
    if (failNext) { failNext = false; return send(503, "application/json", '{}'); }
    return send(200, "application/json", JSON.stringify({ directPort: 8080, lanUrls: ["http://192.168.1.10:8080/"] }));
  }
  if (route === "/favicon.ico") return send(204, "image/png", "");
  if (route === "/") return send(200, "text/html; charset=utf-8", '<!doctype html><meta charset="utf-8"><title>Trilium menu fixture</title><link rel="stylesheet" href="./__fnos/assets/sync.css"><script defer src="./__fnos/assets/sync.js"></script><div class="global-menu"><ul class="dropdown-menu"><li data-trigger-command="openAboutDialog">关于</li><h6>新版提示测试</h6><li><span class="bx bx-download"></span>原生下载提示测试</li></ul></div>');
  const files = { "/__fnos/": ["sync.html", "text/html; charset=utf-8"], "/__fnos/assets/sync.js": ["sync.js", "application/javascript"], "/__fnos/assets/sync.css": ["sync.css", "text/css"], "/__fnos/assets/logo.png": ["logo.png", "image/png"] };
  if (Object.hasOwn(files, route)) {
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'");
    return send(200, files[route][1], fs.readFileSync(path.join(root, files[route][0])));
  }
  send(404, "text/plain", "Not found");
}).listen(19191, "127.0.0.1", () => console.log("Sync UI fixture http://127.0.0.1:19191/app/trilium-fnos/"));
