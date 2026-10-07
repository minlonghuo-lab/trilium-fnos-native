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
      URL, AbortController, setTimeout, clearTimeout,
      window: { addEventListener() {} },
      MutationObserver: class { observe() {} disconnect() {} },
      document: {
        readyState: "complete", querySelectorAll: () => [],
        body: { hasAttribute: () => false },
        currentScript: { src: `https://nas.example${prefix}/__fnos/assets/update.js` }
      },
      fetch: async (url) => { requested = String(url); return { ok: false, status: 401, json: async () => ({ error: "login" }) }; },
      console: { debug() {} }
    });
    assert.equal(requested, `https://nas.example${prefix}/__fnos/api/status`);
});
}

test("manager no longer adds floating controls or overlapping interval polling", () => {
  const css = fs.readFileSync(path.join(__dirname, "../trilium-fnos/app/proxy/public/update.css"), "utf8");
  assert.doesNotMatch(source, /trilium-fnos-update-root|setInterval\(/);
  assert.doesNotMatch(css, /position:\s*fixed|2147483000|bottom:\s*18px/);
  assert.match(source, /data-trigger-command="openAboutDialog"/);
  assert.match(source, /x-trilium-fnos-progress-token/);
});
