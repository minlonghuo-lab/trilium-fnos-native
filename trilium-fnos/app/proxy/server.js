"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const PUBLIC_PORT = Number(process.env.TRILIUM_PUBLIC_PORT || 8080);
const BACKEND_PORT = Number(process.env.TRILIUM_BACKEND_PORT || 18080);
const BACKEND_HOST = "127.0.0.1";
const DATA_DIR = process.env.TRILIUM_DATA_DIR || path.join(process.cwd(), ".trilium-data");
const BACKUP_DIR = process.env.TRILIUM_BACKUP_DIR || path.join(process.cwd(), ".backups");
const FAILED_DIR = process.env.TRILIUM_FAILED_DIR || path.join(process.cwd(), ".failed-upgrades");
const RUNTIME_ROOT = process.env.TRILIUM_RUNTIME_ROOT || path.join(process.cwd(), ".runtime");
const CURRENT_LINK = process.env.TRILIUM_CURRENT_LINK || path.join(RUNTIME_ROOT, "current");
const VERSION_FILE = process.env.TRILIUM_VERSION_FILE || path.join(RUNTIME_ROOT, "current-version");
const RELEASE_ARCH = process.env.TRILIUM_RELEASE_ARCH || (process.arch === "arm64" ? "linux-arm64" : "linux-x64");
const BACKEND_PID_FILE = process.env.TRILIUM_BACKEND_PID_FILE || path.join(process.cwd(), ".backend.pid");
const BACKEND_LOG_FILE = process.env.TRILIUM_BACKEND_LOG_FILE || path.join(process.cwd(), "trilium.log");
const LOG_FILE = process.env.TRILIUM_LOG_FILE;
const PUBLIC_DIR = path.join(__dirname, "public");
const LATEST_RELEASE_API = "https://api.github.com/repos/TriliumNext/Trilium/releases/latest";
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_BACKUPS = 5;
const RELEASE_CACHE_MS = 60 * 60 * 1000;
let releaseCache = null;

const state = {
  phase: "idle",
  message: "就绪",
  detail: "",
  startedAt: null,
  finishedAt: null,
  fromVersion: null,
  toVersion: null,
  error: null
};

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stdout.write(line);
  if (LOG_FILE) fs.appendFileSync(LOG_FILE, line);
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
    const body = fs.readFileSync(path.join(PUBLIC_DIR, filename));
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

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    log(`$ ${command} ${args.join(" ")}`);
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      log(chunk.toString().trimEnd());
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      log(chunk.toString().trimEnd());
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} 退出码 ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

function normalizeVersion(version) {
  const value = String(version || "").trim();
  return /^\d+\.\d+\.\d+/.test(value) ? `v${value}` : value;
}

async function currentVersion() {
  return normalizeVersion(fs.readFileSync(VERSION_FILE, "utf8"));
}

async function latestRelease() {
  if (releaseCache && Date.now() - releaseCache.fetchedAt < RELEASE_CACHE_MS) {
    return releaseCache.value;
  }
  const response = await fetch(LATEST_RELEASE_API, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "trilium-fnos-updater/1.0"
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`GitHub 版本检查失败（HTTP ${response.status}）`);
  const release = await response.json();
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(release.tag_name || "")) {
    throw new Error("GitHub 返回了无效的版本号。");
  }
  if (!["linux-x64", "linux-arm64"].includes(RELEASE_ARCH)) {
    throw new Error(`不支持的原生架构：${RELEASE_ARCH}`);
  }
  const assetName = `TriliumNotes-Server-${release.tag_name}-${RELEASE_ARCH}.tar.xz`;
  const asset = Array.isArray(release.assets) ? release.assets.find((item) => item.name === assetName) : null;
  if (!asset) throw new Error(`官方发布中没有 ${assetName}。`);
  const digestMatch = String(asset.digest || "").match(/^sha256:([a-f0-9]{64})$/i);
  if (!digestMatch) throw new Error("官方发布包缺少 SHA-256 校验值，已拒绝更新。");
  const value = {
    version: release.tag_name,
    url: release.html_url,
    publishedAt: release.published_at,
    notes: String(release.body || "").slice(0, 1200),
    assetName,
    assetUrl: asset.browser_download_url,
    assetSize: Number(asset.size || 0),
    sha256: digestMatch[1].toLowerCase()
  };
  releaseCache = { fetchedAt: Date.now(), value };
  return value;
}

async function isAuthenticated(req) {
  try {
    const response = await fetch(`http://${BACKEND_HOST}:${BACKEND_PORT}/api/options`, {
      headers: { cookie: req.headers.cookie || "" },
      redirect: "manual",
      signal: AbortSignal.timeout(5000)
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function waitForHealthy(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${BACKEND_HOST}:${BACKEND_PORT}/api/health-check`, {
        signal: AbortSignal.timeout(3000)
      });
      if (response.ok) return;
    } catch {
      // The native server refuses connections briefly while opening or migrating the database.
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("Trilium 在 3 分钟内未通过健康检查。");
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

function setProgress(phase, message, detail = "") {
  state.phase = phase;
  state.message = message;
  state.detail = detail;
  log(`${phase}: ${message}${detail ? ` (${detail})` : ""}`);
}

async function pruneBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((name) => /^before-update-.*\.tar\.gz$/.test(name))
    .map((name) => ({ name, mtime: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const file of files.slice(MAX_BACKUPS)) {
    fs.unlinkSync(path.join(BACKUP_DIR, file.name));
  }
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(BACKEND_PID_FILE, "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

function pidRunning(pid = readPid()) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopBackend() {
  const pid = readPid();
  if (!pidRunning(pid)) {
    fs.rmSync(BACKEND_PID_FILE, { force: true });
    return;
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && pidRunning(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (pidRunning(pid)) process.kill(pid, "SIGKILL");
  fs.rmSync(BACKEND_PID_FILE, { force: true });
}

async function startBackend(runtimeDir) {
  if (pidRunning()) return;
  const nodePath = path.join(runtimeDir, "node", "bin", "node");
  const mainPath = path.join(runtimeDir, "main.cjs");
  fs.accessSync(nodePath, fs.constants.X_OK);
  fs.accessSync(mainPath, fs.constants.R_OK);
  const output = fs.openSync(BACKEND_LOG_FILE, "a");
  const child = spawn(nodePath, ["main.cjs"], {
    cwd: runtimeDir,
    detached: true,
    env: {
      ...process.env,
      TRILIUM_DATA_DIR: DATA_DIR,
      TRILIUM_NETWORK_HOST: BACKEND_HOST,
      TRILIUM_NETWORK_PORT: String(BACKEND_PORT),
      TRILIUM_NETWORK_TRUSTEDREVERSEPROXY: "true"
    },
    stdio: ["ignore", output, output]
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  fs.closeSync(output);
  fs.writeFileSync(BACKEND_PID_FILE, `${child.pid}\n`);
  child.unref();
}

function currentRuntime() {
  return fs.realpathSync(CURRENT_LINK);
}

function activateRuntime(runtimeDir, version) {
  fs.mkdirSync(RUNTIME_ROOT, { recursive: true });
  const linkTemp = `${CURRENT_LINK}.new-${process.pid}`;
  fs.rmSync(linkTemp, { force: true });
  fs.symlinkSync(runtimeDir, linkTemp);
  fs.renameSync(linkTemp, CURRENT_LINK);
  const versionTemp = `${VERSION_FILE}.new-${process.pid}`;
  fs.writeFileSync(versionTemp, `${normalizeVersion(version)}\n`);
  fs.renameSync(versionTemp, VERSION_FILE);
}

async function downloadFile(url, destination, expectedSize) {
  const response = await fetch(url, {
    headers: { "user-agent": "trilium-fnos-updater/2.0" },
    redirect: "follow",
    signal: AbortSignal.timeout(30 * 60 * 1000)
  });
  if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}）`);

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const output = fs.createWriteStream(destination, { mode: 0o600 });
  let received = 0;
  const total = expectedSize || Number(response.headers.get("content-length") || 0);
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      state.detail = total
        ? `${(received / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MiB`
        : `${(received / 1024 / 1024).toFixed(1)} MiB`;
      callback(null, chunk);
    }
  });
  try {
    await pipeline(Readable.fromWeb(response.body), progress, output);
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw error;
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const input = fs.createReadStream(file);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

function pruneRuntimes(keepPaths) {
  const versionsDir = path.join(RUNTIME_ROOT, "versions");
  if (!fs.existsSync(versionsDir)) return;
  const keep = new Set(keepPaths.map((item) => path.resolve(item)));
  const entries = fs.readdirSync(versionsDir, { withFileTypes: true })
    .filter((item) => item.isDirectory() && /^v\d+\.\d+\.\d+/.test(item.name))
    .map((item) => ({ path: path.join(versionsDir, item.name), mtime: fs.statSync(path.join(versionsDir, item.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const entry of entries) {
    if (!keep.has(path.resolve(entry.path))) fs.rmSync(entry.path, { recursive: true, force: true });
  }
}

async function rollback(oldRuntime, oldVersion, backupPath, failedPath) {
  setProgress("rollback", "更新失败，正在自动回退");
  await stopBackend().catch(() => {});
  activateRuntime(oldRuntime, oldVersion);
  if (fs.existsSync(DATA_DIR)) fs.renameSync(DATA_DIR, failedPath);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  await run("tar", ["-xzf", backupPath, "-C", DATA_DIR]);
  await startBackend(oldRuntime);
  await waitForHealthy(120000);
}

async function performUpdate(release) {
  const targetVersion = release.version;
  let oldRuntime = null;
  let oldVersion = null;
  let backupPath = null;
  let failedPath = null;
  let archivePath = null;
  let stagingDir = null;
  let newRuntime = null;

  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.fromVersion = null;
  state.toVersion = targetVersion;
  state.error = null;

  try {
    setProgress("inspecting", "正在读取当前版本");
    oldRuntime = currentRuntime();
    oldVersion = await currentVersion();
    backupPath = path.join(BACKUP_DIR, `before-update-${oldVersion}-to-${targetVersion}-${stamp()}.tar.gz`);
    failedPath = path.join(FAILED_DIR, `failed-${targetVersion}-${stamp()}`);
    state.fromVersion = oldVersion;

    archivePath = path.join(RUNTIME_ROOT, "downloads", release.assetName);
    setProgress("downloading", "正在下载官方原生发行包", release.assetName);
    await downloadFile(release.assetUrl, archivePath, release.assetSize);

    setProgress("verifying", "正在校验 SHA-256");
    const digest = await sha256File(archivePath);
    if (digest !== release.sha256) throw new Error(`SHA-256 不匹配：期望 ${release.sha256}，实际 ${digest}`);

    const runtimeStamp = stamp();
    stagingDir = path.join(RUNTIME_ROOT, `staging-${targetVersion}-${runtimeStamp}`);
    newRuntime = path.join(RUNTIME_ROOT, "versions", `${targetVersion}-${runtimeStamp}`);
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.mkdirSync(path.dirname(newRuntime), { recursive: true });
    setProgress("extracting", "正在解压原生运行时");
    await run("tar", ["-xJf", archivePath, "-C", stagingDir, "--strip-components=1"]);
    fs.rmSync(path.join(stagingDir, "node_modules", "tesseract.js", "node_modules", ".bin", "opencollective-postinstall"), { force: true });
    fs.accessSync(path.join(stagingDir, "node", "bin", "node"), fs.constants.X_OK);
    fs.accessSync(path.join(stagingDir, "main.cjs"), fs.constants.R_OK);
    await run(path.join(stagingDir, "node", "bin", "node"), ["--version"]);
    fs.writeFileSync(path.join(stagingDir, "VERSION"), `${targetVersion}\n`);
    fs.renameSync(stagingDir, newRuntime);
    stagingDir = null;
    fs.rmSync(archivePath, { force: true });
    archivePath = null;

    setProgress("stopping", "正在停止 Trilium");
    await stopBackend();

    setProgress("backing-up", "正在创建冷备份", backupPath);
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.mkdirSync(FAILED_DIR, { recursive: true });
    await run("tar", ["-czf", backupPath, "-C", DATA_DIR, "."]);

    setProgress("switching", "正在切换原生运行时");
    activateRuntime(newRuntime, targetVersion);
    await startBackend(newRuntime);

    setProgress("checking", "正在等待数据库迁移和健康检查");
    await waitForHealthy();
    await pruneBackups();
    pruneRuntimes([newRuntime, oldRuntime]);

    setProgress("complete", `已更新到 ${targetVersion}`);
    state.finishedAt = new Date().toISOString();
  } catch (error) {
    const originalError = error instanceof Error ? error : new Error(String(error));
    state.error = originalError.message;
    log(`update failed: ${originalError.stack || originalError.message}`);

    if (oldRuntime && oldVersion && backupPath && failedPath && fs.existsSync(backupPath)) {
      try {
        await rollback(oldRuntime, oldVersion, backupPath, failedPath);
        state.phase = "failed-rolled-back";
        state.message = "更新失败，已自动回退";
      } catch (rollbackError) {
        state.phase = "failed";
        state.message = "更新和自动回退均失败";
        state.error += `\n回退错误: ${rollbackError.message}`;
      }
    } else {
      if (oldRuntime && !pidRunning()) await startBackend(oldRuntime).catch(() => {});
      state.phase = "failed";
      state.message = "更新失败，未更改数据";
    }
    if (archivePath) fs.rmSync(archivePath, { force: true });
    if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
    state.finishedAt = new Date().toISOString();
  }
}

async function handleManager(req, res, pathname) {
  if (pathname === "/__fnos/assets/update.js") return sendAsset(res, "update.js", "application/javascript; charset=utf-8");
  if (pathname === "/__fnos/assets/update.css") return sendAsset(res, "update.css", "text/css; charset=utf-8");

  const authenticated = await isAuthenticated(req);
  if (!authenticated) return json(res, 401, { error: "请先登录 Trilium。" });

  if (pathname === "/__fnos/api/status" && req.method === "GET") {
    try {
      const latest = await latestRelease();
      const current = await currentVersion();
      return json(res, 200, { current, latest, busy: !["idle", "complete", "failed", "failed-rolled-back"].includes(state.phase), state });
    } catch (error) {
      return json(res, 502, { error: error.message, state });
    }
  }

  if (pathname === "/__fnos/api/progress" && req.method === "GET") {
    return json(res, 200, state);
  }

  if (pathname === "/__fnos/api/update" && req.method === "POST") {
    if (!sameOrigin(req) || req.headers["x-trilium-fnos-action"] !== "update") {
      return json(res, 403, { error: "更新请求验证失败。" });
    }
    if (!["idle", "complete", "failed", "failed-rolled-back"].includes(state.phase)) {
      return json(res, 409, { error: "已有更新任务正在运行。", state });
    }
    try {
      const latest = await latestRelease();
      if (await currentVersion() === latest.version) {
        return json(res, 200, { message: "当前已是最新稳定版。", state });
      }
      setProgress("queued", `已排队更新到 ${latest.version}`);
      performUpdate(latest).catch((error) => log(`unhandled update error: ${error.stack || error}`));
      return json(res, 202, { message: `已开始更新到 ${latest.version}。`, state });
    } catch (error) {
      return json(res, 502, { error: error.message, state });
    }
  }

  return json(res, 404, { error: "Not found" });
}

function injectManager(html) {
  if (html.includes("data-trilium-fnos-manager")) return html;
  const tags = '<link rel="stylesheet" href="/__fnos/assets/update.css" data-trilium-fnos-manager><script defer src="/__fnos/assets/update.js" data-trilium-fnos-manager></script>';
  return html.includes("</head>") ? html.replace("</head>", `${tags}</head>`) : `${tags}${html}`;
}

function proxyHttp(req, res) {
  const headers = {
    ...req.headers,
    host: req.headers.host || `${BACKEND_HOST}:${BACKEND_PORT}`,
    "accept-encoding": "identity",
    "x-forwarded-for": req.socket.remoteAddress || "",
    "x-forwarded-host": req.headers.host || "",
    "x-forwarded-proto": "http"
  };
  delete headers["content-length"];
  if (req.headers["content-length"]) headers["content-length"] = req.headers["content-length"];

  const upstream = http.request({
    host: BACKEND_HOST,
    port: BACKEND_PORT,
    method: req.method,
    path: req.url,
    headers
  }, (upstreamRes) => {
    const responseHeaders = { ...upstreamRes.headers };
    const contentType = String(upstreamRes.headers["content-type"] || "");
    if (!contentType.includes("text/html")) {
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      upstreamRes.pipe(res);
      return;
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
      const body = Buffer.from(injectManager(Buffer.concat(chunks).toString("utf8")));
      delete responseHeaders["content-length"];
      delete responseHeaders["content-encoding"];
      delete responseHeaders["transfer-encoding"];
      responseHeaders["content-length"] = body.length;
      res.writeHead(upstreamRes.statusCode || 200, responseHeaders);
      res.end(body);
    });
  });

  upstream.on("error", (error) => {
    if (res.headersSent) return res.end();
    const body = Buffer.from(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Trilium 正在启动</title><style>body{margin:0;background:#2d2d2d;color:#eee;font:15px system-ui;display:grid;place-items:center;min-height:100vh}.card{padding:28px 32px;border-radius:14px;background:#383838;box-shadow:0 12px 45px #0006}h1{font-size:20px;margin:0 0 10px;color:#b5a4ff}</style><div class="card"><h1>Trilium 正在启动…</h1><div>页面将自动重试。</div><small>${String(error.code || "ECONNREFUSED")}</small></div></html>`);
    res.writeHead(503, { "content-type": "text/html; charset=utf-8", "content-length": body.length, "retry-after": "3" });
    res.end(body);
  });
  req.pipe(upstream);
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
    if (pathname.startsWith("/__fnos/")) return await handleManager(req, res, pathname);
    return proxyHttp(req, res);
  } catch (error) {
    log(`request error: ${error.stack || error}`);
    if (!res.headersSent) json(res, 500, { error: "Internal server error" });
    else res.end();
  }
});

server.on("upgrade", (req, clientSocket, head) => {
  const upstreamSocket = net.connect(BACKEND_PORT, BACKEND_HOST, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    const headers = {
      ...req.headers,
      "x-forwarded-for": req.socket.remoteAddress || "",
      "x-forwarded-host": req.headers.host || "",
      "x-forwarded-proto": "http"
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
});

server.listen(PUBLIC_PORT, "0.0.0.0", () => log(`Trilium fnOS proxy listening on ${PUBLIC_PORT}, backend ${BACKEND_HOST}:${BACKEND_PORT}`));

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

module.exports = { normalizeVersion, injectManager };
