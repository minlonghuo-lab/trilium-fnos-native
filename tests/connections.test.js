"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { getConnectionInfo } = require("../trilium-fnos/app/proxy/connections");

test("sync candidates use the stable direct port, never the NAS gateway or backend port", () => {
  const info = getConnectionInfo(8080, {
    lo: [{ address: "127.0.0.1", internal: true }],
    lan: [{ address: "192.168.1.10", internal: false }, { address: "fe80::1", internal: false }],
    extra: [{ address: "10.0.0.2", internal: false }, { address: "192.168.1.10", internal: false }],
    public: [{ address: "203.0.113.2", internal: false }]
  });
  assert.deepEqual(info.lanUrls, ["http://10.0.0.2:8080/", "http://192.168.1.10:8080/"]);
  assert.equal(info.gatewayPath, "/app/trilium-fnos/");
  assert.equal(info.directPort, 8080);
});

test("no detectable LAN address does not invent a reachable host", () => {
  assert.deepEqual(getConnectionInfo(8080, {}).lanUrls, []);
});

test("app opens a new browser page and retains the stable native gateway", () => {
  const ui = JSON.parse(fs.readFileSync(path.join(__dirname, "../trilium-fnos/app/ui/config")));
  const entry = ui[".url"]["trilium-fnos.main"];
  assert.equal(entry.type, "url");
  assert.equal(entry.gatewayPrefix, "/app/trilium-fnos");
  assert.equal(entry.gatewaySocket, "app.sock");
  assert.equal(entry.url, "/app/trilium-fnos/");
});
