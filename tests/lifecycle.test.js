"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const os = require("node:os");
const { validMaintenance } = require("../trilium-fnos/app/proxy/maintenance");

const source = fs.readFileSync(path.join(__dirname, "../trilium-fnos/cmd/main"), "utf8");
const split = source.lastIndexOf('case "${1:-}" in');
const definitions = source.slice(0, split);
const dispatch = source.slice(split);
function run(code, action = "status") {
  return spawnSync("bash", ["-s", "--", action], {
    input: definitions + "\n" + code,
    encoding: "utf8",
    env: { ...process.env, TRIM_APPDEST: "/test/app", TRIM_PKGVAR: "/test/var" }
  });
}

test("status checks each service against its own marker without global variable corruption", () => {
  const result = run(`
backend_marker() { printf /test/runtime/main.cjs; }
read_pid() { case "$1" in */proxy.pid) printf 101;; */backend.pid) printf 102;; esac; }
process_matches() {
  case "$1:$2" in 101:/test/app/proxy/server.js|102:/test/runtime/main.cjs) return 0;; *) return 1;; esac
}
port_open() { [ "$1" = 8080 ] || [ "$1" = 18888 ]; }
gateway_ready() { return 0; }
${dispatch}`);
  assert.equal(result.status, 0, result.stderr);
});

test("status rejects a dead backend even if the proxy remains alive", () => {
  const result = run(`
backend_marker() { printf /test/runtime/main.cjs; }
read_pid() { case "$1" in */proxy.pid) printf 101;; */backend.pid) printf 102;; esac; }
process_matches() { [ "$1" = 101 ]; }
port_open() { return 0; }
${dispatch}`);
  assert.equal(result.status, 3, result.stderr);
});

test("readiness helpers preserve caller variables", () => {
  const result = run(`
read_pid() { printf 101; }
process_matches() { return 0; }
port_open() { return 0; }
file=caller-file; marker=caller-marker; pid=caller-pid; count=caller-count
wait_ready /test/var/backend.pid /test/runtime/main.cjs 18888 1 || exit 1
[ "$file:$marker:$pid:$count" = caller-file:caller-marker:caller-pid:caller-count ]
`);
  assert.equal(result.status, 0, result.stderr);
});

test("status preserves service availability during verified backend maintenance", () => {
  const result = run(`
backend_marker() { printf /test/runtime/main.cjs; }
pid_running() { [ "$1" = "$PROXY_PID_FILE" ]; }
port_open() { [ "$1" = 8080 ]; }
gateway_ready() { return 0; }
update_active() { return 0; }
${dispatch}`);
  assert.equal(result.status, 0, result.stderr);
});

test("maintenance cannot mask a failed public listener", () => {
  const result = run(`
backend_marker() { printf /test/runtime/main.cjs; }
pid_running() { return 0; }
port_open() { return 1; }
gateway_ready() { return 0; }
update_active() { return 0; }
${dispatch}`);
  assert.equal(result.status, 3, result.stderr);
});

test("starting during maintenance does not launch a second backend", () => {
  const result = run(`
update_active() { return 0; }
port_open() { return 0; }
gateway_ready() { return 0; }
start_backend() { exit 99; }
acquire_lock() { exit 98; }
${dispatch}`, "start");
  assert.equal(result.status, 0, result.stderr);
});

test("stop refuses to interrupt a database update", () => {
  const result = run(`
update_active() { return 0; }
stop_pid() { exit 99; }
${dispatch}`, "stop");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /请等待更新完成/);
});

test("maintenance marker is bounded and bound to the exact proxy PID", () => {
  const now = Date.now();
  const marker = { proxyPid: 123, taskId: "a".repeat(32), phase: "backing-up", startedAt: new Date(now - 1000).toISOString(), updatedAt: new Date(now).toISOString() };
  assert.equal(validMaintenance(marker, 123, now), true);
  assert.equal(validMaintenance(marker, 456, now), false);
  assert.equal(validMaintenance({ ...marker, phase: "complete" }, 123, now), false);
  assert.equal(validMaintenance({ ...marker, startedAt: "invalid" }, 123, now), false);
  assert.equal(validMaintenance(marker, 123, now + 2 * 60 * 60 * 1000), false);
  assert.equal(validMaintenance({ ...marker, taskId: "" }, 123, now), false);
});

test("lifecycle locks record and remove only their own PID", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trilium-lock-"));
  try {
    const result = run(`
LOCK_DIR='${dir}/lifecycle.lock'
acquire_lock || exit 1
[ "$(read_pid "$LOCK_DIR/owner.pid")" = "$$" ] || exit 2
release_lock
[ ! -d "$LOCK_DIR" ] || exit 3
`);
    assert.equal(result.status, 0, result.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("update_active requires the matching lock owner and a live proxy identity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trilium-marker-"));
  try {
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(dir, "marker.json"), JSON.stringify({ proxyPid: 123, taskId: "a".repeat(32), phase: "switching", startedAt: now, updatedAt: now }));
    const code = `
PROXY_NODE='${process.execPath}'
PROXY_DIR='${path.resolve(__dirname, "../trilium-fnos/app/proxy")}'
MAINTENANCE_FILE='${dir}/marker.json'
LOCK_DIR='${dir}/lock'
read_pid() { case "$1" in */proxy.pid|*/owner.pid) printf 123;; esac; }
process_matches() { return 0; }
update_active || exit 1
process_matches() { return 1; }
update_active && exit 2
exit 0
`;
    const result = run(code);
    assert.equal(result.status, 0, result.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
