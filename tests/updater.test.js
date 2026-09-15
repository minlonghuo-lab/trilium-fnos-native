"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../trilium-fnos/app/proxy/public/update.js"), "utf8");

for (const prefix of ["", "/app/trilium-fnos"]) {
  test(`updater resolves API in the script's path: ${prefix || "direct"}`, async () => {
    let requested;
    vm.runInNewContext(source, {
      URL, window: {},
      document: { readyState: "complete", currentScript: { src: `https://nas.example${prefix}/__fnos/assets/update.js` } },
      fetch: async (url) => { requested = String(url); return { ok: false, status: 401, json: async () => ({ error: "login" }) }; },
      console: { debug() {} }
    });
    assert.equal(requested, `https://nas.example${prefix}/__fnos/api/status`);
  });
}
