(() => {
  "use strict";
  // Runs before Trilium's module entry. Only recover startup resources, never
  // replay an API request, form submission or a request containing note data.
  const script = document.currentScript;
  const base = new URL("../../", script.src);
  const resourceRoot = script.getAttribute?.("data-fnos-resource-root") === "__fnos/static/v0.106.0-p1/src/"
    ? `${base.pathname}__fnos/static/v0.106.0-p1/src/` : `${base.pathname}src/`;
  const diagnosticAttempt = script.getAttribute?.("data-fnos-diagnostic") || "";
  const diagnostic = /^[a-f0-9]{24}$/.test(diagnosticAttempt);
  let early;
  if (diagnostic) {
    // Capture before parser-created resources can finish/fail. Store only
    // classifications, not Error objects, URLs, DOM nodes or private strings.
    const records = [];
    const seen = new Set();
    let stopped = false;
    let expiry;
    function record(event, fields) {
      if (stopped || records.length >= 12) return;
      const key = `${event}:${JSON.stringify(fields)}`;
      if (seen.has(key)) return;
      seen.add(key); records.push({ event, fields });
    }
    function resource(event, outcome) {
      const node = event.target;
      if (!node || !["SCRIPT", "LINK"].includes(node.tagName)) return false;
      let url;
      try { url = new URL(node.src || node.href, location.href); } catch { return false; }
      if (url.origin !== base.origin || !url.pathname.startsWith(resourceRoot)) return false;
      const name = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
      if (!/\.(?:js|css)$/.test(name)) return false;
      const prefixes = [["index-", "index"], ["font-", "font"], ["splash-", "splash"], ["theme-", "theme"], ["preload-helper-", "helper"]];
      const asset = prefixes.find(([prefix]) => name.startsWith(prefix))?.[1] || "other";
      const kind = node.tagName === "SCRIPT" && node.type === "module" && asset === "index" ? "entry"
        : node.tagName === "LINK" && node.rel === "modulepreload" ? "preload"
        : node.tagName === "LINK" && node.rel === "stylesheet" ? "css" : null;
      if (!kind) return false;
      record(`real-${outcome}`, { kind, asset });
      return true;
    }
    function errorReason(value) {
      let text = "";
      try { text = typeof value === "string" ? value : typeof value?.message === "string" ? value.message : ""; } catch { /* Classification only. */ }
      return /cors|cross.origin/i.test(text) ? "cors" : /content security|csp|script-src/i.test(text) ? "csp"
        : /syntax|unexpected token/i.test(text) ? "syntax" : /module|import/i.test(text) ? "module"
        : /network|failed to fetch|load failed/i.test(text) ? "network" : "other";
    }
    const load = event => resource(event, "load");
    const error = event => { if (!resource(event, "error") && (event.target === window || !event.target)) record("error", { reason: errorReason(event.message) }); };
    const rejection = event => record("error", { reason: errorReason(event.reason) });
    const csp = event => record("csp", { directive: ["script-src", "script-src-elem", "connect-src", "style-src"].includes(event.effectiveDirective) ? event.effectiveDirective : "other" });
    function stop() {
      stopped = true; clearTimeout(expiry);
      window.removeEventListener("load", load, true);
      window.removeEventListener("error", error, true);
      window.removeEventListener("unhandledrejection", rejection);
      window.removeEventListener("securitypolicyviolation", csp);
    }
    early = { attempt: diagnosticAttempt, records, record, stop };
    window.__fnosDiagnosticEarly = early;
    window.addEventListener("load", load, true);
    window.addEventListener("error", error, true);
    window.addEventListener("unhandledrejection", rejection);
    window.addEventListener("securitypolicyviolation", csp);
    expiry = setTimeout(() => { stop(); if (window.__fnosDiagnosticEarly === early) delete window.__fnosDiagnosticEarly; records.length = 0; }, 20000);
  }
  if (diagnostic) {
    // Tiny early receipt uses the already-working classic script; the larger
    // observer loads asynchronously and never blocks the actual module graph.
    try {
      const receipt = new Image();
      const url = new URL(`__fnos/diagnostics/${diagnosticAttempt}/start.gif`, base);
      url.searchParams.set("ready", document.readyState);
      window.__fnosDiagnosticEarlyReceipt = receipt;
      receipt.onload = receipt.onerror = () => { delete window.__fnosDiagnosticEarlyReceipt; };
      receipt.src = url.href;
    } catch { /* A blocked diagnostic receipt must not affect real startup. */ }
  }
  const reloadKey = `trilium-fnos-startup-reload:${base.pathname}`;
  const retries = new WeakMap();
  const pending = new Set();
  let finished = false;
  let watchdog;
  let observer;
  let reloadTimer;

  function splash() { return document.getElementById("splash"); }
  function resourceUrl(element) {
    try {
      const url = new URL(element.href || element.src, location.href);
      if (url.origin !== location.origin || !url.pathname.startsWith(resourceRoot)) return null;
      if (!/\.(css|js)$/.test(url.pathname)) return null;
      return url;
    } catch { return null; }
  }
  function cancelRetry(state) {
    clearTimeout(state.timer);
    pending.delete(state);
  }
  function finish() {
    finished = true;
    clearTimeout(watchdog);
    clearTimeout(reloadTimer);
    for (const state of pending) cancelRetry(state);
    observer?.disconnect();
    window.removeEventListener("error", resourceError, true);
    window.removeEventListener("vite:preloadError", preloadError);
    try { sessionStorage.removeItem(reloadKey); } catch { /* Optional storage. */ }
  }
  function showFailure(message, allowReload) {
    const root = splash();
    if (finished || !root) return;
    let panel = document.getElementById("fnos-startup-recovery");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "fnos-startup-recovery";
      panel.setAttribute("role", "alert");
      const text = document.createElement("p");
      text.dataset.fnosStartupMessage = "true";
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "重新加载";
      button.addEventListener("click", () => location.reload());
      panel.append(text, button);
      (root.querySelector(".splash-content") || root).appendChild(panel);
    }
    panel.querySelector("[data-fnos-startup-message]").textContent = message;
    // An import that has already rejected cannot be imported again reliably.
    // Permit one automatic page reload per failed startup, never a reload loop.
    if (allowReload && !reloadTimer) {
      try {
        if (sessionStorage.getItem(reloadKey)) return;
        sessionStorage.setItem(reloadKey, "1");
      } catch { return; } // Storage-disabled WebViews get the manual button.
      reloadTimer = setTimeout(() => { if (!finished && splash()) location.reload(); }, 1500);
    }
  }
  function resourceError(event) {
    if (diagnostic) return; // Observe the unmodified failure; no retry/reload.
    const element = event.target;
    if (finished || !element || !["LINK", "SCRIPT"].includes(element.tagName)) return;
    const url = resourceUrl(element);
    if (!url) return;
    // modulepreload is only a hint; its failure need not fail the actual import.
    if (element.tagName === "LINK" && element.rel !== "stylesheet") return;
    if (element.tagName !== "LINK" || !url.pathname.endsWith(".css")) {
      showFailure("启动脚本加载失败，正在尝试重新连接。仍无法进入时，请重新加载。", true);
      return;
    }
    const state = retries.get(element) || { count: 0, timer: null };
    cancelRetry(state);
    if (state.count >= 2) {
      showFailure("样式资源加载失败。请检查飞牛远程连接后重新加载。", true);
      return; // Let Trilium report the real error after the bounded retries.
    }
    // Capture before Vite's target listener rejects its startup promise. Keep
    // that listener on the SAME link: a successful retry resolves the promise.
    event.stopImmediatePropagation();
    state.count++;
    retries.set(element, state);
    pending.add(state);
    element.addEventListener("load", () => cancelRetry(state), { once: true });
    state.timer = setTimeout(() => {
      if (finished) return cancelRetry(state);
      url.searchParams.set("fnos_resource_retry", `${Date.now()}-${state.count}`);
      element.href = url.href;
      state.timer = setTimeout(() => element.dispatchEvent(new Event("error")), 15000);
    }, state.count * 500);
  }
  function preloadError() {
    if (diagnostic) return;
    showFailure("启动资源未加载完成，正在尝试重新连接。仍无法进入时，请重新加载。", true);
  }
  window.addEventListener("error", resourceError, true);
  window.addEventListener("vite:preloadError", preloadError);
  // Start now, not at DOMContentLoaded: a hanging module request can prevent
  // DOMContentLoaded itself from firing even though the splash is visible.
  watchdog = setTimeout(() => showFailure("加载时间较长，可能有资源未能通过飞牛连接加载。可以重新加载再试。", false), 60000);
  document.addEventListener("DOMContentLoaded", () => {
    const root = splash();
    if (!root) return finish();
    observer = new MutationObserver(() => { if (!splash()) finish(); });
    observer.observe(root.parentNode, { childList: true });
  }, { once: true });

  if (script.getAttribute?.("data-fnos-entry") === "deferred") {
    let inserted = false;
    function entrySignal(phase) {
      early?.record("entry", { phase, ready: document.readyState });
      if (diagnostic) window.dispatchEvent(new CustomEvent("fnos:entry-phase", { detail: phase }));
    }
    entrySignal("queued");
    function startEntry() {
      if (inserted) return;
      inserted = true; // Never retry a module that may already have evaluated.
      const placeholders = document.querySelectorAll("script[data-fnos-deferred-entry]");
      const placeholder = placeholders.length === 1 ? placeholders[0] : null;
      let url;
      try { url = new URL(placeholder?.getAttribute("data-fnos-entry-src"), location.href); } catch { /* Fail closed. */ }
      if (!placeholder || !url || url.origin !== base.origin || !url.pathname.startsWith(`${resourceRoot}index-`) || !/\/index-[A-Za-z0-9_-]+\.js$/.test(url.pathname) || url.search || url.hash) {
        entrySignal("invalid");
        return;
      }
      const entry = document.createElement("script");
      entry.type = "module";
      // Copy the original security attributes; keep credentials behavior the
      // same as upstream. No eval, Blob, injected import source or API replay.
      for (const name of ["crossorigin", "integrity", "referrerpolicy", "nonce"]) {
        if (placeholder.hasAttribute(name)) entry.setAttribute(name, placeholder.getAttribute(name));
      }
      entry.setAttribute("data-fnos-live-entry", "true");
      entry.src = url.href;
      entry.addEventListener("load", () => entrySignal("load"), { once: true });
      entry.addEventListener("error", () => entrySignal("error"), { once: true });
      placeholder.replaceWith(entry);
      entrySignal("inserted");
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startEntry, { once: true });
    else startEntry();
  }
})();
