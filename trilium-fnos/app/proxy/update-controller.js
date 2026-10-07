"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { compareStableVersions } = require("./versions");

const TERMINAL_PHASES = new Set(["idle", "complete", "failed", "failed-rolled-back"]);
const MAX_TASK_MS = 2 * 60 * 60 * 1000;
const FINISHED_TOKEN_MS = 15 * 60 * 1000;

// Owns the update reservation independently of backend availability. The token
// grants only this task's progress, never status, release checks or mutations.
function createUpdateController(options) {
  const { state, currentVersion, latestRelease, performUpdate, isAuthenticated,
    sameOrigin, json, log, runtimeRoot } = options;
  const lockDir = options.lockDir || path.join(runtimeRoot, "lifecycle.lock");
  const markerFile = path.join(runtimeRoot, "update-maintenance.json");
  const now = options.now || Date.now;
  let active = false;
  let latest = null;
  let checkError = null;
  let tokenHash = null;
  let tokenExpires = 0;
  let checking = null;
  let lockOwned = false;

  function progressChanged() {
    if (!active || !lockOwned) return;
    const temp = `${markerFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({
      proxyPid: process.pid, taskId: state.taskId, phase: state.phase,
      startedAt: state.startedAt, updatedAt: new Date(now()).toISOString()
    }), { mode: 0o600 });
    fs.renameSync(temp, markerFile);
  }

  function acquireLock() {
    fs.mkdirSync(runtimeRoot, { recursive: true });
    try { fs.mkdirSync(lockDir, { mode: 0o700 }); }
    catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
    lockOwned = true;
    try { fs.writeFileSync(path.join(lockDir, "owner.pid"), `${process.pid}\n`, { mode: 0o600 }); }
    catch (error) {
      // Owner file creation can fail on a full disk. This newly-created empty
      // directory is ours; rmdir refuses it if any unexpected entry appeared.
      try { fs.rmdirSync(lockDir); } catch { /* Never recursively remove a lock. */ }
      lockOwned = false;
      throw error;
    }
    return true;
  }

  function releaseLock() {
    if (!lockOwned) return;
    // Never recursively delete a lock potentially replaced by another process.
    try {
      if (fs.readFileSync(path.join(lockDir, "owner.pid"), "utf8").trim() === String(process.pid)) {
        fs.unlinkSync(path.join(lockDir, "owner.pid"));
        fs.rmdirSync(lockDir);
      }
    } catch (error) { log(`lifecycle lock cleanup: ${error.message}`); }
    lockOwned = false;
  }

  async function snapshot(req) {
    const current = await currentVersion();
    let canUpdate = false;
    try { canUpdate = !!latest && compareStableVersions(latest.version, current) > 0; }
    catch { /* Unknown/prerelease versions require deliberate manual handling. */ }
    return {
      current, latest, checkError, canUpdate, busy: active, state,
      ...(options.connectionInfo ? { connection: options.connectionInfo(req) } : {})
    };
  }

  async function checkRelease() {
    // Share a single in-flight request; opening multiple tabs cannot amplify
    // release checks or leave old errors permanently hiding the local controls.
    if (!checking) checking = latestRelease().then(value => {
      latest = value;
      checkError = null;
      return value;
    }).catch(error => {
      checkError = error.message;
      throw error;
    }).finally(() => { checking = null; });
    return checking;
  }

  function validProgressToken(req) {
    if (req.headers["x-trilium-fnos-action"] !== "progress") return false;
    if (req.headers.origin && !sameOrigin(req)) return false;
    if (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") return false;
    const token = req.headers["x-trilium-fnos-progress-token"];
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token) || !tokenHash || now() > tokenExpires) return false;
    return crypto.timingSafeEqual(crypto.createHash("sha256").update(token).digest(), tokenHash);
  }

  async function execute() {
    try {
      state.phase = "checking-release";
      state.message = "正在检查官方稳定版本";
      progressChanged();
      const release = await checkRelease();
      state.toVersion = release.version;
      state.fromVersion = await currentVersion();
      const direction = compareStableVersions(release.version, state.fromVersion);
      if (direction <= 0) {
        state.phase = "complete";
        state.message = direction === 0 ? "当前已是最新稳定版。" : "当前版本比官方稳定版更新，已阻止降级。";
      } else {
        await performUpdate(release);
        if (!TERMINAL_PHASES.has(state.phase)) throw new Error("更新任务未正常结束，请检查应用日志。");
      }
    } catch (error) {
      state.phase = "failed";
      state.message = "更新失败";
      state.error = error.message;
      log(`update task failed: ${error.stack || error}`);
    } finally {
      state.finishedAt = new Date(now()).toISOString();
      tokenExpires = Math.min(tokenExpires, now() + FINISHED_TOKEN_MS);
      active = false;
      try {
        const marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
        if (marker.proxyPid === process.pid && marker.taskId === state.taskId) fs.unlinkSync(markerFile);
      } catch (error) { if (error.code !== "ENOENT") log(`maintenance cleanup: ${error.message}`); }
      releaseLock();
    }
  }

  async function handle(req, res, pathname) {
    if (pathname === "/__fnos/api/progress" && req.method === "GET" && validProgressToken(req)) {
      return json(res, 200, state);
    }
    if (!await isAuthenticated(req)) return json(res, 401, { error: "请先登录 Trilium。" });

    if (pathname === "/__fnos/api/status" && req.method === "GET") {
      return json(res, 200, await snapshot(req));
    }
    if (pathname === "/__fnos/api/check" && req.method === "GET") {
      try { await checkRelease(); }
      catch (error) { return json(res, 502, { ...await snapshot(req), error: error.message }); }
      return json(res, 200, await snapshot(req));
    }
    if (pathname === "/__fnos/api/progress" && req.method === "GET") return json(res, 200, state);
    if (pathname !== "/__fnos/api/update" || req.method !== "POST") return json(res, 404, { error: "Not found" });
    if (!sameOrigin(req) || req.headers["x-trilium-fnos-action"] !== "update") {
      return json(res, 403, { error: "更新请求验证失败。" });
    }
    if (active || !acquireLock()) return json(res, 409, { error: "已有更新或应用启停任务正在运行，请稍后再试。", state });

    active = true; // Reserve synchronously, before any release/network await.
    const progressToken = crypto.randomBytes(32).toString("base64url");
    tokenHash = crypto.createHash("sha256").update(progressToken).digest();
    tokenExpires = now() + MAX_TASK_MS;
    Object.assign(state, {
      phase: "queued", message: "更新任务已开始", detail: "", error: null,
      taskId: crypto.randomUUID(), startedAt: new Date(now()).toISOString(),
      finishedAt: null, fromVersion: null, toVersion: null
    });
    try { progressChanged(); }
    catch (error) {
      active = false;
      tokenHash = null;
      state.phase = "failed";
      state.message = "无法建立更新任务";
      state.error = error.message;
      state.finishedAt = new Date(now()).toISOString();
      releaseLock();
      return json(res, 500, { error: state.error, state });
    }
    json(res, 202, { message: "更新任务已开始。", state, progressToken });
    void execute();
  }

  return { handle, progressChanged, isBusy: () => active };
}

module.exports = { createUpdateController };
