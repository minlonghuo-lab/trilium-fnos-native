"use strict";

// The FN Connect iOS WebView can execute dynamically inserted modules while
// the parser's real entry never reaches the NAS. Change only this client path;
// do not rewrite official JS, import URLs, credentials, APIs or desktop HTML.
function needsDeferredEntry(headers, gateway) {
  return gateway && /(?:^|\s)FNAppType\/iOS(?:\s|$)/.test(String(headers["user-agent"] || ""));
}

function deferEntry(html) {
  const modules = [...html.matchAll(/<script\b[^>]*\btype\s*=\s*(["'])module\1[^>]*>\s*<\/script\s*>/gi)];
  if (modules.length !== 1) return { html, deferred: false };
  const entry = modules[0][0];
  // Fail closed on an upstream HTML layout change. An unsupported script must
  // never leave the document without its original executable entry.
  const src = /\ssrc\s*=\s*(["'])(\.\/src\/index-[A-Za-z0-9_-]+\.js)\1/i.exec(entry);
  if (!src) return { html, deferred: false };
  const inert = entry.replace(/\btype\s*=\s*(["'])module\1/i, 'type="application/x-fnos-deferred-module"')
    .replace(src[0], ` data-fnos-entry-src="${src[2]}" data-fnos-deferred-entry`);
  html = html.replace(entry, inert);
  // Preload is optional, not part of Trilium's functionality. Removing these
  // hints before parsing avoids an earlier failed preload poisoning the graph.
  html = html.replace(/<link\b[^>]*\brel\s*=\s*(["'])modulepreload\1[^>]*>/gi, "");
  return { html, deferred: true };
}

module.exports = { needsDeferredEntry, deferEntry };
