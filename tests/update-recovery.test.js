"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { test } = require("node:test");
const { createColdBackup, restoreBackup } = require("../trilium-fnos/app/proxy/update-recovery");
const exec = promisify(execFile);
const run = (command, args) => exec(command, args);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trilium-recovery-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, "document.db"), "original notes");
  return { root, dataDir, backupPath: path.join(root, "backups/before.tar.gz"), failedPath: path.join(root, "failed-data"), run };
}

test("failed or invalid cold backup is never published as a recovery point", async t => {
  const f = fixture(t);
  await assert.rejects(createColdBackup({ ...f, run: async (_cmd, args) => {
    fs.writeFileSync(args[1], "partial archive");
    throw new Error("disk full");
  } }), /disk full/);
  assert.equal(fs.existsSync(f.backupPath), false);
  assert.equal(fs.existsSync(`${f.backupPath}.partial`), false);
  assert.equal(fs.readFileSync(path.join(f.dataDir, "document.db"), "utf8"), "original notes");
  await assert.rejects(createColdBackup({ ...f, run: async (_cmd, args) => {
    if (args[0] === "-czf") fs.writeFileSync(args[1], "corrupt archive");
    else throw new Error("archive invalid");
  } }), /archive invalid/);
  assert.equal(fs.existsSync(f.backupPath), false);
});

test("validated backup restores after extraction while preserving failed migrated data", async t => {
  const f = fixture(t);
  await createColdBackup(f);
  assert.equal(fs.statSync(f.backupPath).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(f.dataDir, "document.db"), "migrated notes");
  await restoreBackup(f);
  assert.equal(fs.readFileSync(path.join(f.dataDir, "document.db"), "utf8"), "original notes");
  assert.equal(fs.readFileSync(path.join(f.failedPath, "document.db"), "utf8"), "migrated notes");
  assert.equal(fs.readdirSync(f.root).some(name => name.startsWith(".trilium-restore-")), false);
});

test("corrupt restore archive leaves current data untouched", async t => {
  const f = fixture(t);
  await createColdBackup(f);
  fs.writeFileSync(f.backupPath, "truncated");
  await assert.rejects(restoreBackup(f));
  assert.equal(fs.readFileSync(path.join(f.dataDir, "document.db"), "utf8"), "original notes");
  assert.equal(fs.existsSync(f.failedPath), false);
  assert.equal(fs.readdirSync(f.root).some(name => name.startsWith(".trilium-restore-")), false);
});
