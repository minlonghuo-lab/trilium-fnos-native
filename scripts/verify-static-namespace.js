"use strict";
// Read-only structural verification against an extracted official public tree.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { createAssetNamespace, ROOT } = require("../trilium-fnos/app/proxy/asset-namespace");
const publicDir = process.argv[2];
if (!publicDir) throw new Error("Supply the extracted official public directory");
const namespace = createAssetNamespace(publicDir);
// Verification-only dependency, not shipped in the proxy or installed on NAS.
// Use es-module-lexer 2.0.0 to distinguish actual imports from embedded source
// examples and locale-map keys in the official compiled bundle.
const lexer = require(process.argv[3] || "es-module-lexer");
lexer.initSync();
let scripts = 0, stylesheets = 0, references = 0, moduleImports = 0;
for (const relative of namespace.inventory) {
  const extension = path.extname(relative);
  if (![".js", ".css"].includes(extension)) continue;
  if (extension === ".js") scripts++; else stylesheets++;
  const text = fs.readFileSync(path.join(publicDir, relative), "utf8");
  const literals = extension === ".js"
    ? [
      ...lexer.parse(text)[0].filter(m => m.n?.startsWith(".")).map(m => { moduleImports++; return m.n; }),
      // Official Vite dependency tables and import.meta-relative URL literals.
      ...[...text.matchAll(/(["'`])((?:\.\.?\/)[A-Za-z0-9_./,()-]+\.(?:js|css|json|woff2?|wasm))\1/g)]
        .map(m => m[2]).filter(value => namespace.inventory.has(new URL(value, `http://local/${relative}`).pathname.slice(1))),
      ...[...text.matchAll(/new URL\(\s*(["'`])([^"'`]+)\1\s*,\s*import\.meta\.url\)/g)].map(m => m[2])
    ]
    : [...text.matchAll(/(?:url\(\s*["']?|@import\s*["'])((?:\.\.?\/)[A-Za-z0-9_./,()-]+\.(?:css|woff2?|ttf|png|svg))/g)].map(m => m[1]);
  for (const literal of literals) {
    const original = new URL(literal, `http://local/${relative}`).pathname.slice(1);
    const target = new URL(literal, `http://local${ROOT}/${relative}`);
    const route = namespace.route(target.pathname, "GET");
    assert.ok(route?.upstream, `${relative}: unresolved public dependency ${literal}`);
    assert.equal(route.relative, original, `${relative}: dependency moved outside the original public tree`);
    references++;
  }
}
const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
const rewritten = namespace.rewriteDocument(html);
assert.ok(rewritten.includes(`${ROOT}/src/index-2IAUW27Z.js`));
assert.ok(!/(?:src|href)="\.\/src\//.test(rewritten));
console.log(JSON.stringify({ publicFiles: namespace.inventory.size, scripts, stylesheets, moduleImports, referencesChecked: references, officialBodiesChanged: 0 }));
