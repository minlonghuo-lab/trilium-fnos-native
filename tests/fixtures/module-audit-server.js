"use strict";
// Local-only browser verification with actual public release bytes and simulated
// outer gzip/403. Does not contact NAS, run Trilium or read a database.
const http = require("node:http"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), zlib = require("node:zlib"), { execFileSync } = require("node:child_process");
const { createModuleAudit, OFFICIAL } = require("../../trilium-fnos/app/proxy/module-audit");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fnos-audit-fixture-"));
const archive = path.resolve(".cache/upstream/TriliumNotes-Server-v0.106.0-linux-x64.tar.xz");
execFileSync("tar", ["-xJf", archive, "-C", directory, "--strip-components=3", ...Object.values(OFFICIAL).map(name => `TriliumNotes-Server-0.106.0-linux-x64/public/src/${name}`)]);
const assetsDir = path.resolve("trilium-fnos/app/proxy/public");
const audit = createModuleAudit({ log: console.log, publicDir: directory, assetsDir });
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  // Fault control is fixture-only, not included in the production handler.
  if (process.env.TRILIUM_AUDIT_FAULT === "leaf403" && /\/graph\/leaf-5\.js$/.test(url.pathname)) { res.writeHead(403, { "content-type": "text/html" }).end("Forbidden"); return; }
  const writeHead = res.writeHead.bind(res), end = res.end.bind(res);
  let gzip = false;
  res.writeHead = (status, headers) => {
    gzip = status === 200 && req.method !== "HEAD" && Number(headers["content-length"]) >= 256 && /^(application\/javascript|text\/css)/.test(headers["content-type"]) && /gzip/.test(req.headers["accept-encoding"] || "");
    if (gzip) { headers = { ...headers, "content-encoding": "gzip", vary: "Accept-Encoding" }; delete headers["content-length"]; }
    return writeHead(status, headers);
  };
  res.end = body => end(gzip && body ? zlib.gzipSync(body) : body);
  if (audit.handle(req, res, url.pathname)) return;
  const assets = { "/__fnos/assets/logo.png": [assetsDir, "logo.png", "image/png"], "/__fnos/assets/sync.css": [assetsDir, "sync.css", "text/css"] };
  for (const name of Object.values(OFFICIAL)) assets[`/src/${name}`] = [directory, name, name.endsWith("css") ? "text/css" : "application/javascript"];
  const found = assets[url.pathname];
  if (!found) return res.writeHead(404, { "content-type": "text/plain", "content-length": 0 }).end();
  const body = fs.readFileSync(path.join(found[0], found[1]));
  res.writeHead(200, { "content-type": found[2], "content-length": body.length }); res.end(body);
});
server.listen(Number(process.env.TRILIUM_AUDIT_PORT || 19592), "127.0.0.1", () => console.log("local audit fixture ready"));
process.on("SIGTERM", () => server.close(() => { fs.rmSync(directory, { recursive: true, force: true }); process.exit(); }));
