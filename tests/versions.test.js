"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { compareStableVersions, assertStableRelease } = require("../trilium-fnos/app/proxy/versions");

test("stable version ordering compares numeric components, not strings", () => {
  assert.equal(compareStableVersions("v0.110.0", "v0.109.0"), 1);
  assert.equal(compareStableVersions("v0.9.0", "v0.10.0"), -1);
  assert.equal(compareStableVersions("1.0.0", "v1.0.0"), 0);
  assert.equal(compareStableVersions("v1.0.0", "v0.999.999"), 1);
  for (const invalid of ["v01.2.3", "v1.2", "v1.2.3-beta", "v1.2.3+build", "", null]) {
    assert.throws(() => compareStableVersions(invalid, "v1.2.3"), /拒绝自动更新/);
  }
});

test("release metadata rejects drafts, prereleases and malformed stable tags", () => {
  assert.doesNotThrow(() => assertStableRelease({ tag_name: "v0.106.0", draft: false, prerelease: false }));
  for (const release of [
    { tag_name: "v0.106.0", draft: true },
    { tag_name: "v0.106.0", prerelease: true },
    { tag_name: "v0.106.0-beta.1" }, { tag_name: "0.106.0" }, {}, null
  ]) assert.throws(() => assertStableRelease(release), /拒绝自动更新/);
});
