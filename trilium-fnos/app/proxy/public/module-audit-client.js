(() => {
  "use strict";
  const owner = document.currentScript;
  const attempt = document.body.dataset.moduleAudit;
  if (!/^[a-f0-9]{24}$/.test(attempt || "") || !owner) return;
  const auditBase = new URL("./", owner.src);
  const base = new URL("../../../", owner.src);
  if (base.origin !== location.origin) return;
  const button = document.getElementById("audit-start"), results = document.getElementById("audit-results"), status = document.getElementById("audit-status");
  const images = new Set();
  let active = null, running = false, stopped = false, reports = 0, acknowledged = 0, errors = 0;
  const duration = start => Math.min(999999, Math.max(0, Math.round(performance.now() - start)));
  function signal(fields) {
    if (reports >= 76) return;
    reports++;
    const url = new URL("event.gif", auditBase);
    Object.entries(fields).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const image = new Image(); images.add(image);
    const cleanup = ok => { if (!images.has(image)) return; clearTimeout(timer); images.delete(image); image.onload = image.onerror = null; if (ok) acknowledged++; };
    const timer = setTimeout(() => cleanup(false), 6000);
    image.onload = () => cleanup(true); image.onerror = () => cleanup(false); image.src = url.href;
  }
  function item(label) { const node = document.createElement("li"); node.textContent = label + "：测试中…"; results.append(node); return node; }
  const official = { toggle: "FormToggle-ElUrm1Ls.js", index: "index-2IAUW27Z.js", large: "dist-C3UACQzc.js", css: "image_compression_dialog-Dv6sENdT.css" };
  function asset(value) {
    try {
      const url = new URL(value, base);
      if (url.origin !== base.origin) return "other";
      const name = url.pathname.split("/").pop();
      if (Object.values(official).includes(name) || /^(tiny|large|entry|branch|client)\.js$/.test(name) || /^leaf-(?:[0-9]|1[0-9]|2[0-3])\.js$/.test(name)) return name;
    } catch { /* Never report arbitrary URLs or errors. */ }
    return "other";
  }
  window.addEventListener("error", event => {
    if (!running || errors++ >= 12) return;
    const text = String(event.message || "");
    signal({ step: "error", test: active?.profile || "none", result: /syntax|unexpected|parse/i.test(text) ? "syntax" : /module|import/i.test(text) ? "module" : "other", asset: asset(event.filename || event.target?.src || event.target?.href), line: Math.min(99999, event.lineno || 0), column: Math.min(99999, event.colno || 0) });
  }, true);
  window.addEventListener("securitypolicyviolation", () => { if (running && errors++ < 12) signal({ step: "csp", test: active?.profile || "none", result: "csp" }); });
  function scriptTest(profile, label) {
    return new Promise(resolve => {
      const start = performance.now(), node = item(label), script = document.createElement("script"), preloads = [];
      const graph = ["graph", "credentials", "preload", "graph-ecma"].includes(profile);
      const file = graph ? "entry.js" : profile === "tiny" ? "tiny.js" : "large.js";
      const url = new URL(`src/__fnos_audit/${attempt}/${profile}/${file}`, base);
      let loaded = false, done = false;
      function finish(result) {
        if (done) return; done = true; clearTimeout(timer);
        window.removeEventListener("fnos:audit-executed", executed);
        script.onload = script.onerror = null; script.remove(); preloads.forEach(link => link.remove()); active = null;
        node.textContent = `${label}：${{ executed: "已执行", "load-only": "已加载但没有执行回执", error: "模块加载失败", timeout: "超时" }[result]}`;
        signal({ step: "script", test: profile, result, ms: duration(start) }); resolve();
      }
      function executed(event) { if (event.detail === url.href) finish("executed"); }
      const timer = setTimeout(() => finish(loaded ? "load-only" : "timeout"), 8000);
      active = { profile, finish };
      window.addEventListener("fnos:audit-executed", executed);
      if (profile !== "classic") { script.type = "module"; script.crossOrigin = profile === "credentials" ? "use-credentials" : "anonymous"; }
      script.onload = () => { loaded = true; }; script.onerror = () => finish("error");
      if (profile === "preload") {
        for (const name of ["entry.js", "branch.js", ...Array.from({ length: 24 }, (_, i) => `leaf-${i}.js`)]) {
          const link = document.createElement("link"); link.rel = "modulepreload"; link.crossOrigin = "anonymous"; link.href = new URL(name, url).href; preloads.push(link); document.head.append(link);
        }
      }
      script.src = url.href; document.head.append(script);
    });
  }
  async function fetchTest(key, fresh, previous) {
    const label = `${official[key]} / ${fresh ? "新地址" : "原地址"}`, test = `${key}-${fresh ? "fresh" : "old"}`, node = item(label), start = performance.now();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
    try {
      const url = fresh ? new URL(`official/${key}`, auditBase) : new URL(`src/${official[key]}`, base);
      const response = await fetch(url, { credentials: "same-origin", cache: fresh ? "no-store" : "default", signal: controller.signal });
      const rawType = response.headers.get("content-type") || "";
      const mime = /javascript/i.test(rawType) ? "js" : /ecmascript/i.test(rawType) ? "ecma" : /text\/css/i.test(rawType) ? "css" : /text\/html/i.test(rawType) ? "html" : "other";
      const rawEncoding = response.headers.get("content-encoding");
      const encoding = rawEncoding === null ? "none" : ["gzip", "br", "identity"].includes(rawEncoding) ? rawEncoding : "other";
      if (Number(response.headers.get("content-length")) > 1048576) throw new Error("Bounded response exceeded");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 1048576) throw new Error("Bounded response exceeded");
      let result = response.ok && (key === "css" ? mime === "css" : mime === "js") ? "ok" : "http";
      if (result === "ok" && fresh && previous && (previous.length !== bytes.length || previous.some((value, i) => value !== bytes[i]))) result = "mismatch";
      node.textContent = `${label}：HTTP ${response.status}，${mime}，${bytes.length} 字节，编码 ${encoding}${result === "mismatch" ? "（新旧正文不同）" : ""}`;
      signal({ step: "fetch", test, result, status: response.status, bytes: Math.min(999999, bytes.length), encoding, mime, ms: duration(start) });
      return result === "ok" ? bytes : null;
    } catch (error) {
      const result = error.name === "AbortError" ? "timeout" : "error";
      node.textContent = `${label}：${result === "timeout" ? "超时" : "请求失败"}`;
      signal({ step: "fetch", test, result, ms: duration(start) }); return null;
    } finally { clearTimeout(timer); }
  }
  async function representation(profile) {
    const graph = ["graph", "credentials", "preload", "graph-ecma"].includes(profile);
    const file = graph ? "leaf-0.js" : profile === "tiny" ? "tiny.js" : "large.js";
    const node = item(`${profile} / 实际响应编码`), controller = new AbortController(), start = performance.now();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(new URL(`src/__fnos_audit/${attempt}/${profile}/${file}`, base), { credentials: "same-origin", cache: "no-store", signal: controller.signal });
      const type = response.headers.get("content-type") || "", raw = response.headers.get("content-encoding");
      const mime = /ecmascript/i.test(type) ? "ecma" : /javascript/i.test(type) ? "js" : /text\/html/i.test(type) ? "html" : "other";
      const encoding = raw === null ? "none" : ["gzip", "br", "identity"].includes(raw) ? raw : "other";
      const bytes = (await response.arrayBuffer()).byteLength;
      signal({ step: "fetch", test: profile, result: response.ok && ["js", "ecma"].includes(mime) ? "ok" : "http", status: response.status, bytes: Math.min(999999, bytes), mime, encoding, ms: duration(start) });
      node.textContent = `${profile} / 实际响应编码：HTTP ${response.status}，${encoding}，${bytes} 字节`;
    } catch (error) {
      const result = error.name === "AbortError" ? "timeout" : "error";
      signal({ step: "fetch", test: profile, result, ms: duration(start) }); node.textContent = `${profile} / 响应编码：无法确认`;
    } finally { clearTimeout(timer); }
  }
  button.addEventListener("click", async () => {
    if (running || stopped) return;
    running = true; button.disabled = true; results.replaceChildren();
    document.querySelectorAll('input[name="connection"]').forEach(input => { input.disabled = true; });
    signal({ step: "start", test: "none", result: document.querySelector('input[name="connection"]:checked')?.value || "unknown" });
    status.textContent = "正在检测实际模块执行和资源正文，请保持前台。";
    try {
      // Synthetic imports only. Entire static graph stays under a fresh token,
      // including relative children; no official Trilium bootstrap is executed.
      for (const [profile, label] of [["classic", "大脚本"], ["tiny", "小模块"], ["large", "大模块 / 标准 MIME"], ["ecma", "大模块 / ECMAScript MIME"], ["graph", "24 依赖模块链"], ["credentials", "24 依赖 / credentials"], ["preload", "24 依赖 / preload"], ["graph-ecma", "24 依赖 / ECMAScript MIME"]]) {
        if (stopped) return; await scriptTest(profile, label); if (stopped) return; await representation(profile);
      }
      for (const key of Object.keys(official)) { if (stopped) return; const previous = await fetchTest(key, false); if (stopped) return; await fetchTest(key, true, previous); }
      signal({ step: "finish", test: "none", result: "done" });
      status.textContent = "测试已完成；请截图结果并回复。服务器日志收到回执前，不视为报告送达。";
      setTimeout(() => { if (document.visibilityState !== "hidden") status.textContent += ` 已确认 ${acknowledged}/${reports} 条诊断回执送达。`; }, 6500);
    } catch { status.textContent = "诊断脚本中断，请截图并提供时间。"; signal({ step: "error", test: "none", result: "other" }); }
    finally { running = false; stopped = true; }
  });
  window.addEventListener("pagehide", () => { if (running) signal({ step: "finish", test: "none", result: "pagehide" }); stopped = true; active?.finish("timeout"); });
})();
