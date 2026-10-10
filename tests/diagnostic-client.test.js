"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../trilium-fnos/app/proxy/public/diagnostics.js"), "utf8");
const attempt = "abcdef0123456789abcdef01";

function harness(options = {}) {
  const origin = options.origin || "https://private-nas.example";
  const prefix = options.prefix || "/app/trilium-fnos/";
  const location = new URL(options.locationUrl || `${origin}${prefix}?password=secret-note-query#private-note`);
  const listeners = new Map();
  const timers = new Map();
  const beacons = [];
  const scripts = [];
  const links = [];
  const probes = [];
  const fetches = [];
  const observers = [];
  let now = 0;
  let timerId = 0;
  let root = options.splash ? { hidden: false, getAttribute: () => null } : null;
  function listen(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); }
  function unlisten(type, fn) { listeners.get(type)?.delete(fn); }
  function node(tagName, values = {}, attrs = {}) {
    return Object.assign({ tagName, type: "", src: "", href: "", rel: "", removed: false,
      getAttribute(name) { return Object.hasOwn(attrs, name) ? attrs[name] : null; },
      hasAttribute(name) { return Object.hasOwn(attrs, name); },
      remove() { this.removed = true; const index = scripts.indexOf(this); if (index >= 0) scripts.splice(index, 1); }
    }, values);
  }
  const owner = node("SCRIPT", { src: `${origin}${prefix}__fnos/assets/diagnostics.js` }, { "data-fnos-diagnostic": options.attempt ?? attempt });
  const document = {
    currentScript: owner, readyState: options.ready || "loading", body: options.body ? {} : null,
    head: { appendChild(value) { scripts.push(value); probes.push(value); } }, documentElement: {},
    getElementById(id) { return id === "splash" ? root : id === "splash-status" ? { textContent: options.status || "" } : null; },
    createElement(tag) { return node(tag.toUpperCase()); },
    querySelectorAll(selector) { return selector.startsWith("script") ? scripts.filter(value => value.type === "module") : links.filter(value => value.rel === "modulepreload"); },
    addEventListener: listen, removeEventListener: unlisten
  };
  const window = { glob: options.glob, addEventListener: listen, removeEventListener: unlisten,
    getComputedStyle(value) { return { display: value.hidden ? "none" : "block", visibility: "visible" }; } };
  if (options.early) window.__fnosDiagnosticEarly = options.early;
  if (options.localFetch) window.standaloneApi = { localFetch() { throw Error("must never call bridge"); } };
  window.top = options.framed ? {} : window;
  const performance = { now: () => now, getEntriesByType: () => options.resources || [] };
  const context = {
    URL, WeakMap, WeakSet, Set, Date, document, window, location, performance,
    navigator: { userAgent: options.ua || "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) FNAppVer/1.15.2 PrivateDeviceName" },
    Image: class { set src(value) { beacons.push(new URL(value)); } },
    MutationObserver: class { constructor(fn) { this.fn = fn; this.disconnected = false; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } },
    AbortController,
    fetch(url, settings) {
      fetches.push({ url, settings });
      if (options.fetch) return options.fetch(url, settings);
      return new Promise((resolve, reject) => settings.signal.addEventListener("abort", () => reject(Error("aborted"))));
    },
    setTimeout(fn, delay) { timers.set(++timerId, { fn, due: now + delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.runInNewContext(source, context);
  function emit(type, event = {}) { for (const fn of [...(listeners.get(type) || [])]) fn(event); }
  function mutate() { for (const observer of observers) if (!observer.disconnected) observer.fn(); }
  async function advance(duration) {
    const end = now + duration;
    for (;;) {
      const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
      if (!next || next[1].due > end) break;
      now = next[1].due; timers.delete(next[0]); next[1].fn();
      for (let tick = 0; tick < 12; tick++) await Promise.resolve();
    }
    now = end;
    for (let tick = 0; tick < 12; tick++) await Promise.resolve();
  }
  const records = () => beacons.map(url => ({ event: url.pathname.match(/\/([^/]+)\.gif$/)[1], fields: Object.fromEntries(url.searchParams), url }));
  return { document, window, context, scripts, links, probes, fetches, timers, listeners, observers, beacons, emit, mutate, advance, records, node,
    setSplash(value = true) { root = value ? { hidden: false, getAttribute: () => null } : null; mutate(); },
    hideSplash() { if (root) root.hidden = true; mutate(); },
    activeProbe() { return probes.findLast(value => !value.removed); }
  };
}

test("diagnostics starts in the head without mistaking the absent body/splash for success", async () => {
  const h = harness({ glob: {} });
  assert.equal(h.records()[0].event, "start");
  assert.deepEqual(h.records()[0].fields, { protocol: "https", opaque: "false", base_same: "true", script_same: "true", framed: "false", client: "ios", app_ver: "1.15.2", ready: "loading", base: "gateway" });
  await h.advance(500);
  assert.equal(h.records().find(value => value.event === "dom").fields.splash, "absent");
  assert.equal(h.records().some(value => value.event === "finish"), false);
  assert.ok(h.timers.size);
});

test("late async diagnostics recognizes an already-started app and leaves no timers", () => {
  const h = harness({ body: true, ready: "complete", glob: {} });
  assert.deepEqual(h.records().map(value => value.event), ["start", "finish"]);
  assert.equal(h.records()[1].fields.reason, "ready");
  assert.equal(h.timers.size, 0);
  assert.ok(h.observers.every(observer => observer.disconnected));
  assert.equal([...h.listeners.values()].reduce((count, set) => count + set.size, 0), 0);
});

test("asynchronous observer drains pre-module events and continues live entry phase recording", () => {
  let stopped = false;
  const early = { attempt, records: [{ event: "real-error", fields: { kind: "preload", asset: "font" } }, { event: "entry", fields: { phase: "queued", ready: "loading" } }], stop() { stopped = true; } };
  const h = harness({ splash: true, early });
  assert.equal(stopped, true);
  assert.equal(early.records.length, 0);
  assert.equal(h.window.__fnosDiagnosticEarly, undefined);
  assert.equal(h.records().find(value => value.event === "real-error").fields.asset, "font");
  h.emit("fnos:entry-phase", { detail: "inserted" });
  h.emit("fnos:entry-phase", { detail: "private-note" });
  assert.deepEqual(h.records().filter(value => value.event === "entry").map(value => value.fields.phase), ["queued", "inserted"]);
  assert.doesNotMatch(JSON.stringify(h.records()), /private-note/);
});

test("startup error and host bootstrap bridge are classified without calling it or exposing text", async () => {
  const h = harness({ splash: true, localFetch: true, status: "Trilium failed to start: Unable to preload CSS for https://private.example/?note=secret" });
  await h.advance(500);
  const fields = h.records().find(value => value.event === "dom").fields;
  assert.equal(fields.local_fetch, "true");
  assert.equal(fields.failure, "css");
  assert.doesNotMatch(JSON.stringify(h.records()), /private\.example|note=secret/);
});

test("a hung startup completes after 20 seconds, with three bounded probes and no reload", async () => {
  const h = harness({ splash: true });
  await h.advance(20000);
  assert.deepEqual(h.records().filter(value => value.event === "probe-timeout").map(value => value.fields.mode), ["classic", "anonymous", "credentials"]);
  assert.deepEqual(h.records().filter(value => value.event === "fetch").map(value => value.fields.result), ["timeout"]);
  const finished = h.records().at(-1);
  assert.equal(finished.event, "finish");
  assert.equal(finished.fields.reason, "timeout");
  assert.equal(finished.fields.ms, "20000");
  assert.ok(h.records().length <= 36);
  assert.equal(h.probes.length, 3);
  assert.ok(h.probes.every(value => value.removed));
  assert.equal(h.timers.size, 0);
  assert.doesNotMatch(source, /location\.reload|stopPropagation|stopImmediatePropagation|localStorage|sessionStorage|serviceWorker|\beval\s*\(|\bimport\s*\(/);
});

test("success requires splash evidence and glob, then cleans only its own probes/listeners", async () => {
  const h = harness();
  h.setSplash();
  await h.advance(2000);
  const probe = h.activeProbe();
  assert.ok(probe);
  const official = h.node("SCRIPT", { type: "module", src: "https://private-nas.example/app/trilium-fnos/src/index-real.js" });
  h.scripts.push(official);
  h.setSplash(false);
  assert.equal(h.records().some(value => value.event === "finish"), false);
  h.window.glob = {};
  h.mutate();
  assert.equal(h.records().at(-1).fields.reason, "ready");
  assert.equal(probe.removed, true);
  assert.equal(official.removed, false);
  assert.equal(h.timers.size, 0);
  assert.equal([...h.listeners.values()].reduce((count, set) => count + set.size, 0), 0);
  assert.ok(h.observers.every(observer => observer.disconnected));
  const count = h.beacons.length;
  h.emit("error", { target: official });
  await h.advance(30000);
  assert.equal(h.beacons.length, count);
});

test("DOM and resource records contain classifications, never raw URLs or user-agent data", async () => {
  const h = harness({ resources: [{ name: "https://private-nas.example/app/trilium-fnos/bootstrap?secret-token=private" }] });
  const entry = h.node("SCRIPT", { type: "module", src: "https://private-nas.example/app/trilium-fnos/src/index-secret.js?password=private-note" }, { crossorigin: "use-credentials" });
  h.scripts.push(entry);
  const preload = h.node("LINK", { rel: "modulepreload", href: "https://private-nas.example/app/trilium-fnos/src/font-secret.js?note=private-note" });
  h.links.push(preload);
  await h.advance(500);
  h.emit("load", { target: entry });
  h.emit("error", { target: preload });
  h.emit("unhandledrejection", { reason: Error("Failed to fetch dynamically imported module https://private.example/private-note?secret-token=value") });
  h.emit("securitypolicyviolation", { effectiveDirective: "script-src-elem", blockedURI: "https://private.example/private-note" });
  const dom = h.records().find(value => value.event === "dom").fields;
  assert.equal(dom.entry, "gateway");
  assert.equal(dom.credentials, "include");
  assert.equal(dom.bootstrap, "true");
  assert.deepEqual(h.records().find(value => value.event === "real-load").fields, { kind: "entry", asset: "index" });
  assert.deepEqual(h.records().find(value => value.event === "real-error").fields, { kind: "preload", asset: "font" });
  const fields = JSON.stringify(h.records().map(({ event, fields }) => ({ event, fields })));
  assert.doesNotMatch(fields, /private|secret|password|Mozilla|DeviceName|http[s]?:\/\//);
  for (const beacon of h.beacons) {
    assert.equal(beacon.origin, "https://private-nas.example");
    assert.ok(beacon.pathname.startsWith(`/app/trilium-fnos/__fnos/diagnostics/${attempt}/`));
  }
  // Events are observed, not cancelled or forwarded as arbitrary message text.
  assert.equal(h.records().find(value => value.event === "error").fields.reason, "module");
});

test("probe load and execution acknowledgements are separate and credentials are explicit", async () => {
  const h = harness({ splash: true, fetch: async () => ({ ok: true, status: 200,
    headers: { get: name => name === "content-type" ? "text/plain; charset=utf-8" : "12" },
    arrayBuffer: async () => new Uint8Array(12).buffer }) });
  await h.advance(2000);
  let probe = h.activeProbe();
  assert.equal(probe.type, "");
  assert.equal(probe.crossOrigin, undefined);
  assert.equal(new URL(probe.src).pathname, "/app/trilium-fnos/src/__fnos_probe_classic.js");
  h.emit("fnos:probe-executed", { detail: "credentials" });
  assert.equal(h.records().filter(value => value.event === "probe-executed").length, 0);
  h.emit("fnos:probe-executed", { detail: "classic" });
  h.emit("fnos:probe-executed", { detail: "classic" });
  probe.onload();
  probe = h.activeProbe();
  assert.equal(probe.type, "module");
  assert.equal(probe.crossOrigin, "anonymous");
  probe.onerror();
  probe = h.activeProbe();
  assert.equal(probe.crossOrigin, "use-credentials");
  // A module can fire load without the expected acknowledgement: don't conflate.
  probe.onload();
  await h.advance(0);
  assert.deepEqual(h.records().filter(value => value.event === "probe-executed").map(value => value.fields.mode), ["classic"]);
  assert.deepEqual(h.records().filter(value => value.event === "probe-load").map(value => value.fields.mode), ["classic", "credentials"]);
  assert.deepEqual(h.records().filter(value => value.event === "probe-error").map(value => value.fields.mode), ["anonymous"]);
  assert.deepEqual(h.records().find(value => value.event === "fetch").fields, { result: "ok", status: "200", mime: "text", bytes: "12", ms: "0" });
  assert.equal(h.fetches.length, 1);
  assert.equal(h.fetches[0].settings.credentials, "same-origin");
  assert.equal(h.fetches[0].settings.cache, "no-store");
});

test("fetch reports a substituted HTML MIME without transmitting or buffering its content", async () => {
  let cancelled = false;
  const h = harness({ splash: true, fetch: async () => ({ ok: true, status: 200,
    headers: { get: name => name === "content-type" ? "text/html" : "99999999" },
    body: { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(6000) }), cancel: async () => { cancelled = true; } }) } }) });
  await h.advance(14000);
  const result = h.records().find(value => value.event === "fetch").fields;
  assert.equal(result.mime, "html");
  assert.equal(result.bytes, "4096");
  assert.equal(cancelled, true);
});

test("record count remains bounded under repeated errors, with a reserved finish record", async () => {
  const h = harness({ splash: true });
  for (let count = 0; count < 100; count++) h.emit("unhandledrejection", { reason: "unknown private failure" });
  for (let count = 0; count < 100; count++) {
    const target = h.node("LINK", { rel: "modulepreload", href: `https://private-nas.example/app/trilium-fnos/src/unknown-${count}.js` });
    h.emit("load", { target });
    h.emit("error", { target });
  }
  await h.advance(20000);
  assert.ok(h.records().length <= 36);
  assert.equal(h.records().filter(value => value.event === "error").length, 1);
  assert.equal(h.records().filter(value => value.event.startsWith("real-")).length, 2);
  assert.equal(h.records().filter(value => value.event === "probe-start").length, 3);
  assert.equal(h.records().filter(value => value.event === "fetch").length, 1);
  assert.equal(h.records().at(-1).event, "finish");
  assert.equal(h.records().at(-1).fields.reason, "timeout");
});

test("opaque custom origins are recorded and all probes/beacons stay anchored to the injected script", async () => {
  const h = harness({ locationUrl: "fnosapp://private-client/app/trilium-fnos/?secret=private", ua: "Unknown/private-raw-ua" });
  const first = h.records()[0].fields;
  assert.equal(first.protocol, "custom");
  assert.equal(first.opaque, "true");
  assert.equal(first.base_same, "false");
  assert.equal(first.script_same, "false");
  assert.equal(first.app_ver, undefined);
  await h.advance(20000);
  assert.equal(h.probes.length, 3);
  for (const url of [...h.beacons, ...h.probes.map(value => new URL(value.src)), ...h.fetches.map(value => new URL(value.url))]) {
    assert.equal(url.origin, "https://private-nas.example");
    assert.ok(url.pathname.startsWith("/app/trilium-fnos/"));
  }
  assert.equal(h.records().at(-1).fields.reason, "timeout");
});

test("pagehide aborts only the diagnostic fetch and immediately records/cleans up", async () => {
  const h = harness({ splash: true });
  await h.advance(14000);
  assert.equal(h.fetches.length, 1);
  h.emit("pagehide");
  assert.equal(h.records().at(-1).fields.reason, "pagehide");
  assert.equal(h.fetches[0].settings.signal.aborted, true);
  assert.equal(h.timers.size, 0);
});

test("missing or malformed attempt capabilities cause no listeners, traffic or timers", () => {
  for (const value of ["", "x".repeat(24), `${attempt}/private`, "abc"]) {
    const h = harness({ attempt: value });
    assert.equal(h.beacons.length, 0);
    assert.equal(h.timers.size, 0);
    assert.equal(h.listeners.size, 0);
  }
});

test("phone app version comes only from FNAppVer, never the FNOS system marker", () => {
  const app = harness({ ua: "FNOS/1.2.0701 FNAppType/iOS FNAppVer/1.37.0" });
  assert.equal(app.records()[0].fields.client, "ios");
  assert.equal(app.records()[0].fields.app_ver, "1.37.0");
  const system = harness({ ua: "FNOS/1.2.0701" });
  assert.equal(system.records()[0].fields.app_ver, undefined);
  const android = harness({ ua: "FNAppType/Android FNAppVer/1.38.2" });
  assert.equal(android.records()[0].fields.client, "android");
  assert.equal(android.records()[0].fields.app_ver, "1.38.2");
});
