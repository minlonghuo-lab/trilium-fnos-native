"use strict";

const fs = require("node:fs");
const path = require("node:path");
// Independent transport revision. Bump whenever the static representation
// contract changes, even if the pinned upstream Trilium release is unchanged.
const REVISION = "v0.106.0-p1";
const ROOT = `/__fnos/static/${REVISION}`;
const SOURCE_ROOT = `${ROOT.slice(1)}/src/`;
const FOLDERS = new Set(["src", "assets", "stylesheets", "fonts", "images", "translations"]);
const EXTENSIONS = new Set([".js", ".css", ".json", ".woff", ".woff2", ".ttf", ".otf", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".wasm"]);
const ADAPTERS = new Set(["startup.js", "sync.js", "sync.css", "diagnostics.js", "module-audit-link.js"]);
function adapterName(name) {
  return ADAPTERS.has(name) ? name.replace(/\.(js|css)$/, `-${REVISION}.$1`) : name;
}
function createAssetNamespace(publicDir) {
  const inventory = new Set();
  function walk(directory, prefix) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      // Never follow symlinks into user data or out of the release directory.
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relative);
      else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) inventory.add(relative);
    }
  }
  for (const folder of FOLDERS) {
    const directory = path.join(publicDir, folder);
    if (fs.existsSync(directory) && fs.lstatSync(directory).isDirectory()) walk(directory, folder);
  }
  if (!inventory.size) throw new Error("Official public asset inventory missing");
  function route(rawUrl, method) {
    const q = rawUrl.indexOf("?");
    const pathname = q < 0 ? rawUrl : rawUrl.slice(0, q);
    if (!(pathname === "/__fnos/static" || pathname.startsWith("/__fnos/static/"))) return null;
    if (!["GET", "HEAD"].includes(method)) return { status: 405 };
    if (!pathname.startsWith(ROOT + "/")) return { status: 404 };
    const encoded = pathname.slice(ROOT.length + 1);
    let relative;
    try { relative = decodeURIComponent(encoded); } catch { return { status: 400 }; }
    if (/[\\\x00-\x1f?#]/.test(relative) || /%(?:2e|2f|5c)/i.test(relative) ||
      relative.split("/").some(segment => !segment || segment === "." || segment === "..") || !inventory.has(relative)) return { status: 404 };
    // Vite src chunks and assets (including the map worker) have root mounts.
    // Traditional fonts/styles/translations use Trilium's versioned mount.
    const upstream = /^(src|assets)\//.test(relative) ? `/${relative}` : `/assets/v0.106.0/${relative}`;
    return { upstream: encodeURI(upstream) + (q < 0 ? "" : rawUrl.slice(q)), relative };
  }
  function rewriteDocument(html) {
    // Only resource-bearing attributes in the official application document.
    // Never rewrite attachments, note bodies, API requests or arbitrary URLs.
    return html.replace(/<(?:script|link|img|source)\b[^>]*>/gi, tag => tag.replace(
      /(\s)(src|href|data-fnos-entry-src)\s*=\s*(["'])([^"']+)\3/gi,
      (whole, space, attribute, quote, value) => {
        const match = /^(?:\.\/)?(src\/[^?#]+)$/.exec(value);
        if (!match || !inventory.has(match[1])) return whole;
        return `${space}${attribute}=${quote}.${ROOT}/${match[1]}${quote}`;
      }
    ));
  }
  function rewriteBootstrap(body) {
    // Change only the public static mount field, not the API URL or any user
    // settings. Unexpected release/layouts preserve the original response.
    let data;
    try { data = JSON.parse(body.toString("utf8")); } catch { return body; }
    if (!data || Array.isArray(data) || data.assetPath !== "assets/v0.106.0") return body;
    data.assetPath = ROOT.slice(1);
    return Buffer.from(JSON.stringify(data));
  }
  return { route, rewriteDocument, rewriteBootstrap, inventory };
}
module.exports = { createAssetNamespace, ROOT, REVISION, SOURCE_ROOT, adapterName };
