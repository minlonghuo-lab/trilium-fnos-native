"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../trilium-fnos/app/proxy/public/sync.js"), "utf8");

test("editor startup does not query APIs; sync menu navigates within the gateway", () => {
  let destination;
  const listeners = {};
  const item = { dataset: {}, setAttribute() {}, addEventListener(name, fn) { listeners[name] = fn; } };
  const menu = { querySelector: selector => selector.includes("openAboutDialog") ? {} : null, insertBefore() {} };
  vm.runInNewContext(source, {
    URL, window: { addEventListener() {}, location: { assign(value) { destination = value; } } },
    MutationObserver: class { observe() {} disconnect() {} },
    document: { readyState: "complete", currentScript: { src: "https://nas.example/app/trilium-fnos/__fnos/assets/sync.js" },
      body: { hasAttribute: () => false }, querySelectorAll: () => [menu], createElement: () => item },
    fetch() { throw new Error("No network calls allowed on editor startup"); }
  });
  listeners.click({ preventDefault() {}, stopPropagation() {} });
  assert.equal(destination, "https://nas.example/app/trilium-fnos/__fnos/");
  assert.match(item.innerHTML, /电脑端同步/);
  assert.doesNotMatch(source, /api\/update|progressToken|setInterval|releases\/latest/);
});

test("sync styles are scoped and have responsive, keyboard and dark-theme support", () => {
  const css = fs.readFileSync(path.join(__dirname, "../trilium-fnos/app/proxy/public/sync.css"), "utf8");
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /focus-visible/);
  assert.match(css, /max-width: 480px/);
  assert.doesNotMatch(css, /position:\s*fixed/);
});
