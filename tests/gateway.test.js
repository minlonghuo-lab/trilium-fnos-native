"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { applyFramePolicy, upstreamHeaders, gatewayResponseHeaders, gatewayRequestCookies } = require("../trilium-fnos/app/proxy/gateway");

test("HTTPS gateway isolates sessions and permits secure embedded login", () => {
  const headers = { "set-cookie": ["trilium.sid=signed; Path=/; HttpOnly; SameSite=Lax"] };
  gatewayResponseHeaders(headers, true);
  assert.equal(headers["set-cookie"][0], "trilium-fnos.sid=signed; Path=/app/trilium-fnos/; HttpOnly; SameSite=None; Secure");
  const req = { headers: { cookie: "nas=keep; trilium.sid=old; trilium-fnos.sid=signed" } };
  gatewayRequestCookies(req);
  assert.equal(req.headers.cookie, "nas=keep; trilium.sid=signed");
});

test("gateway updates all combined CSP policies without widening trusted domains", () => {
  const headers = { "content-security-policy": ["default-src 'self'; frame-ancestors 'none', script-src 'self'; frame-ancestors https://old.example", "object-src 'none'"], "x-frame-options": "DENY" };
  applyFramePolicy(headers, "private.example", true);
  assert.deepEqual(headers["content-security-policy"], ["default-src 'self'; frame-ancestors 'self'", "script-src 'self'; frame-ancestors 'self'", "object-src 'none'; frame-ancestors 'self'"]);
  assert.equal(headers["x-frame-options"], undefined);
});

test("direct HTTP does not trust client-supplied forwarding and user identity", () => {
  const req = { headers: { host: "nas.example:8080", "x-forwarded-proto": "https", "x-trim-userid": "0", connection: "keep-alive, x-remove", "x-remove": "yes", "transfer-encoding": "chunked" }, socket: { remoteAddress: "192.0.2.1" } };
  const headers = upstreamHeaders(req, false);
  assert.equal(headers["x-forwarded-proto"], "http");
  assert.equal(headers["x-trim-userid"], undefined);
  assert.equal(headers["x-remove"], undefined);
  assert.equal(headers["transfer-encoding"], undefined);
});

test("gateway leaves external OAuth redirects intact and preserves cookie protections", () => {
  const headers = { location: "https://identity.example/login", "set-cookie": ["state=abc; Domain=backend.local; Path=/callback; Secure; HttpOnly; SameSite=Lax"] };
  gatewayResponseHeaders(headers);
  assert.equal(headers.location, "https://identity.example/login");
  assert.deepEqual(headers["set-cookie"], ["state=abc; Path=/app/trilium-fnos/callback; Secure; HttpOnly; SameSite=Lax"]);
});
