"use strict";

const STABLE_VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function versionParts(value) {
  const match = typeof value === "string" && value.match(STABLE_VERSION);
  if (!match) throw new Error(`不支持的稳定版本号：${String(value)}；已拒绝自动更新。`);
  return match.slice(1).map(part => BigInt(part));
}

function compareStableVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function assertStableRelease(release) {
  if (!release || release.draft || release.prerelease || typeof release.tag_name !== "string" || !release.tag_name.startsWith("v")) {
    throw new Error("官方版本不是公开稳定版，已拒绝自动更新。");
  }
  versionParts(release.tag_name);
}

module.exports = { compareStableVersions, assertStableRelease };
