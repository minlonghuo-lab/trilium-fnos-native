"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const collector = path.resolve(__dirname, "../scripts/collect-fnconnect-startup-evidence.sh");
const timestamp = "09/Oct/2026:08:14:05 +0800";
const currentModules = ["index-2IAUW27Z.js", "font-DMVOl4cV.js", "splash-BuLZdf1c.js", "preload-helper-uBIymjUX.js", "theme-DIqmDpk8.js"];

test("new static tree remains observable without leaking queries or private routes", t => {
  const targets = ["/app/trilium-fnos/__fnos/static/v0.106.0-p1/src/index-2IAUW27Z.js", "/app/trilium-fnos/__fnos/static/v0.106.0-p1/stylesheets/theme-next/base.css", "/app/trilium-fnos/__fnos/static/v0.106.0-p1/assets/maplibre-gl-worker-CD0Mhlp9.js", "/app/trilium-fnos/__fnos/assets/startup-v0.106.0-p1.js"];
  const { rows, output } = collect(t, [...targets.map(target => combined(target + "?token=secret")), combined("/app/trilium-fnos/__fnos/static/v0.106.0-p1/api/notes/private-note.js")]);
  assert.deepEqual(rows.map(row => row[5]), targets);
  assert.doesNotMatch(output, /token=|secret|private-note/);
});

test("independent audit keeps public resource statuses while redacting attempt and query", t => {
  const token = "1234567890abcdefabcdef12";
  const { output, rows } = collect(t, [
    combined(`/app/trilium-fnos/src/__fnos_audit/${token}/graph/leaf-5.js`, { status: 403 }),
    combined(`/app/trilium-fnos/__fnos/module-audit/${token}/event.gif?step=error&private=secret`),
    combined(`/app/trilium-fnos/__fnos/module-audit/${token}/official/toggle`),
    combined("/app/trilium-fnos/__fnos/module-audit/"),
    combined("/src/__fnos_audit/invalid/graph/entry.js"),
    combined(`/__fnos/module-audit/${token}/official/database.db`)
  ]);
  assert.equal(rows.length, 4);
  assert.equal(rows[0][3], "403"); assert.match(rows[0][5], /<attempt>\/graph\/leaf-5.js/);
  assert.doesNotMatch(output, new RegExp(`${token}|secret|database|invalid|\\?step`));
});

function combined(target, { method = "GET", status = 200, bytes = 1234, protocol = "HTTP/2.0", time = timestamp,
  ip = "192.0.2.77", referrer = "-", ua = "Mozilla/5.0 FNAppType/iOS FNAppVer/1.8.4" } = {}) {
  return `${ip} - - [${time}] "${method} ${target} ${protocol}" ${status} ${bytes} "${referrer}" "${ua}"`;
}

function collect(t, lines) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "trilium-evidence-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const logPath = path.join(directory, "access.log");
  const original = Buffer.from(lines.join("\n") + "\n");
  fs.writeFileSync(logPath, original);
  const result = spawnSync("sh", [collector, logPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(logPath), original, "the diagnostic must leave the source log untouched");
  const rows = result.stdout.trim().split("\n").filter(line => line && !line.startsWith("#"))
    .map(line => line.split(" | "));
  for (const row of rows) assert.equal(row.length, 8, "each record contains only the documented safe columns");
  return { output: result.stdout, rows };
}

test("nginx combined rows retain public correct/misresolved paths and parsed safe metadata", t => {
  const { rows } = collect(t, [
    combined("/app/trilium-fnos/src/index-2IAUW27Z.js", { bytes: 7250 }),
    combined("/src/font-DMVOl4cV.js", { status: 403, bytes: 209, protocol: "HTTP/1.1" }),
    combined("/app/src/theme-DIqmDpk8.js", { status: 404, bytes: 337 }),
    combined("/trilium-fnos/src/splash-BuLZdf1c.js", { method: "HEAD", status: 304, bytes: 0 })
  ]);
  assert.deepEqual(rows, [
    [timestamp, "FNApp-iOS", "HTTP/2.0", "200", "7250", "/app/trilium-fnos/src/index-2IAUW27Z.js", "no", "1.8.4"],
    [timestamp, "FNApp-iOS", "HTTP/1.1", "403", "209", "/src/font-DMVOl4cV.js", "no", "1.8.4"],
    [timestamp, "FNApp-iOS", "HTTP/2.0", "404", "337", "/app/src/theme-DIqmDpk8.js", "no", "1.8.4"],
    [timestamp, "FNApp-iOS", "HTTP/2.0", "304", "0", "/trilium-fnos/src/splash-BuLZdf1c.js", "no", "1.8.4"]
  ]);
});

test("all five current entry modules are found under arbitrary prefixes without exposing those prefixes", t => {
  const { output, rows } = collect(t, currentModules.map((filename, index) => combined(
    `/private-session-token-${index}/unexpected/base/src/${filename}?auth=query-secret-${index}`
  )));
  assert.equal(rows.length, currentModules.length);
  assert.deepEqual(rows.map(row => row[5]), currentModules.map(filename => `<other-prefix>/${filename}`));
  assert.doesNotMatch(output, /private-session|unexpected\/base|query-secret|\?auth=/);
});

test("module requests are retained when the UA lacks a FNApp marker", t => {
  const uas = [
    ["Mozilla/5.0 (iPhone) Version/18.0 Mobile/15E148 Safari/604.1", "iOS-unmarked", "-"],
    ["Mozilla/5.0 Firefox/128.0", "Firefox", "-"],
    ["Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1.15", "Safari-like", "-"],
    ["Mozilla/5.0 FNAppType/Android FNAppVer/1.9.2", "FNApp-other", "1.9.2"],
    ["custom-UA-private-identifier", "other", "-"]
  ];
  const { output, rows } = collect(t, uas.map(([ua]) => combined("/src/index-2IAUW27Z.js", { ua })));
  assert.equal(rows.length, uas.length);
  assert.deepEqual(rows.map(row => [row[1], row[7]]), uas.map(([, category, version]) => [category, version]));
  assert.doesNotMatch(output, /Mozilla|Macintosh|custom-UA-private-identifier|Firefox\/128/);
});

test("query, full referrer, request host and IPs are absent from evidence output", t => {
  const { output, rows } = collect(t, [
    combined("https://private-request-host.example/app/trilium-fnos/src/theme-DIqmDpk8.js?token=query-private-secret#fragment-private", {
      ip: "2001:db8:1234::99", referrer: "https://private-referrer-host.example/app/trilium-fnos/?token=referrer-private-secret",
      ua: "Mozilla/5.0 FNAppType/iOS FNAppVer/1.8.4 UA-private-secret"
    }),
    combined("/src/font-DMVOl4cV.js?auth=another-private-secret", {
      ip: "198.51.100.88", referrer: "https://another-private-referrer.example/private-notes/secret-note"
    })
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row[6]), ["yes", "no"]);
  assert.equal(rows[0][5], "/app/trilium-fnos/src/theme-DIqmDpk8.js");
  assert.equal(rows[1][5], "/src/font-DMVOl4cV.js");
  assert.doesNotMatch(output, /2001:db8|198\.51\.100\.88|private-request-host|private-referrer-host|another-private-referrer/);
  assert.doesNotMatch(output, /query-private-secret|referrer-private-secret|another-private-secret|fragment-private|UA-private-secret|secret-note/);
  assert.doesNotMatch(output, /https?:\/\/|\?token=|\?auth=|#fragment/);
});

test("private notes, APIs, attachments and nonpublic nested src paths are excluded", t => {
  const privateTargets = [
    "/app/trilium-fnos/api/notes/private-note-id",
    "/api/notes/private-note-id/content",
    "/app/trilium-fnos/api/etapi/notes/private-note-id",
    "/app/trilium-fnos/attachments/private-attachment.html",
    "/attachments/private-attachment.js",
    "/share/private-note-id",
    "/app/trilium-fnos/share/private-note-id",
    "/private-note-folder/src/private-note.js",
    "/api/private-note-folder/src/private-note.css",
    "/app/trilium-fnos/src/private-file.pdf"
  ];
  const { output, rows } = collect(t, [
    ...privateTargets.map(target => combined(target)),
    combined("/app/trilium-fnos/src/index-2IAUW27Z.js", { method: "POST" })
  ]);
  assert.equal(rows.length, 0);
  assert.doesNotMatch(output, /private-note|private-attachment|private-file|\/api\/|\/attachments\/|\/share\//);
});

test("HTML, manager assets, manifest, bootstrap and versioned public CSS remain visible", t => {
  const targets = [
    "/app/trilium-fnos/", "/app/trilium-fnos",
    "/app/trilium-fnos/__fnos/assets/startup.js", "/__fnos/assets/startup.js",
    "/app/trilium-fnos/__fnos/assets/sync.js", "/__fnos/assets/sync.js",
    "/app/trilium-fnos/__fnos/assets/sync.css", "/__fnos/assets/sync.css",
    "/app/trilium-fnos/manifest.webmanifest", "/manifest.webmanifest",
    "/app/trilium-fnos/bootstrap", "/bootstrap",
    "/app/trilium-fnos/assets/v0.106.0/src/public-style.css"
  ];
  const { rows } = collect(t, targets.map(target => combined(`${target}?cache=private-cache-token`)));
  assert.deepEqual(rows.map(row => row[5]), targets);
});

test("malformed combined metadata is skipped rather than copied into diagnostic columns", t => {
  const { rows, output } = collect(t, [
    "not a combined log line private-invalid-secret",
    combined("/src/index-2IAUW27Z.js", { status: "private-status", bytes: 1 }),
    combined("/src/index-2IAUW27Z.js", { status: 200, bytes: "private-bytes" }),
    combined("/src/index-2IAUW27Z.js", { status: 200, bytes: 0, time: "09/Oct/2026:08:14:06 +0800" })
  ]);
  assert.deepEqual(rows, [["09/Oct/2026:08:14:06 +0800", "FNApp-iOS", "HTTP/2.0", "200", "0", "/src/index-2IAUW27Z.js", "no", "1.8.4"]]);
  assert.doesNotMatch(output, /private-invalid|private-status|private-bytes/);
});

test("invalid log paths return failure instead of a successful empty report", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "trilium-evidence-invalid-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relative = spawnSync("sh", [collector, "private-relative-access.log"], { encoding: "utf8" });
  assert.equal(relative.status, 2);
  assert.match(relative.stderr, /absolute.*path/i);
  const missing = spawnSync("sh", [collector, path.join(directory, "private-missing-access.log")], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /readable regular file/i);
  const notAFile = spawnSync("sh", [collector, directory], { encoding: "utf8" });
  assert.equal(notAFile.status, 1);
  assert.match(notAFile.stderr, /readable regular file/i);
  assert.doesNotMatch(relative.stderr + missing.stderr + notAFile.stderr, /private-relative|private-missing/);
});

test("reports only the last 500 matching entries in original chronological order", t => {
  const lines = [];
  for (let ordinal = 1; ordinal <= 520; ordinal++) {
    lines.push(combined("/app/trilium-fnos/src/index-2IAUW27Z.js", { bytes: ordinal }));
    // Private and unrelated rows must not consume the public-evidence window.
    lines.push(combined(`/api/notes/private-note-${ordinal}`, { bytes: ordinal }));
  }
  const { rows, output } = collect(t, lines);
  assert.equal(rows.length, 500);
  assert.deepEqual(rows.map(row => Number(row[4])), Array.from({ length: 500 }, (_, index) => index + 21));
  assert.doesNotMatch(output, /private-note|\/api\//);
});
