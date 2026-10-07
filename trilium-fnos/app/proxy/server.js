"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { GATEWAY_PREFIX, gatewayRoute, applyFramePolicy, gatewayResponseHeaders, upstreamHeaders } = require("./gateway");
const { createUpdateController } = require("./update-controller");
const { getConnectionInfo } = require("./connections");
const { createColdBackup, restoreBackup } = require("./update-recovery");
const { authenticatedTriliumSession } = require("./authentication");
const { assertStableRelease } = require("./versions");

const PUBLIC_PORT = Number(process.env.TRILIUM_PUBLIC_PORT || 8080);
const BACKEND_PORT = Number(process.env.TRILIUM_BACKEND_PORT || 18888);
const BACKEND_HOST = "127.0.0.1";
const GATEWAY_SOCKET = process.env.TRILIUM_GATEWAY_SOCKET;
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

const updater = createUpdateController({
  state, currentVersion, latestRelease, performUpdate, isAuthenticated, sameOrigin,
  json, log, runtimeRoot: RUNTIME_ROOT, lockDir: process.env.TRILIUM_LIFECYCLE_LOCK,
  connectionInfo: () => getConnectionInfo(PUBLIC_PORT)
});

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stdout.write(line);
  if (LOG_FILE) {
    try { fs.appendFileSync(LOG_FILE, line); }
    catch (error) { process.stderr.write(`Unable to append proxy log: ${error.code || "IO_ERROR"}\n`); }
  }
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
      stdout = (stdout + chunk).slice(-1024 * 1024);
      if (!options.quiet) log(chunk.toString().trimEnd());
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-1024 * 1024);
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
  assertStableRelease(release);
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
  return authenticatedTriliumSession(req, `http://${BACKEND_HOST}:${BACKEND_PORT}`);
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
  throw new Error(`Trilium 在 ${Math.round(timeoutMs / 1000)} 秒内未通过健康检查。`);
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

function setProgress(phase, message, detail = "") {
  state.phase = phase;
  state.message = message;
  state.detail = detail;
  updater.progressChanged();
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
    const runtime = currentRuntime();
    if (fs.realpathSync(`/proc/${pid}/exe`) !== fs.realpathSync(path.join(runtime, "node/bin/node"))) return false;
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    if (!args.includes(path.join(runtime, "main.cjs"))) return false;
    return true;
  } catch {
    return false;
  }
}

async function stopBackend() {
  const pid = readPid();
  if (!pidRunning(pid)) {
    if (await backendPortInUse()) throw new Error("后端端口仍被占用，但无法确认进程身份；已取消更新，不创建可能不一致的备份。");
    fs.rmSync(BACKEND_PID_FILE, { force: true });
    return;
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && pidRunning(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (pidRunning(pid)) {
    process.kill(pid, "SIGKILL");
    const killDeadline = Date.now() + 5000;
    while (Date.now() < killDeadline && pidRunning(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (pidRunning(pid)) throw new Error("Trilium 进程未退出，已取消更新以保护数据。");
  }
  if (await backendPortInUse()) throw new Error("后端端口尚未释放，已取消更新以保护数据。");
  fs.rmSync(BACKEND_PID_FILE, { force: true });
}

function backendPortInUse() {
  return new Promise(resolve => {
    const socket = net.connect(BACKEND_PORT, BACKEND_HOST);
    let done = false;
    const finish = busy => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(busy);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", error => finish(error.code !== "ECONNREFUSED"));
    socket.setTimeout(1000, () => finish(true));
  });
}

async function startBackend(runtimeDir) {
  if (pidRunning()) return;
  const nodePath = path.join(runtimeDir, "node", "bin", "node");
  const mainPath = path.join(runtimeDir, "main.cjs");
  fs.accessSync(nodePath, fs.constants.X_OK);
  fs.accessSync(mainPath, fs.constants.R_OK);
  const output = fs.openSync(BACKEND_LOG_FILE, "a");
  const child = spawn(nodePath, [mainPath], {
    cwd: runtimeDir,
    detached: true,
    env: {
      ...process.env,
      TRILIUM_DATA_DIR: DATA_DIR,
      TRILIUM_NETWORK_HOST: BACKEND_HOST,
      TRILIUM_NETWORK_PORT: String(BACKEND_PORT),
      // Trilium 0.105 parses this setting as an IP address.  The proxy is
      // the only trusted hop in this package, so trust its loopback address.
      TRILIUM_NETWORK_TRUSTEDREVERSEPROXY: BACKEND_HOST
    },
    stdio: ["ignore", output, output]
  });
  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } finally { fs.closeSync(output); }
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
  await stopBackend();
  await restoreBackup({ run, dataDir: DATA_DIR, backupPath, failedPath });
  activateRuntime(oldRuntime, oldVersion);
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
  let backupComplete = false;
  let switched = false;
  let backendStopped = false;

  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.fromVersion = null;
  state.toVersion = targetVersion;
  state.error = null;

  try {
    setProgress("inspecting", "正在读取当前版本");
    oldRuntime = currentRuntime();
    oldVersion = await currentVersion();
    backupPath = path.join(BACKUP_DIR, `before-update-${oldVersion}-to-${targetVersion}-${stamp()}-${state.taskId}.tar.gz`);
    failedPath = path.join(FAILED_DIR, `failed-${targetVersion}-${stamp()}-${state.taskId}`);
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
    backendStopped = true;

    setProgress("backing-up", "正在创建冷备份", backupPath);
    fs.mkdirSync(FAILED_DIR, { recursive: true, mode: 0o700 });
    await createColdBackup({ run, dataDir: DATA_DIR, backupPath });
    backupComplete = true;

    setProgress("switching", "正在切换原生运行时");
    // Activation is a two-file operation; even a partial activation needs the
    // previous runtime restored, but only from a validated complete backup.
    switched = true;
    activateRuntime(newRuntime, targetVersion);
    await startBackend(newRuntime);

    setProgress("checking", "正在等待数据库迁移和健康检查");
    await waitForHealthy();
    // Cleanup must not roll back a successfully migrated and healthy database.
    try {
      await pruneBackups();
      pruneRuntimes([newRuntime, oldRuntime]);
    } catch (error) { log(`update cleanup warning: ${error.message}`); }

    setProgress("complete", `已更新到 ${targetVersion}`);
    state.finishedAt = new Date().toISOString();
  } catch (error) {
    const originalError = error instanceof Error ? error : new Error(String(error));
    state.error = originalError.message;
    log(`update failed: ${originalError.stack || originalError.message}`);

    if (switched && backupComplete && oldRuntime && oldVersion) {
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
      state.phase = "failed";
      state.message = "更新失败，未更改数据";
      if (backendStopped && oldRuntime && !pidRunning()) {
        try {
          await startBackend(oldRuntime);
          await waitForHealthy(120000);
        } catch (restartError) {
          state.message = "更新失败，原数据未更改，但旧版本恢复启动失败";
          state.error += `\n重启错误: ${restartError.message}`;
        }
      }
    }
    for (const temporary of [archivePath, stagingDir].filter(Boolean)) {
      try { fs.rmSync(temporary, { recursive: temporary === stagingDir, force: true }); }
      catch (cleanupError) { log(`update failure cleanup warning: ${cleanupError.message}`); }
    }
    state.finishedAt = new Date().toISOString();
  }
}

async function handleManager(req, res, pathname, gateway) {
  if (pathname === "/__fnos/assets/update.js") return sendAsset(res, "update.js", "application/javascript; charset=utf-8");
  if (pathname === "/__fnos/assets/update.css") return sendAsset(res, "update.css", "text/css; charset=utf-8");

  if ((pathname === "/__fnos" || pathname === "/__fnos/") && ["GET", "HEAD"].includes(req.method)) {
    if (!await isAuthenticated(req)) return json(res, 401, { error: "请先登录 Trilium；无认证模式下不开放飞牛管理。" });
    if (pathname === "/__fnos") {
      res.writeHead(308, { location: `${gateway ? GATEWAY_PREFIX : ""}/__fnos/`, "cache-control": "no-store" });
      return res.end();
    }
    const body = Buffer.from('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Trilium 飞牛管理</title><link rel="stylesheet" href="./assets/update.css"><script defer src="./assets/update.js"></script></head><body data-trilium-fnos-management><main><h1>Trilium 飞牛管理</h1><p>独立管理入口，不依赖 Trilium 菜单结构。</p><button type="button" data-trilium-fnos-open>打开管理</button> <a href="../">返回 Trilium Notes</a></main></body></html>');
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8", "content-length": body.length,
      "cache-control": "no-store", "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'"
    });
    return res.end(req.method === "HEAD" ? undefined : body);
  }

  return updater.handle(req, res, pathname);
}

function injectManager(html, prefix = "") {
  if (html.includes("data-trilium-fnos-manager")) return html;
  const tags = `<link rel="stylesheet" href="${prefix}/__fnos/assets/update.css" data-trilium-fnos-manager><script defer src="${prefix}/__fnos/assets/update.js" data-trilium-fnos-manager></script>`;
  return html.includes("</head>") ? html.replace("</head>", `${tags}</head>`) : `${tags}${html}`;
}

function proxyHttp(req, res, gateway = false) {
  const headers = upstreamHeaders(req, gateway);
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
    if (gateway) gatewayResponseHeaders(responseHeaders);
    const contentType = String(upstreamRes.headers["content-type"] || "");
    upstreamRes.on("error", () => res.destroy());
    if (!contentType.includes("text/html")) {
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
    const body = Buffer.from(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Trilium 正在启动</title><style>body{margin:0;background:#2d2d2d;color:#eee;font:15px system-ui;display:grid;place-items:center;min-height:100vh}.card{padding:28px 32px;border-radius:14px;background:#383838;box-shadow:0 12px 45px #0006}h1{font-size:20px;margin:0 0 10px;color:#b5a4ff}</style><div class="card"><h1>Trilium 正在启动…</h1><div>页面将自动重试。</div><small>${String(error.code || "ECONNREFUSED")}</small></div></html>`);
    const errorHeaders = { "content-type": "text/html; charset=utf-8", "content-length": body.length, "retry-after": "3", "cache-control": "no-store" };
    applyFramePolicy(errorHeaders, req.headers.host || "localhost", gateway);
    res.writeHead(503, errorHeaders);
    res.end(body);
  });
  req.on("aborted", () => upstream.destroy());
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

module.exports = { normalizeVersion, injectManager };
