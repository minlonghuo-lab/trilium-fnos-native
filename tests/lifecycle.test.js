"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const os = require("node:os");

const source = fs.readFileSync(path.join(__dirname, "../trilium-fnos/cmd/main"), "utf8");
const split = source.lastIndexOf('case "${1:-}" in');
const definitions = source.slice(0, split);
const dispatch = source.slice(split);
test("runtime entrypoint supports official 0.106 ESM and legacy CommonJS without rewriting either", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trilium-entry-"));
  try {
    fs.writeFileSync(path.join(dir, "main.mjs"), "// ESM");
    const esm = run(`CURRENT_LINK='${dir}'\nbackend_marker`);
    assert.equal(esm.status, 0, esm.stderr);
    assert.equal(fs.realpathSync(esm.stdout), fs.realpathSync(path.join(dir, "main.mjs")));
    fs.unlinkSync(path.join(dir, "main.mjs"));
    fs.writeFileSync(path.join(dir, "main.cjs"), "// CJS");
    const cjs = run(`CURRENT_LINK='${dir}'\nbackend_marker`);
    assert.equal(cjs.status, 0, cjs.stderr);
    assert.equal(fs.realpathSync(cjs.stdout), fs.realpathSync(path.join(dir, "main.cjs")));
    fs.unlinkSync(path.join(dir, "main.cjs"));
    assert.equal(run(`CURRENT_LINK='${dir}'\nbackend_marker`).status, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("readiness waits through shell-to-node exec but rejects a dead child", () => {
  const result = run(`
attempt=0
pid_running() { attempt=$((attempt + 1)); [ "$attempt" -ge 2 ]; }
read_pid() { printf '%s' "$$"; }
port_open() { return 0; }
sleep() { :; }
wait_ready unused marker 18888 3 || exit 1
[ "$attempt" = 2 ] || exit 2
pid_running() { return 1; }
read_pid() { printf 999999999; }
wait_ready unused marker 18888 3 && exit 3
exit 0
`);
  assert.equal(result.status, 0, result.stderr);
});
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
