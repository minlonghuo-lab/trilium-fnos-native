"use strict";

const fs = require("node:fs");
const path = require("node:path");

async function createColdBackup({ run, dataDir, backupPath }) {
  const partial = `${backupPath}.partial`;
  fs.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  // Do not expose a half-written archive as a valid recovery point. Pre-create
  // with private permissions since the archive contains notes and credentials.
  fs.closeSync(fs.openSync(partial, "wx", 0o600));
  try {
    await run("tar", ["-czf", partial, "-C", dataDir, "."]);
    await run("tar", ["-tzf", partial], { quiet: true });
    fs.renameSync(partial, backupPath);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
}

async function restoreBackup({ run, dataDir, backupPath, failedPath }) {
  // Extract successfully before touching the existing data directory. A corrupt
  // backup or a full disk must not replace working notes with an empty folder.
  const restoreDir = fs.mkdtempSync(path.join(path.dirname(dataDir), ".trilium-restore-"));
  let movedData = false;
  try {
    await run("tar", ["-xzf", backupPath, "-C", restoreDir]);
    if (fs.existsSync(dataDir)) {
      fs.renameSync(dataDir, failedPath);
      movedData = true;
    }
    try { fs.renameSync(restoreDir, dataDir); }
    catch (error) {
      if (movedData && !fs.existsSync(dataDir)) fs.renameSync(failedPath, dataDir);
      throw error;
    }
  } finally {
    if (fs.existsSync(restoreDir)) fs.rmSync(restoreDir, { recursive: true, force: true });
  }
}

module.exports = { createColdBackup, restoreBackup };
