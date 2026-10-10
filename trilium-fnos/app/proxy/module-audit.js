"use strict";

// Temporary, opt-in experiments. No Trilium code is evaluated, no backend or
// host bridge is called, and no authentication/cookie headers are inspected.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = "/__fnos/module-audit";
const SRC = "/src/__fnos_audit/";
const PROFILES = ["classic", "tiny", "large", "ecma", "graph", "credentials", "preload", "graph-ecma"];
const OFFICIAL = Object.freeze({ toggle: "FormToggle-ElUrm1Ls.js", index: "index-2IAUW27Z.js", large: "dist-C3UACQzc.js", css: "image_compression_dialog-Dv6sENdT.css" });
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
function padding(bytes) {
  let value = 123456789, text = "/*";
  while (text.length < bytes - 3) { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; text += (value >>> 0).toString(36) + " "; }
  return text.slice(0, bytes - 3) + "*/\n";
}
const LARGE_PAD = padding(48000);
const LEAF_PAD = padding(4096);
function source(profile, file) {
  const classic = profile === "classic";
  const receipt = `window.dispatchEvent(new CustomEvent('fnos:audit-executed',{detail:${classic ? "document.currentScript.src" : "import.meta.url"}}));\n`;
  if (file === "tiny.js" && profile === "tiny") return receipt;
  if (file === "large.js" && ["classic", "large", "ecma"].includes(profile)) return LARGE_PAD + receipt;
  if (!["graph", "credentials", "preload", "graph-ecma"].includes(profile)) return null;
  if (file === "entry.js") return `import {count} from './branch.js';\nif(count!==24)throw new Error('Synthetic graph incomplete');\n${receipt}`;
  if (file === "branch.js") return Array.from({ length: 24 }, (_, i) => `import {value as v${i}} from './leaf-${i}.js';`).join("\n") + `\nexport const count=${Array.from({ length: 24 }, (_, i) => `v${i}`).join("+")};\n`;
  if (/^leaf-(?:[0-9]|1[0-9]|2[0-3])\.js$/.test(file)) return LEAF_PAD + "export const value=1;\n";
  return null;
}
function createModuleAudit({ log, publicDir, assetsDir, now = Date.now, ttlMs = 600000, maxAttempts = 16 }) {
  if (typeof log !== "function" || typeof now !== "function") throw new TypeError("Audit callbacks required");
  if (![ttlMs, maxAttempts].every(n => Number.isSafeInteger(n) && n > 0)) throw new RangeError("Invalid audit bounds");
  const attempts = new Map(), cache = new Map();
  const record = data => log(`fnos-module-audit ${JSON.stringify(data)}`);
  function send(req, res, status, body, mime, metadata) {
    const headers = { "content-type": mime, "content-length": body.length, "cache-control": "no-store, no-transform", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin" };
    if (mime.startsWith("text/html")) headers["content-security-policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'";
    if (status === 405) headers.allow = "GET, HEAD";
    if (metadata) {
      let done = false;
      const completed = finish => { if (!done) { done = true; record({ event: "response", ...metadata, status, bytes: req.method === "HEAD" ? 0 : body.length, finish }); } };
      res.once("finish", () => completed(true)); res.once("close", () => completed(false));
    }
    res.writeHead(status, headers); res.end(req.method === "HEAD" ? undefined : body);
  }
  const getFile = (directory, name) => { const key = path.join(directory, name); if (!cache.has(key)) cache.set(key, fs.readFileSync(key)); return cache.get(key); };
  function handle(req, res, pathname, prefix = "") {
    if (!(pathname === ROOT || pathname.startsWith(ROOT + "/") || pathname.startsWith(SRC))) return false;
    const fail = status => { send(req, res, status, Buffer.from(`Audit HTTP ${status}\n`), "text/plain; charset=utf-8"); return true; };
    if (!["GET", "HEAD"].includes(req.method)) return fail(405);
    if (req.url.length > 1024) return fail(400);
    const url = new URL(req.url, "http://localhost");
    for (const [token, state] of attempts) if (now() >= state.expires) attempts.delete(token);
    if (pathname === ROOT + "/") {
      if (url.search) return fail(400);
      if (req.method === "HEAD") { send(req, res, 200, Buffer.alloc(0), "text/html; charset=utf-8"); return true; }
      if (attempts.size >= maxAttempts) return fail(429);
      const token = crypto.randomBytes(12).toString("hex");
      attempts.set(token, { expires: now() + ttlMs, requests: 0, events: 0 });
      const ua = String(req.headers["user-agent"] || "");
      record({ event: "issued", attempt: token, client: /FNAppType\/iOS/.test(ua) ? "ios-app" : /iPhone|iPad/.test(ua) ? "ios-browser" : "other", gateway: Boolean(prefix) });
      const body = Buffer.from(getFile(assetsDir, "module-audit.html").toString().replaceAll("__PREFIX__", prefix).replaceAll("__ATTEMPT__", token));
      send(req, res, 200, body, "text/html; charset=utf-8"); return true;
    }
    const route = new RegExp(`^${ROOT}/([a-f0-9]{24})/(client\\.js|event\\.gif|official/(toggle|index|large|css))$`).exec(pathname);
    const synthetic = /^\/src\/__fnos_audit\/([a-f0-9]{24})\/([a-z-]+)\/([a-z0-9.-]+\.js)$/.exec(pathname);
    if (!route && !synthetic) return fail(404);
    const token = (route || synthetic)[1], state = attempts.get(token);
    if (!state) return fail(404);
    if (route?.[2] === "event.gif") {
      const fields = Object.fromEntries(url.searchParams);
      const allowed = {
        step: /^(start|finish|script|fetch|error|csp)$/,
        test: /^(classic|tiny|large|ecma|graph|credentials|preload|graph-ecma|toggle-old|toggle-fresh|index-old|index-fresh|large-old|large-fresh|css-old|css-fresh|none)$/,
        result: /^(executed|load-only|error|timeout|ok|http|mismatch|done|pagehide|module|syntax|network|csp|other|fnid|lan|vpn|unknown)$/,
        status: /^(0|[1-5][0-9]{2})$/, bytes: /^(0|[1-9][0-9]{0,5})$/,
        ms: /^(0|[1-9][0-9]{0,5})$/, encoding: /^(gzip|br|identity|none|other)$/,
        mime: /^(js|ecma|css|html|other)$/, asset: /^(tiny\.js|large\.js|entry\.js|branch\.js|leaf-(?:[0-9]|1[0-9]|2[0-3])\.js|FormToggle-ElUrm1Ls\.js|index-2IAUW27Z\.js|dist-C3UACQzc\.js|image_compression_dialog-Dv6sENdT\.css|client\.js|other)$/,
        line: /^(0|[1-9][0-9]{0,4})$/, column: /^(0|[1-9][0-9]{0,4})$/
      };
      if (!fields.step || !fields.test || !fields.result || Array.from(url.searchParams).length !== Object.keys(fields).length || Object.entries(fields).some(([k, v]) => !allowed[k]?.test(v))) return fail(400);
      if (req.method === "GET") {
        if (++state.events > 80) return fail(429);
        record({ event: "client", attempt: token, ...fields });
      }
      send(req, res, 200, GIF, "image/gif"); return true;
    }
    if (url.search) return fail(400);
    if (++state.requests > 256) return fail(429);
    let body, mime, resource;
    try {
      if (route?.[2] === "client.js") { body = getFile(assetsDir, "module-audit-client.js"); mime = "application/javascript; charset=utf-8"; resource = "client"; }
      else if (route) { resource = "official-" + route[3]; body = getFile(publicDir, OFFICIAL[route[3]]); if (body.length > 1048576) return fail(413); mime = route[3] === "css" ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8"; }
      else {
        if (!PROFILES.includes(synthetic[2])) return fail(404);
        const text = source(synthetic[2], synthetic[3]); if (text === null) return fail(404);
        body = Buffer.from(text); resource = `${synthetic[2]}/${synthetic[3]}`;
        // Both are standard JS MIME types. This is a MIME/compression candidate,
        // NOT proof of identity transport: outer encoding is measured by client.
        mime = synthetic[2].includes("ecma") ? "application/ecmascript; charset=utf-8" : "application/javascript; charset=utf-8";
      }
    } catch { return fail(404); }
    send(req, res, 200, body, mime, { attempt: token, resource, method: req.method }); return true;
  }
  return { handle };
}
module.exports = { createModuleAudit, source, OFFICIAL };
