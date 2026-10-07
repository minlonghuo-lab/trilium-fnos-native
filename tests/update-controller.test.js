"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createUpdateController } = require("../trilium-fnos/app/proxy/update-controller");

const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(t, overrides = {}) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trilium-update-test-"));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const state = { phase: "idle" };
  let backendOnline = true;
  let time = Date.now();
  let checks = 0;
  const controller = createUpdateController({
    runtimeRoot, state,
    currentVersion: async () => "v0.105.0",
    latestRelease: async () => { checks++; return { version: "v0.105.1" }; },
    performUpdate: async () => { state.phase = "complete"; },
    isAuthenticated: async req => backendOnline && req.headers.cookie === "session",
    sameOrigin: req => req.headers.origin === "https://nas.example",
    json: (res, status, body) => { res.status = status; res.body = structuredClone(body); },
    connectionInfo: () => ({ directPort: 8080 }),
    now: () => time,
    log() {}, ...overrides
  });
  async function request(endpoint, options = {}) {
    const response = {};
    const req = { method: "GET", headers: { cookie: "session", ...options.headers }, ...options };
    req.headers = { cookie: "session", ...options.headers };
    await controller.handle(req, response, `/__fnos/api/${endpoint}`);
    return response;
  }
  const update = (headers = {}) => request("update", { method: "POST", headers: {
    origin: "https://nas.example", "x-trilium-fnos-action": "update", ...headers
  } });
  const progress = (token, headers = {}) => request("progress", { headers: {
    cookie: "", "x-trilium-fnos-action": "progress", "x-trilium-fnos-progress-token": token, ...headers
  } });
  return {
    controller, runtimeRoot, state, request, update, progress,
    offline() { backendOnline = false; }, advance(ms) { time += ms; }, checks: () => checks
  };
}

test("local manager status never calls GitHub and remains usable after a failed explicit check", async t => {
  let checks = 0;
  const h = harness(t, { latestRelease: async () => { checks++; throw new Error("GitHub unavailable"); } });
  const local = await h.request("status");
  assert.equal(local.status, 200);
  assert.equal(checks, 0);
  assert.equal(local.body.latest, null);
  assert.deepEqual(local.body.connection, { directPort: 8080 });
  assert.equal((await h.request("check")).status, 502);
  const afterError = await h.request("status");
  assert.equal(afterError.status, 200);
  assert.equal(afterError.body.current, "v0.105.0");
  assert.equal(afterError.body.checkError, "GitHub unavailable");
  assert.equal(checks, 1);
});

test("atomic reservation rejects simultaneous updates before asynchronous release lookup", async t => {
  const release = deferred();
  let runs = 0;
  const h = harness(t, {
    latestRelease: () => release.promise,
    performUpdate: async () => { runs++; h.state.phase = "complete"; }
  });
  const [one, two] = await Promise.all([h.update(), h.update()]);
  assert.deepEqual([one.status, two.status].sort(), [202, 409]);
  const accepted = [one, two].find(item => item.status === 202);
  assert.match(accepted.body.progressToken, /^[A-Za-z0-9_-]{43}$/);
  const marker = JSON.parse(fs.readFileSync(path.join(h.runtimeRoot, "update-maintenance.json"), "utf8"));
  assert.equal(marker.proxyPid, process.pid);
  assert.equal(marker.taskId, accepted.body.state.taskId);
  assert.equal(fs.readFileSync(path.join(h.runtimeRoot, "lifecycle.lock/owner.pid"), "utf8").trim(), String(process.pid));
  release.resolve({ version: "v0.105.1" });
  await turn();
  assert.equal(runs, 1);
  assert.equal(h.controller.isBusy(), false);
  assert.equal(fs.existsSync(path.join(h.runtimeRoot, "update-maintenance.json")), false);
  assert.equal(fs.existsSync(path.join(h.runtimeRoot, "lifecycle.lock")), false);
});

test("bounded progress token works while backend is offline and cannot authorize another endpoint", async t => {
  const update = deferred();
  const h = harness(t, { performUpdate: () => update.promise });
  const accepted = await h.update();
  const token = accepted.body.progressToken;
  h.offline();
  assert.equal((await h.progress(token)).status, 200);
  assert.equal((await h.progress(token, { "sec-fetch-site": "same-origin" })).status, 200);
  assert.equal((await h.progress(token, { origin: "https://evil.example" })).status, 401);
  assert.equal((await h.progress(token, { "sec-fetch-site": "cross-site" })).status, 401);
  assert.equal((await h.progress(token, { "x-trilium-fnos-action": "update" })).status, 401);
  assert.equal((await h.progress("A".repeat(43))).status, 401);
  assert.equal((await h.request("status", { headers: { "x-trilium-fnos-action": "progress", "x-trilium-fnos-progress-token": token } })).status, 401);
  assert.equal((await h.update({ "x-trilium-fnos-progress-token": token })).status, 401);
  h.state.phase = "complete";
  update.resolve();
  await turn();
  assert.equal((await h.progress(token)).status, 200);
  h.advance(15 * 60 * 1000 + 1);
  assert.equal((await h.progress(token)).status, 401);
});

test("new update invalidates previous task token; active token has an absolute expiry", async t => {
  const h = harness(t);
  const first = await h.update();
  await turn();
  const second = await h.update();
  assert.notEqual(first.body.state.taskId, second.body.state.taskId);
  h.offline();
  assert.equal((await h.progress(first.body.progressToken)).status, 401);
  assert.equal((await h.progress(second.body.progressToken)).status, 200);
  h.advance(2 * 60 * 60 * 1000 + 1);
  assert.equal((await h.progress(second.body.progressToken)).status, 401);
  await turn();
});

test("external lifecycle lock and forged update requests do not mutate state or lock owner", async t => {
  const h = harness(t);
  assert.equal((await h.update({ origin: "https://evil.example" })).status, 403);
  fs.mkdirSync(path.join(h.runtimeRoot, "lifecycle.lock"));
  fs.writeFileSync(path.join(h.runtimeRoot, "lifecycle.lock/owner.pid"), "123456\n");
  assert.equal((await h.update()).status, 409);
  assert.equal(h.state.phase, "idle");
  assert.equal(fs.readFileSync(path.join(h.runtimeRoot, "lifecycle.lock/owner.pid"), "utf8"), "123456\n");
  assert.equal(h.checks(), 0);
});

test("release errors and already-current release finish cleanly and release maintenance lock", async t => {
  const h = harness(t, { latestRelease: async () => { throw new Error("network timeout"); } });
  const failed = await h.update();
  assert.equal(failed.status, 202);
  await turn();
  assert.equal(h.state.phase, "failed");
  assert.equal(h.state.error, "network timeout");
  assert.equal(fs.existsSync(path.join(h.runtimeRoot, "lifecycle.lock")), false);
  const current = harness(t, { latestRelease: async () => ({ version: "v0.105.0" }), performUpdate: async () => assert.fail("must not update current version") });
  assert.equal((await current.update()).status, 202);
  await turn();
  assert.equal(current.state.phase, "complete");
  assert.match(current.state.message, /最新/);
  assert.equal(fs.existsSync(path.join(current.runtimeRoot, "lifecycle.lock")), false);
});

test("server blocks older, prerelease and malformed versions before runtime mutation", async t => {
  for (const version of ["v0.105.0", "v0.107.0-beta.1", "v0.107.0+build", "unexpected"]) {
    const h = harness(t, {
      currentVersion: async () => "v0.106.0",
      latestRelease: async () => ({ version }),
      performUpdate: async () => assert.fail("must not mutate runtime")
    });
    const checked = await h.request("check");
    assert.equal(checked.body.canUpdate, false);
    assert.equal((await h.update()).status, 202);
    await turn();
    assert.equal(h.state.phase, version === "v0.105.0" ? "complete" : "failed");
    if (version === "v0.105.0") assert.match(h.state.message, /阻止降级/);
    assert.equal(fs.existsSync(path.join(h.runtimeRoot, "lifecycle.lock")), false);
  }
});

test("numeric stable version comparison permits 0.109 to 0.110 and fails closed for unknown installed version", async t => {
  let runs = 0;
  const h = harness(t, {
    currentVersion: async () => "v0.109.0",
    latestRelease: async () => ({ version: "v0.110.0" }),
    performUpdate: async () => { runs++; h.state.phase = "complete"; }
  });
  assert.equal((await h.request("check")).body.canUpdate, true);
  assert.equal((await h.update()).status, 202);
  await turn();
  assert.equal(runs, 1);
  const unknown = harness(t, {
    currentVersion: async () => "v0.109.0-beta.1",
    latestRelease: async () => ({ version: "v0.110.0" }),
    performUpdate: async () => assert.fail("unknown installed version must not mutate")
  });
  assert.equal((await unknown.request("check")).body.canUpdate, false);
  await unknown.update();
  await turn();
  assert.equal(unknown.state.phase, "failed");
});
