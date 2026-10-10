"use strict";
// Local-only real official login module graph with a synthetic public bootstrap.
// Simulates poisoned old Brotli resources, never contacts NAS or a note database.
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), os = require("node:os"), zlib = require("node:zlib");
const { spawn } = require("node:child_process");
const publicDir = process.argv[2];
if (!publicDir) throw new Error("Supply extracted official public directory");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tnsb-")), socketPath = path.join(dir, "a.sock");
const observed = [], poisoned = new Set(["FormToggle-ElUrm1Ls.js", "index-2IAUW27Z.js", "dist-C3UACQzc.js", "image_compression_dialog-Dv6sENdT.css"]);
const mime = name => ({ ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml" })[path.extname(name)] || "application/octet-stream";
const backend = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  let body, type;
  if (pathname === "/bootstrap") {
    type = "application/json";
    body = Buffer.from(JSON.stringify({ assetPath: "assets/v0.106.0", loggedIn: false, dbInitialized: true, passwordSet: true, device: "mobile", platform: "linux", theme: "dark", isRtl: false, currentLocale: { id: "en" }, login: {}, options: {}, isElectron: false, isStandalone: false, csrfToken: "synthetic-test-only" }));
  } else if (pathname.startsWith("/api/")) { type = "application/json"; body = Buffer.from("{}"); }
  else {
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/assets\/v0\.106\.0\//, "").replace(/^\//, "");
    const filename = path.resolve(publicDir, relative);
    if (!filename.startsWith(path.resolve(publicDir) + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) return res.writeHead(404).end();
    body = fs.readFileSync(filename); type = relative === "index.html" ? "text/html" : mime(relative);
  }
  res.writeHead(200, { "content-type": type, "content-length": body.length, "cache-control": "no-store" }); res.end(req.method === "HEAD" ? undefined : body);
});
const relay = http.createServer((req, res) => {
  if (req.url === "/fixture-report") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ requests: observed }));
  const p = new URL(req.url, "http://localhost").pathname;
  observed.push(p);
  if (p.startsWith("/app/trilium-fnos/src/") && poisoned.has(path.basename(p))) {
    const name = path.basename(p), body = zlib.brotliCompressSync(fs.readFileSync(path.join(publicDir, "src", name)), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
    return res.writeHead(200, { "content-type": mime(name), "content-length": body.length }).end(body);
  }
  const upstream = http.request({ socketPath, path: req.url, method: req.method, headers: req.headers }, response => {
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  }); upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(upstream);
});
let proxy;
backend.listen(19788, "127.0.0.1", () => {
  proxy = spawn(process.execPath, [path.resolve("trilium-fnos/app/proxy/server.js")], { env: { ...process.env, TRILIUM_BACKEND_PORT: "19788", TRILIUM_PUBLIC_PORT: "19780", TRILIUM_GATEWAY_SOCKET: socketPath, TRILIUM_PUBLIC_ASSET_DIR: publicDir, TRILIUM_ASSET_NAMESPACE: process.env.TRILIUM_FIXTURE_OLD === "1" ? "0" : "1" }, stdio: ["ignore", "inherit", "inherit"] });
  relay.listen(19781, "127.0.0.1", () => console.log("Namespace login fixture http://127.0.0.1:19781/app/trilium-fnos/"));
});
process.on("SIGTERM", () => {
  proxy.once("exit", () => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(); });
  proxy.kill("SIGTERM"); backend.close(); relay.close();
});
