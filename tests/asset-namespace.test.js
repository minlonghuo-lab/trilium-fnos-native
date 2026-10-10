"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { test } = require("node:test");
const { createAssetNamespace, ROOT, adapterName } = require("../trilium-fnos/app/proxy/asset-namespace");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tns-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ["src/index-fixture.js", "src/child.js", "src/style.css", "src/font.woff2", "src/locale.json", "assets/worker.js", "stylesheets/theme/base.css", "fonts/Inter/font,wght.woff2", "images/logo.png"]) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), name);
  }
  fs.writeFileSync(path.join(dir, "src/private.log"), "not a static asset");
  fs.symlinkSync("/etc/passwd", path.join(dir, "src/leak.js"));
  return createAssetNamespace(dir);
}
test("namespace maps the complete public tree while retaining relative imports, workers and fonts", t => {
  const ns = fixture(t), base = `https://nas.example/app/trilium-fnos${ROOT}/src/index-fixture.js`;
  for (const [relative, upstream] of [["./child.js", "/src/child.js"], ["./style.css", "/src/style.css"], ["./font.woff2", "/src/font.woff2"], ["./locale.json", "/src/locale.json"], ["../assets/worker.js", "/assets/worker.js"], ["../fonts/Inter/font,wght.woff2", "/assets/v0.106.0/fonts/Inter/font,wght.woff2"]]) {
    const url = new URL(relative, base);
    assert.deepEqual(ns.route(url.pathname.slice("/app/trilium-fnos".length), "GET").upstream, upstream);
  }
  assert.equal(ns.route(`${ROOT}/src/child.js?v=2`, "HEAD").upstream, "/src/child.js?v=2");
  assert.equal(ns.route("/api/sync/updates", "GET"), null);
});
test("namespace rejects traversal, encoded escapes, symlinks, private files and unsafe methods", t => {
  const ns = fixture(t);
  for (const value of ["src/../api/options", "src/%2e%2e/api/options", "src/%252e%252e/api/options", "src/%5cleak.js", "src/%00child.js", "src/private.log", "src/leak.js", "api/options", "../../database.db", "src/missing.js"]) assert.equal(ns.route(`${ROOT}/${value}`, "GET").status, 404, value);
  assert.equal(ns.route(`${ROOT}/src/%xx`, "GET").status, 400);
  assert.equal(ns.route(`${ROOT}/src/child.js`, "POST").status, 405);
  assert.equal(ns.route("/__fnos/static/v0.106.0-unknown/src/child.js", "GET").status, 404);
});
test("document rewriting touches only inventoried resource attributes, including deferred entry", t => {
  const ns = fixture(t);
  const html = '<head><script type="module" src="./src/index-fixture.js"></script><script data-fnos-entry-src="./src/index-fixture.js"></script><link rel="stylesheet" href="./src/style.css"><script src="https://other.example/src/child.js"></script></head><a href="./src/child.js">unchanged</a><script data-custom-src="./src/child.js"></script>';
  const result = ns.rewriteDocument(html);
  assert.match(result, new RegExp(`src="\\.${ROOT}/src/index-fixture.js"`));
  assert.ok(result.includes(`data-fnos-entry-src=".${ROOT}/src/index-fixture.js"`));
  assert.ok(result.includes(`href=".${ROOT}/src/style.css"`));
  assert.ok(result.includes('<a href="./src/child.js">'));
  assert.ok(result.includes('data-custom-src="./src/child.js"'));
  assert.ok(result.includes('src="https://other.example/src/child.js"'));
  assert.equal(ns.rewriteDocument(result), result);
});
test("bootstrap preserves all non-static data and unknown schemas byte-for-byte", t => {
  const ns = fixture(t);
  const original = { assetPath: "assets/v0.106.0", loggedIn: false, device: "mobile", settings: { unchanged: "yes" }, customThemeCssUrl: "api/notes/download/custom" };
  assert.deepEqual(JSON.parse(ns.rewriteBootstrap(Buffer.from(JSON.stringify(original)))), { ...original, assetPath: ROOT.slice(1) });
  for (const value of ['{"assetPath":"https://other.example"}', '{ "unknown": true }', 'invalid']) {
    const body = Buffer.from(value); assert.equal(ns.rewriteBootstrap(body), body);
  }
  assert.equal(adapterName("startup.js"), "startup-v0.106.0-p1.js");
  assert.equal(adapterName("private.js"), "private.js");
});
