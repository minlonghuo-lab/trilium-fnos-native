"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../trilium-fnos/app/proxy/public/startup.js"), "utf8");

function harness({ stored = null, storageBlocked = false, prefix = "/app/trilium-fnos/", diagnosticAttempt = null, imageBlocked = false } = {}) {
  const events = {};
  const listeners = new Map();
  function listen(name, callback) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(callback);
    events[name] = event => { for (const fn of [...listeners.get(name)]) fn(event); };
  }
  function unlisten(name, callback) {
    listeners.get(name)?.delete(callback);
    if (!listeners.get(name)?.size) delete events[name];
  }
  const timers = new Map();
  let id = 0;
  let reloads = 0;
  let imageAttempts = 0;
  const receipts = [];
  let root = { querySelector: () => null, appendChild() {}, parentNode: {} };
  let panel;
  const storage = new Map(stored ? [[`trilium-fnos-startup-reload:${prefix}`, stored]] : []);
  function element() {
    return { dataset: {}, children: [], setAttribute() {}, addEventListener() {}, append(...nodes) { this.children.push(...nodes); }, querySelector() { return this.children[0]; } };
  }
  const document = {
    readyState: "loading",
    currentScript: { src: `https://nas.example${prefix}__fnos/assets/startup.js`, getAttribute(name) { return name === "data-fnos-diagnostic" ? diagnosticAttempt : null; } },
    getElementById: name => name === "splash" ? root : panel,
    createElement() { const node = element(); Object.defineProperty(node, "id", { set(value) { if (value === "fnos-startup-recovery") panel = node; } }); return node; },
    addEventListener: listen
  };
  vm.runInNewContext(source, {
    URL, Event, WeakMap, Set, Date, document,
    location: { href: `https://nas.example${prefix}`, origin: "https://nas.example", reload() { reloads++; } },
    window: { addEventListener: listen, removeEventListener: unlisten },
    sessionStorage: { getItem(key) { if (storageBlocked) throw Error("blocked"); return storage.get(key); }, setItem(key, value) { storage.set(key, value); }, removeItem(key) { storage.delete(key); } },
    MutationObserver: class { constructor(callback) { events.mutation = callback; } observe() {} disconnect() {} },
    Image: class {
      constructor() { imageAttempts++; if (imageBlocked) throw Error("Image construction blocked"); }
      set src(value) { receipts.push(new URL(value)); }
    },
    setTimeout(callback, delay) { timers.set(++id, { callback, delay }); return id; },
    clearTimeout(timer) { timers.delete(timer); }
  });
  function run(delay) {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, `expected ${delay}ms timer`);
    timers.delete(entry[0]); entry[1].callback();
  }
  function fail(target) {
    let stopped = false;
    events.error?.({ target, stopImmediatePropagation() { stopped = true; } });
    return stopped;
  }
  function link(url = `https://nas.example${prefix}src/image_compression_dialog-Dv6sENdT.css`) {
    const listeners = {};
    return { tagName: "LINK", rel: "stylesheet", href: url, listeners,
      addEventListener(name, callback) { listeners[name] = callback; },
      dispatchEvent() { fail(this); }
    };
  }
  return { events, timers, storage, receipts, imageAttempts: () => imageAttempts, run, fail, link, removeSplash() { root = null; events.mutation(); }, reloads: () => reloads, panel: () => panel };
}

test("CSS retry preserves the link and resolves the upstream load listener without replaying APIs", () => {
  for (const prefix of ["/", "/app/trilium-fnos/"]) {
    const h = harness({ prefix });
    const link = h.link();
    assert.equal(h.fail(link), true);
    h.run(500);
    const url = new URL(link.href);
    assert.equal(url.pathname, `${prefix}src/image_compression_dialog-Dv6sENdT.css`);
    assert.ok(url.searchParams.has("fnos_resource_retry"));
    link.listeners.load();
    assert.equal(h.timers.size, 1); // Only the startup watchdog remains.
    assert.equal(h.reloads(), 0);
  }
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|api\//);
});

test("persistent CSS failures stop after two retries and only one automatic reload", () => {
  const h = harness();
  const link = h.link();
  assert.equal(h.fail(link), true); h.run(500);
  assert.equal(h.fail(link), true); h.run(1000);
  assert.equal(h.fail(link), false);
  h.events["vite:preloadError"]();
  assert.equal([...h.timers.values()].filter(t => t.delay === 1500).length, 1);
  h.run(1500);
  assert.equal(h.reloads(), 1);
  const nextPage = harness({ stored: "1" });
  nextPage.events["vite:preloadError"]();
  assert.equal(nextPage.timers.size, 1);
  assert.ok(nextPage.panel());
});

test("silent retry timeouts are bounded and missing storage never creates a reload loop", () => {
  const h = harness({ storageBlocked: true });
  h.fail(h.link()); h.run(500); h.run(15000); h.run(1000); h.run(15000);
  assert.equal(h.timers.size, 1);
  assert.ok(h.panel());
  assert.equal(h.reloads(), 0);
});

test("startup watchdog provides a reload button; successful startup cancels all recovery", () => {
  const h = harness();
  h.events.DOMContentLoaded();
  h.run(60000);
  assert.ok(h.panel());
  assert.equal(h.reloads(), 0);
  h.events["vite:preloadError"]();
  h.removeSplash();
  assert.equal(h.timers.size, 0);
  assert.equal(h.storage.size, 0);
  assert.equal(h.events.error, undefined);
});

test("watchdog works even when a stuck initial module prevents DOMContentLoaded", () => {
  const h = harness();
  h.run(60000);
  assert.ok(h.panel());
  assert.equal(h.reloads(), 0);
});

test("cross-origin, API, attachment and unrelated stylesheet errors are not intercepted", () => {
  const h = harness();
  for (const url of ["https://other.example/src/file.css", "https://nas.example/api/file.css", "https://nas.example/app/trilium-fnos/api/note.css", "https://nas.example/app/trilium-fnos/__fnos/assets/sync.css"]) {
    assert.equal(h.fail(h.link(url)), false);
  }
  assert.equal(h.timers.size, 1);
});

test("optional modulepreload errors never force a page reload", () => {
  const h = harness();
  const link = h.link("https://nas.example/app/trilium-fnos/src/chunk.js");
  link.rel = "modulepreload";
  assert.equal(h.fail(link), false);
  assert.equal(h.timers.size, 1);
  assert.equal(h.panel(), undefined);
});

test("a blocked early diagnostic Image never interrupts startup listeners or its watchdog", () => {
  const h = harness({ diagnosticAttempt: "abcdef0123456789abcdef01", imageBlocked: true });
  assert.equal(h.imageAttempts(), 1);
  assert.equal(h.receipts.length, 0);
  assert.equal(typeof h.events.error, "function");
  assert.equal(typeof h.events["vite:preloadError"], "function");
  assert.equal(typeof h.events.DOMContentLoaded, "function");
  assert.equal(h.timers.size, 2); // Early capture expiry and existing watchdog.
  h.run(20000);
  h.run(60000);
  assert.ok(h.panel());
  assert.equal(h.reloads(), 0);
});

test("diagnostic mode observes CSS and module errors without cancellation, retries or automatic reload", () => {
  for (const prefix of ["/", "/app/trilium-fnos/"]) {
    const attempt = "abcdef0123456789abcdef01";
    const h = harness({ prefix, diagnosticAttempt: attempt });
    assert.equal(h.imageAttempts(), 1);
    assert.equal(h.receipts.length, 1);
    assert.equal(h.receipts[0].pathname, `${prefix}__fnos/diagnostics/${attempt}/start.gif`);
    assert.equal(h.receipts[0].searchParams.get("ready"), "loading");
    const link = h.link();
    const originalHref = link.href;
    assert.equal(h.fail(link), false);
    assert.equal(link.href, originalHref);
    assert.equal(link.listeners.load, undefined);
    h.events["vite:preloadError"]();
    assert.equal(h.panel(), undefined);
    assert.equal(h.timers.size, 2); // Bounded early capture plus existing watchdog.
    assert.deepEqual([...h.timers.values()].map(timer => timer.delay).sort((a, b) => a - b), [20000, 60000]);
    assert.equal(h.storage.size, 0);
    assert.equal(h.reloads(), 0);
    h.run(20000); h.run(60000);
    assert.ok(h.panel());
    assert.equal(h.timers.size, 0);
    assert.equal(h.reloads(), 0);
  }
});
