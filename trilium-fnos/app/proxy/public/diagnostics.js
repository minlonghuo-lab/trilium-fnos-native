(() => {
  "use strict";
  // One short-lived, opt-in attempt. Never read note contents, cookies, form
  // fields, full URLs or storage, and never change Trilium's real resources.
  const owner = document.currentScript;
  const attempt = owner?.getAttribute("data-fnos-diagnostic");
  if (!/^[a-f0-9]{24}$/.test(attempt || "")) return;
  let base;
  try { base = new URL("../../", owner.src); } catch { return; }
  const clock = () => typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
  const started = clock();
  const timers = new Set();
  const images = new Set();
  const nodes = new Set();
  const ownNodes = new WeakSet();
  const seenEvents = new WeakMap();
  const resourceClasses = new Set();
  const errorClasses = new Set();
  const cspClasses = new Set();
  let finished = false;
  let seenSplash = false;
  let eventCount = 0;
  let activeProbe;
  let fetchController;
  let observer;
  const ms = since => Math.max(0, Math.min(22000, Math.round(clock() - since)));
  const ready = () => ["loading", "interactive", "complete"].includes(document.readyState) ? document.readyState : "loading";
  const glob = () => !!window.glob && typeof window.glob === "object";
  function timer(callback, delay) {
    const id = setTimeout(() => { timers.delete(id); if (!finished) callback(); }, delay);
    timers.add(id);
    return id;
  }
  function cancel(id) { clearTimeout(id); timers.delete(id); }
  function pathKind(value) {
    try {
      const url = new URL(value, location.href);
      if (url.origin !== base.origin) return "cross";
      if (url.pathname.startsWith("/app/trilium-fnos/")) return "gateway";
      if (url.pathname.startsWith("/src/") || url.pathname === "/") return "root";
      return "other";
    } catch { return "other"; }
  }
  function asset(value) {
    try {
      const url = new URL(value, location.href);
      if (url.origin !== base.origin || !/(?:^|\/)src\//.test(url.pathname)) return null;
      const name = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
      for (const [prefix, kind] of [["index-", "index"], ["font-", "font"], ["splash-", "splash"], ["theme-", "theme"], ["preload-helper-", "helper"]]) {
        if (name.startsWith(prefix) && /\.(?:js|css)$/.test(name)) return kind;
      }
      return /\.(?:js|css)$/.test(name) ? "other" : null;
    } catch { return null; }
  }
  function splash() {
    const node = document.getElementById("splash");
    if (!node) return "absent";
    seenSplash = true;
    if (node.hidden || node.getAttribute("aria-hidden") === "true") return "hidden";
    try {
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return "hidden";
    } catch { /* A DOM classification should never prevent app startup. */ }
    return "visible";
  }
  function bootstrap() {
    try {
      return performance.getEntriesByType("resource").some(entry => {
        const url = new URL(entry.name, location.href);
        return url.origin === base.origin && (url.pathname === `${base.pathname}bootstrap` || url.pathname === "/bootstrap");
      });
    } catch { return false; }
  }
  function signal(event, fields) {
    // Reserve finish and leave four of the backend's 40 slots for the tiny
    // earlier head marker and loader. The endpoint accepts only this schema.
    if ((finished && event !== "finish") || eventCount >= (event === "finish" ? 36 : 35)) return;
    eventCount++;
    try {
      const url = new URL(`__fnos/diagnostics/${attempt}/${event}.gif`, base);
      for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, String(value));
      const image = new Image();
      images.add(image);
      image.onload = image.onerror = () => { image.onload = image.onerror = null; images.delete(image); };
      image.src = url.href;
    } catch { /* Recording must not affect normal loading. */ }
  }
  function finish(reason) {
    if (finished) return;
    const state = splash();
    signal("finish", { reason, ms: ms(started), ready: ready(), splash: state, glob: glob() });
    finished = true;
    for (const id of timers) clearTimeout(id);
    timers.clear();
    observer?.disconnect();
    window.removeEventListener("load", realLoad, true);
    window.removeEventListener("error", realError, true);
    window.removeEventListener("unhandledrejection", rejection);
    window.removeEventListener("securitypolicyviolation", csp);
    window.removeEventListener("fnos:probe-executed", executed);
    window.removeEventListener("fnos:entry-phase", entryPhase);
    window.removeEventListener("pagehide", pagehide);
    document.removeEventListener("DOMContentLoaded", checkReady);
    fetchController?.abort();
    activeProbe = null;
    for (const node of nodes) {
      node.onload = node.onerror = null;
      node.remove();
    }
    nodes.clear();
  }
  function checkReady() {
    const state = splash();
    // An async diagnostic script may arrive after startup has already finished.
    // An absent splash in the still-parsing head is never sufficient evidence.
    const parsedBody = !!document.body && ready() !== "loading";
    if ((seenSplash || parsedBody) && state !== "visible" && glob()) finish("ready");
  }
  function dom() {
    const modules = [...document.querySelectorAll('script[type="module"]')].filter(node => !ownNodes.has(node));
    const preloads = [...document.querySelectorAll('link[rel="modulepreload"]')];
    const entry = modules.find(node => asset(node.src) === "index") || modules[0];
    let credentials = "absent";
    if (entry?.hasAttribute("crossorigin")) {
      const value = entry.getAttribute("crossorigin");
      credentials = value === "use-credentials" ? "include" : value === "" || value === "anonymous" ? "anonymous" : "other";
    }
    let localFetch = false;
    try { localFetch = typeof window.standaloneApi?.localFetch === "function"; } catch { /* Capability only; never call a host bridge. */ }
    const status = document.getElementById("splash-status")?.textContent || "";
    // Inspect only Trilium's startup status, never editor content or error URLs.
    const failure = !/failed to start|preload css|load failed|syntaxerror/i.test(status) ? "none"
      : /preload css|stylesheet/i.test(status) ? "css" : /syntaxerror|unexpected token/i.test(status) ? "syntax"
      : /module|import/i.test(status) ? "module" : /network|fetch|load failed/i.test(status) ? "network" : "other";
    signal("dom", { modules: Math.min(16, modules.length), preloads: Math.min(16, preloads.length), entry: entry ? pathKind(entry.src) : "missing", credentials, ready: ready(), splash: splash(), glob: glob(), bootstrap: bootstrap(), local_fetch: localFetch, failure });
    checkReady();
  }
  function realResource(event, outcome) {
    const node = event.target;
    if (!node || ownNodes.has(node)) return false;
    const classification = asset(node.src || node.href);
    if (!classification) return false;
    let kind;
    if (node.tagName === "SCRIPT" && node.type === "module" && classification === "index") kind = "entry";
    else if (node.tagName === "LINK" && node.rel === "modulepreload") kind = "preload";
    else if (node.tagName === "LINK" && node.rel === "stylesheet") kind = "css";
    if (!kind) return false;
    const previous = seenEvents.get(node) || new Set();
    if (previous.has(outcome)) return true;
    previous.add(outcome); seenEvents.set(node, previous);
    const key = `${kind}:${classification}:${outcome}`;
    if (resourceClasses.has(key) || resourceClasses.size >= 12) return true;
    resourceClasses.add(key);
    signal(`real-${outcome}`, { kind, asset: classification });
    checkReady();
    return true;
  }
  function realLoad(event) { realResource(event, "load"); }
  function reason(value) {
    // Inspect only to classify; never transmit the original error text or URL.
    let text = "";
    try { text = typeof value === "string" ? value : typeof value?.message === "string" ? value.message : ""; } catch { return "other"; }
    if (/cors|cross.origin/i.test(text)) return "cors";
    if (/content security|csp|script-src/i.test(text)) return "csp";
    if (/syntax|unexpected token/i.test(text)) return "syntax";
    if (/module|import/i.test(text)) return "module";
    if (/network|failed to fetch|load failed/i.test(text)) return "network";
    return "other";
  }
  function realError(event) {
    if (ownNodes.has(event.target)) return;
    if (!realResource(event, "error") && (event.target === window || !event.target)) recordError(event.message);
  }
  function recordError(value) {
    const classification = reason(value);
    if (errorClasses.has(classification) || errorClasses.size >= 3) return;
    errorClasses.add(classification);
    signal("error", { reason: classification });
  }
  function rejection(event) { recordError(event.reason); }
  function csp(event) {
    const directive = ["script-src", "script-src-elem", "connect-src", "style-src"].includes(event.effectiveDirective) ? event.effectiveDirective : "other";
    if (cspClasses.has(directive) || cspClasses.size >= 3) return;
    cspClasses.add(directive);
    signal("csp", { directive });
  }
  function pagehide() { finish("pagehide"); }
  function entryPhase(event) {
    const phase = event.detail;
    if (["queued", "inserted", "load", "error", "invalid"].includes(phase)) signal("entry", { phase, ready: ready() });
  }
  function executed(event) {
    if (!activeProbe || event.detail !== activeProbe.mode || activeProbe.executed) return;
    activeProbe.executed = true;
    signal("probe-executed", { mode: activeProbe.mode, ms: ms(activeProbe.started) });
  }
  function probe(index = 0) {
    if (finished) return;
    if (index >= 3) { probeFetch(); return; }
    const mode = ["classic", "anonymous", "credentials"][index];
    const node = document.createElement("script");
    ownNodes.add(node); nodes.add(node);
    const state = { mode, started: clock(), node, executed: false, done: false, timer: null };
    activeProbe = state;
    function complete(outcome) {
      if (finished || state.done) return;
      state.done = true;
      cancel(state.timer);
      signal(`probe-${outcome}`, { mode, ms: ms(state.started) });
      node.onload = node.onerror = null;
      node.remove(); nodes.delete(node);
      if (activeProbe === state) activeProbe = null;
      probe(index + 1);
    }
    if (mode !== "classic") { node.type = "module"; node.crossOrigin = mode === "credentials" ? "use-credentials" : "anonymous"; }
    node.onload = () => complete("load");
    node.onerror = () => complete("error");
    const url = new URL(`src/__fnos_probe_${mode}.js`, base);
    url.searchParams.set("d", attempt);
    node.src = url.href;
    signal("probe-start", { mode, ms: ms(state.started) });
    state.timer = timer(() => complete("timeout"), 4000);
    (document.head || document.documentElement).appendChild(node);
  }
  async function probeFetch() {
    if (finished) return;
    const since = clock();
    if (typeof fetch !== "function" || typeof AbortController !== "function") {
      signal("fetch", { result: "error", status: 0, mime: "other", bytes: 0, ms: ms(since) });
      return;
    }
    const controller = new AbortController();
    fetchController = controller;
    let settled = false;
    const timeout = timer(() => {
      settled = true;
      controller.abort();
      signal("fetch", { result: "timeout", status: 0, mime: "other", bytes: 0, ms: ms(since) });
    }, 3000);
    try {
      const response = await fetch(new URL(`__fnos/diagnostics/${attempt}/text.txt`, base).href, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      const mime = contentType.includes("text/plain") ? "text" : /(?:java|ecma)script/.test(contentType) ? "js" : contentType.includes("text/html") ? "html" : "other";
      // This endpoint returns a fixed tiny ASCII string, never user content.
      // Stream only the first 4096 bytes, including if a gateway substitutes HTML.
      let bytes = 0;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        try {
          while (bytes < 4096) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += Math.min(value.byteLength, 4096 - bytes);
          }
        } finally { await reader.cancel().catch(() => {}); }
      } else {
        // Do not buffer an unbounded body on old WebViews without streams.
        const length = response.headers.get("content-length");
        if (/^\d{1,4}$/.test(length || "") && Number(length) <= 4096) {
          const body = await response.arrayBuffer();
          bytes = Math.min(4096, body.byteLength);
        }
      }
      if (settled || finished) return;
      settled = true;
      cancel(timeout);
      signal("fetch", { result: response.ok ? "ok" : "http", status: Math.max(0, Math.min(599, Number(response.status) || 0)), mime, bytes, ms: ms(since) });
    } catch {
      if (!settled && !finished) {
        settled = true;
        cancel(timeout);
        signal("fetch", { result: "error", status: 0, mime: "other", bytes: 0, ms: ms(since) });
      }
    } finally { if (fetchController === controller) fetchController = null; }
  }
  window.addEventListener("load", realLoad, true);
  window.addEventListener("error", realError, true);
  window.addEventListener("unhandledrejection", rejection);
  window.addEventListener("securitypolicyviolation", csp);
  window.addEventListener("fnos:probe-executed", executed);
  window.addEventListener("fnos:entry-phase", entryPhase);
  window.addEventListener("pagehide", pagehide);
  document.addEventListener("DOMContentLoaded", checkReady);
  try {
    observer = new MutationObserver(checkReady);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden"] });
  } catch { /* The timed observations remain available. */ }
  let framed = false;
  try { framed = window.top !== window; } catch { framed = true; }
  let client = "unknown";
  let appVersion = "";
  try {
    const ua = navigator.userAgent || "";
    client = /iPhone|iPad|iPod|FNAppType\/iOS/i.test(ua) ? "ios" : /Android|FNAppType\/Android/i.test(ua) ? "android" : /Mozilla|Chrome|Safari|Firefox/.test(ua) ? "browser" : "unknown";
    // FNOS identifies the NAS system, not the phone app version.
    appVersion = (ua.match(/(?:^|\s)FNAppVer\/([0-9]+(?:\.[0-9]+)*)(?=\s|$)/)?.[1] || "").slice(0, 20);
  } catch { /* User-agent access may be unavailable. */ }
  const protocol = location.protocol === "http:" ? "http" : location.protocol === "https:" ? "https" : location.protocol === "file:" ? "file" : /^[a-z][a-z0-9+.-]*:$/.test(location.protocol || "") ? "custom" : "other";
  const startFields = { protocol, opaque: location.origin === "null", base_same: base.origin === location.origin, script_same: (() => { try { return new URL(owner.src, location.href).origin === location.origin; } catch { return false; } })(), framed, client, ready: ready(), base: base.pathname === "/app/trilium-fnos/" ? "gateway" : base.pathname === "/" ? "root" : "other" };
  if (/^[0-9]+(?:\.[0-9]+)*$/.test(appVersion)) startFields.app_ver = appVersion;
  signal("start", startFields);
  const early = window.__fnosDiagnosticEarly;
  if (early?.attempt === attempt && Array.isArray(early.records)) {
    early.stop();
    for (const record of early.records) {
      if (["real-load", "real-error", "error", "csp", "entry"].includes(record.event)) signal(record.event, record.fields);
    }
    early.records.length = 0;
    delete window.__fnosDiagnosticEarly;
  }
  // The head starts without a body/splash: absence here is not proof of success.
  checkReady();
  if (finished) return;
  timer(dom, 500);
  timer(() => { checkReady(); if (!finished) probe(); }, 2000);
  timer(dom, 15000);
  timer(() => finish("timeout"), 20000);
})();
