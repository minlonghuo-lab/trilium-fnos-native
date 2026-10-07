"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { authenticatedTriliumSession } = require("../trilium-fnos/app/proxy/authentication");
const req = { headers: { cookie: "foo=bar; trilium.sid=session" } };

test("manager requires real Trilium cookie and authenticated-only API access", async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return { status: options.headers?.cookie ? 200 : 401 };
  };
  assert.equal(await authenticatedTriliumSession(req, "http://127.0.0.1:18888", request), true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.options.method === "HEAD" && call.options.redirect === "manual"));
  assert.equal(calls[1].options.headers, undefined);
  calls.length = 0;
  assert.equal(await authenticatedTriliumSession({ headers: { cookie: "trilium.sid=" } }, "http://backend", request), false);
  assert.equal(calls.length, 0);
});

test("setup, noAuthentication, invalid sessions and offline backend fail closed", async () => {
  for (const [authenticated, anonymous] of [[200, 200], [401, 401], [302, 401], [200, 302]]) {
    assert.equal(await authenticatedTriliumSession(req, "http://backend", async (_url, options) => ({
      status: options.headers?.cookie ? authenticated : anonymous
    })), false);
  }
  assert.equal(await authenticatedTriliumSession(req, "http://backend", async () => { throw new Error("ECONNREFUSED"); }), false);
});
