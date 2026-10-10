"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { deferEntry, needsDeferredEntry } = require("../trilium-fnos/app/proxy/ios-entry");
const source = fs.readFileSync(path.join(__dirname, "../trilium-fnos/app/proxy/public/startup.js"), "utf8");
const html = '<head><script type="module" crossorigin src="./src/index-2IAUW27Z.js"></script><link rel="modulepreload" crossorigin href="./src/font-DMVOl4cV.js"><link rel="stylesheet" href="./src/theme.css"></head>';

test("compatibility changes only a positively marked iOS App on the fnOS gateway", () => {
  const ios = { "user-agent": "Mozilla/5.0 (iPhone) FNAppType/iOS FNAppVer/1.37.0" };
  assert.equal(needsDeferredEntry(ios, true), true);
  for (const ua of ["Mozilla/5.0 iPhone Safari", "FNAppType/Android FNAppVer/1.37.0", "Chrome/130", "FNAppType/iOS-malformed", ""]) {
    assert.equal(needsDeferredEntry({ "user-agent": ua }, true), false);
  }
  assert.equal(needsDeferredEntry(ios, false), false);
});

test("HTML has no executable initial entry or preload, retaining exact source and stylesheet", () => {
  const result = deferEntry(html);
  assert.equal(result.deferred, true);
  assert.doesNotMatch(result.html, /type="module"|rel="modulepreload"|\ssrc=/);
  assert.match(result.html, /data-fnos-entry-src="\.\/src\/index-2IAUW27Z.js"/);
  assert.match(result.html, /crossorigin/);
  assert.match(result.html, /<link rel="stylesheet" href="\.\/src\/theme.css">/);
  assert.deepEqual(deferEntry(result.html), { html: result.html, deferred: false });
});

test("unexpected entry layouts preserve the upstream HTML instead of partially disabling startup", () => {
  for (const input of ["<head></head>", html.replace("index-2IAUW27Z", "unknown"), html + '<script type="module" src="./src/extra.js"></script>', html.replace("./src/index-2IAUW27Z.js", "https://other.example/index-x.js")]) {
    assert.deepEqual(deferEntry(input), { html: input, deferred: false });
  }
});

function harness({ src = "./src/index-2IAUW27Z.js", count = 1, ready = "loading", diagnostic = false, resourceRoot = "" } = {}) {
  const listeners = new Map();
  const timers = new Map();
  const inserted = [];
  const attrs = { "data-fnos-entry-src": src, crossorigin: "anonymous", integrity: "sha256-preserved", referrerpolicy: "same-origin", nonce: "preserved" };
  const placeholder = { getAttribute: name => attrs[name], hasAttribute: name => Object.hasOwn(attrs, name), replaceWith(value) { inserted.push(value); } };
  let id = 0;
  function listen(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); }
  function remove(name, fn) { listeners.get(name)?.delete(fn); }
  function emit(name, event = {}) { for (const fn of [...(listeners.get(name) || [])]) fn(event); }
  const document = {
    readyState: ready,
    currentScript: { src: "https://nas.example/app/trilium-fnos/__fnos/assets/startup.js", getAttribute: name => name === "data-fnos-resource-root" ? resourceRoot : name === "data-fnos-entry" ? "deferred" : diagnostic && name === "data-fnos-diagnostic" ? "abcdef0123456789abcdef01" : null },
    getElementById: () => ({ parentNode: {} }),
    querySelectorAll: () => Array(count).fill(placeholder),
    addEventListener: listen,
    createElement: () => ({ attrs: {}, listeners: {}, setAttribute(name, value) { this.attrs[name] = value; }, addEventListener(name, fn) { this.listeners[name] = fn; } })
  };
  const window = { addEventListener: listen, removeEventListener: remove, dispatchEvent: event => emit(event.type, event) };
  vm.runInNewContext(source, {
    URL, Event, WeakMap, Set, Date, document, window,
    location: { href: "https://nas.example/app/trilium-fnos/?login", origin: "https://nas.example" },
    CustomEvent: class { constructor(type, settings) { this.type = type; this.detail = settings.detail; } },
    Image: class {}, sessionStorage: { removeItem() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout(fn, delay) { timers.set(++id, { fn, delay }); return id; }, clearTimeout: timer => timers.delete(timer)
  });
  return { document, window, timers, inserted, emit, listeners };
}

test("after DOM parsing the exact upstream entry is inserted only once with its security attributes", () => {
  const h = harness();
  assert.equal(h.inserted.length, 0);
  h.document.readyState = "interactive";
  h.emit("DOMContentLoaded"); h.emit("DOMContentLoaded");
  assert.equal(h.inserted.length, 1);
  assert.equal(h.inserted[0].type, "module");
  assert.equal(h.inserted[0].src, "https://nas.example/app/trilium-fnos/src/index-2IAUW27Z.js");
  assert.deepEqual(h.inserted[0].attrs, { crossorigin: "anonymous", integrity: "sha256-preserved", referrerpolicy: "same-origin", nonce: "preserved", "data-fnos-live-entry": "true" });
  h.inserted[0].listeners.error();
  assert.equal(h.inserted.length, 1); // An error never inserts a second module.
});

test("late loader starts immediately and unsafe or ambiguous placeholders never execute", () => {
  assert.equal(harness({ ready: "complete" }).inserted.length, 1);
  for (const options of [{ count: 2 }, { count: 0 }, { src: "https://other.example/src/index-x.js" }, { src: "./api/index-x.js" }, { src: "./src/index-x.js?private=1" }, { src: "./src/index-x.js#private" }]) {
    const h = harness({ ...options, ready: "complete" });
    assert.equal(h.inserted.length, 0);
  }
});

test("versioned loader permits only the exact official namespace and rejects stale entry paths", () => {
  const resourceRoot = "__fnos/static/v0.106.0-p1/src/";
  const h = harness({ src: `./${resourceRoot}index-2IAUW27Z.js`, resourceRoot, ready: "complete" });
  assert.equal(h.inserted.length, 1);
  assert.equal(h.inserted[0].src, `https://nas.example/app/trilium-fnos/${resourceRoot}index-2IAUW27Z.js`);
  assert.equal(harness({ resourceRoot, ready: "complete" }).inserted.length, 0);
  assert.equal(harness({ resourceRoot: "api/", src: "./api/index-secret.js", ready: "complete" }).inserted.length, 0);
});

test("early diagnostics is bounded, redacts errors and passes live entry phases after handoff", () => {
  const h = harness({ diagnostic: true });
  const early = h.window.__fnosDiagnosticEarly;
  h.emit("error", { message: "SyntaxError https://private.example/?secret=note", target: h.window });
  for (let i = 0; i < 30; i++) h.emit("unhandledrejection", { reason: `private ${i}` });
  assert.ok(early.records.length <= 12);
  assert.ok(early.records.some(value => value.event === "error" && value.fields.reason === "syntax"));
  assert.doesNotMatch(JSON.stringify(early.records), /private|secret|https/);
  early.stop();
  const phases = [];
  h.window.addEventListener("fnos:entry-phase", event => phases.push(event.detail));
  h.document.readyState = "interactive"; h.emit("DOMContentLoaded");
  h.inserted[0].listeners.load();
  assert.deepEqual(phases, ["inserted", "load"]);
  assert.equal([...h.timers.values()].some(timer => timer.delay === 20000), false);
});
