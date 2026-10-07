"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync, execFileSync } = require("node:child_process");
const cmd = path.resolve(__dirname, "../trilium-fnos/cmd");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trilium-callback-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, "var/trilium-data");
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(path.join(dir, "cmd"));
  const env = { ...process.env, TRIM_PKGVAR: path.join(dir, "var"), TRIM_APPDEST: path.join(dir, "target"), TRIM_DATA_SHARE_PATHS: path.join(dir, "backups") };
  fs.copyFileSync(path.join(cmd, "upgrade_init"), path.join(dir, "cmd/upgrade_init"));
  return { dir, data, env, run: () => spawnSync("bash", [path.join(dir, "cmd/upgrade_init")], { env, encoding: "utf8" }) };
}

test("manual FPK upgrade stops first, validates the archive and keeps the original data", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.data, "document.txt"), "original");
  fs.writeFileSync(path.join(f.dir, "cmd/main"), '#!/bin/bash\n[ "$1" = stop ] || exit 9\nprintf stopped > "$TRIM_PKGVAR/trilium-data/stop-marker"\n', { mode: 0o755 });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const names = fs.readdirSync(f.env.TRIM_DATA_SHARE_PATHS);
  assert.equal(names.length, 1);
  assert.match(names[0], /\.tar\.gz$/);
  const archive = path.join(f.env.TRIM_DATA_SHARE_PATHS, names[0]);
  assert.equal(execFileSync("tar", ["-xzOf", archive, "./stop-marker"], { encoding: "utf8" }), "stopped");
  assert.equal(execFileSync("tar", ["-xzOf", archive, "./document.txt"], { encoding: "utf8" }), "original");
  assert.equal(fs.readFileSync(path.join(f.data, "document.txt"), "utf8"), "original");
});

test("manual upgrade refuses to back up when stop is refused", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, "cmd/main"), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
  assert.equal(f.run().status, 1);
  assert.deepEqual(fs.readdirSync(f.env.TRIM_DATA_SHARE_PATHS), []);
});

test("install callback is idempotent and preserves an existing runtime and data", t => {
  const f = fixture(t);
  const runtime = path.join(f.env.TRIM_PKGVAR, "runtime");
  const selected = path.join(f.dir, "kept-runtime");
  fs.mkdirSync(runtime); fs.mkdirSync(selected);
  fs.writeFileSync(path.join(selected, "VERSION"), "0.106.0");
  fs.symlinkSync(selected, path.join(runtime, "current"));
  fs.writeFileSync(path.join(f.data, "document.txt"), "keep");
  for (let index = 0; index < 2; index++) {
    const result = spawnSync("bash", [path.join(cmd, "install_callback")], { env: f.env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(fs.readlinkSync(path.join(runtime, "current")), selected);
  assert.equal(fs.readFileSync(path.join(runtime, "current-version"), "utf8"), "0.106.0");
  assert.equal(fs.readFileSync(path.join(f.data, "document.txt"), "utf8"), "keep");
});
