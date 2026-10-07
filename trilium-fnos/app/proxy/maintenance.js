"use strict";

const fs = require("node:fs");

const phases = new Set([
  "queued", "checking-release", "inspecting", "downloading", "verifying",
  "extracting", "stopping", "backing-up", "switching", "checking", "rollback"
]);

function validMaintenance(marker, proxyPid, now = Date.now()) {
  const started = Date.parse(marker?.startedAt);
  const updated = Date.parse(marker?.updatedAt);
  return Number.isSafeInteger(proxyPid) && proxyPid > 1 && marker?.proxyPid === proxyPid &&
    typeof marker.taskId === "string" && /^[a-zA-Z0-9_-]{16,128}$/.test(marker.taskId) &&
    phases.has(marker.phase) && Number.isFinite(started) && Number.isFinite(updated) &&
    started <= now && updated >= started && updated <= now && now - started < 2 * 60 * 60 * 1000;
}

if (require.main === module) {
  try {
    const marker = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    process.exitCode = validMaintenance(marker, Number(process.argv[3])) ? 0 : 1;
  } catch { process.exitCode = 1; }
}

module.exports = { validMaintenance };
