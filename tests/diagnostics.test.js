"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { test } = require("node:test");
const { createDiagnostics } = require("../trilium-fnos/app/proxy/diagnostics");

async function fixture(t, options = {}) {
  const logs = [];
  const diagnostics = createDiagnostics({ log: line => logs.push(JSON.parse(line.replace(/^fnos-diag /, ""))), ...options });
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (!diagnostics.handle(req, res, pathname)) res.writeHead(418).end("upstream");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (route, method = "GET", headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: route, method, headers }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
  return { ...diagnostics, logs, request };
}

test("attempts are random 24-character tokens and issuer logs contain no request information", async t => {
  const { issueAttempt, logs } = await fixture(t);
  const first = issueAttempt();
  const second = issueAttempt();
  assert.match(first, /^[a-f0-9]{24}$/);
  assert.notEqual(first, second);
  assert.deepEqual(logs, [{ attempt: first, event: "issued" }, { attempt: second, event: "issued" }]);
});

test("all three probes execute only a fixed, dependency-free event and report finished response metadata", async t => {
  const { issueAttempt, logs, request } = await fixture(t);
  const attempt = issueAttempt();
  for (const mode of ["classic", "anonymous", "credentials"]) {
    const response = await request(`/src/__fnos_probe_${mode}.js?d=${attempt}`, "GET", {
      cookie: "secret=must-not-be-recorded", host: "private-nas.example", "x-forwarded-for": "192.168.0.2"
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.toString(), `window.dispatchEvent(new CustomEvent('fnos:probe-executed',{detail:'${mode}'}));\n`);
    assert.equal(Number(response.headers["content-length"]), response.body.length);
    assert.equal(response.headers["content-type"], "application/javascript; charset=utf-8");
    assert.equal(response.headers["cache-control"], "no-store, no-transform");
    assert.equal(response.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["access-control-allow-origin"], undefined);
    assert.equal(response.headers["set-cookie"], undefined);
    const record = logs.find(item => item.event === "server-probe" && item.mode === mode);
    assert.equal(record.finish, true);
    assert.equal(record.method, "GET");
    assert.equal(record.status, 200);
    assert.equal(record.bytes, response.body.length);
    assert.deepEqual(Object.keys(record).sort(), ["attempt", "bytes", "elapsed", "event", "finish", "method", "mode", "status"]);
  }
  assert.doesNotMatch(JSON.stringify(logs), /secret|private-nas|192\.168/);
});

test("text fetch and GIF event responses have exact lengths and HEAD never emits client events", async t => {
  const { issueAttempt, logs, request } = await fixture(t);
  const attempt = issueAttempt();
  const base = `/__fnos/diagnostics/${attempt}`;
  const text = await request(`${base}/text.txt`);
  assert.equal(text.body.toString(), "fnos-diagnostic-text-ok\n");
  assert.equal(text.headers["content-type"], "text/plain; charset=us-ascii");
  assert.equal(Number(text.headers["content-length"]), text.body.length);
  assert.equal(logs.at(-1).event, "server-text");
  const gif = await request(`${base}/start.gif?protocol=https&opaque=0&base_same=true&script_same=1&framed=false&client=ios&app_ver=1.2.3&ready=loading&base=gateway`);
  assert.equal(gif.status, 200);
  assert.equal(gif.body.subarray(0, 6).toString(), "GIF89a");
  assert.equal(gif.body.readUInt16LE(6), 1);
  assert.equal(gif.body.readUInt16LE(8), 1);
  assert.equal(Number(gif.headers["content-length"]), gif.body.length);
  assert.equal(gif.headers["content-type"], "image/gif");
  assert.equal(logs.at(-1).opaque, false);
  assert.equal(logs.at(-1).base_same, true);
  const count = logs.length;
  const head = await request(`${base}/finish.gif?reason=timeout&ms=60000`, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers["content-length"], gif.headers["content-length"]);
  assert.equal(logs.length, count);
  const probeHead = await request(`/src/__fnos_probe_classic.js?d=${attempt}`, "HEAD");
  assert.equal(probeHead.status, 200);
  assert.equal(probeHead.body.length, 0);
  assert.equal(logs.at(-1).event, "server-probe");
  assert.equal(logs.at(-1).method, "HEAD");
  assert.equal(logs.at(-1).bytes, 0);
});

test("all supported event schemas normalize bounded fields without copying arbitrary strings", async t => {
  const { issueAttempt, logs, request } = await fixture(t, { now: () => 100 });
  const attempt = issueAttempt();
  const cases = {
    dom: "modules=16&preloads=0&entry=gateway&credentials=include&ready=complete&splash=visible&glob=0&bootstrap=1",
    "real-load": "kind=entry&asset=index",
    "real-error": "kind=css&asset=theme",
    entry: "phase=inserted&ready=interactive",
    "probe-start": "mode=classic&ms=0",
    "probe-load": "mode=anonymous&ms=12000",
    "probe-executed": "mode=credentials&ms=22000",
    "probe-error": "mode=anonymous",
    "probe-timeout": "mode=classic&ms=22000",
    fetch: "result=http&status=599&mime=html&bytes=4096&ms=22000",
    csp: "directive=script-src-elem",
    error: "reason=cors",
    finish: "reason=pagehide&ms=120000&ready=interactive&splash=hidden&glob=false"
  };
  for (const [event, query] of Object.entries(cases)) {
    assert.equal((await request(`/__fnos/diagnostics/${attempt}/${event}.gif?${query}`)).status, 200, event);
    assert.equal(logs.at(-1).event, event);
    assert.equal(logs.at(-1).elapsed, 0);
  }
  assert.equal(logs.find(item => item.event === "dom").modules, 16);
  assert.equal(logs.find(item => item.event === "fetch").bytes, 4096);
});

test("unknown or repeated fields, invalid types, missing discriminators and oversized requests are rejected without logging", async t => {
  const { issueAttempt, logs, request } = await fixture(t);
  const attempt = issueAttempt();
  const base = `/__fnos/diagnostics/${attempt}`;
  const cases = [
    `${base}/start.gif?url=https%3A%2F%2Fsecret.example`,
    `${base}/start.gif?client=ios&client=android`,
    `${base}/start.gif?protocol=webkit-scheme`,
    `${base}/start.gif?opaque=not-a-boolean`,
    `${base}/start.gif?app_ver=1.2%0Asecret`,
    `${base}/start.gif?app_ver=123456789012345678901`,
    `${base}/start.gif?__proto__=secret`,
    `${base}/dom.gif?modules=17`,
    `${base}/dom.gif?modules=-1`,
    `${base}/dom.gif?modules=1.0`,
    `${base}/dom.gif?modules=01`,
    `${base}/probe-load.gif?mode=classic&ms=22001`,
    `${base}/probe-executed.gif`,
    `${base}/fetch.gif?result=ok&bytes=4097`,
    `${base}/fetch.gif?result=ok&status=600`,
    `${base}/error.gif?reason=secret%20note%20text`,
    `${base}/finish.gif?reason=timeout&ms=120001`,
    `${base}/real-error.gif?kind=css`,
    `${base}/entry.gif?phase=private-note`,
    `${base}/text.txt?secret=1`,
    `/src/__fnos_probe_classic.js?d=${attempt}&secret=1`,
    `/src/__fnos_probe_classic.js?d=${attempt}&d=${attempt}`,
    `${base}/start.gif?client=${"x".repeat(1024)}`
  ];
  for (const route of cases) assert.equal((await request(route)).status, 400, route);
  assert.equal(logs.length, 1);
});

test("only reserved diagnostic routes are intercepted, never forwarded on malformed routes", async t => {
  const { issueAttempt, logs, request } = await fixture(t);
  const attempt = issueAttempt();
  for (const route of ["/", "/api/options", "/__fnos/assets/startup.js", "/src/index.js"]) {
    assert.equal((await request(route)).status, 418);
  }
  const routes = [
    "/__fnos/diagnostics", "/__fnos/diagnostics/", "/__fnos/diagnostics/fake/start.gif",
    `/__fnos/diagnostics/${attempt}/unknown.gif`, `/__fnos/diagnostics/${attempt}/start.gif/other`,
    `/__fnos/diagnostics/A${attempt.slice(1)}/start.gif`,
    `/src/__fnos_probe_cross-origin.js?d=${attempt}`, `/src/__fnos_probe_classic.js/other?d=${attempt}`,
    `/src/__fnos_probe_classic.js?d=not-a-token`,
    `/__fnos/diagnostics/${"0".repeat(24)}/start.gif`
  ];
  for (const route of routes) assert.equal((await request(route)).status, 404, route);
  assert.equal(logs.length, 1);
});

test("unsafe methods never write events or proxy diagnostic paths", async t => {
  const { issueAttempt, logs, request } = await fixture(t);
  const attempt = issueAttempt();
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
    const response = await request(`/__fnos/diagnostics/${attempt}/start.gif`, method);
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, "GET, HEAD");
  }
  assert.equal(logs.length, 1);
});

test("attempt TTL is fixed and expired attempts cannot emit events or request probes", async t => {
  let time = 1000;
  const { issueAttempt, logs, request } = await fixture(t, { now: () => time, ttlMs: 100 });
  const attempt = issueAttempt();
  time = 1099;
  assert.equal((await request(`/__fnos/diagnostics/${attempt}/start.gif`)).status, 200);
  assert.equal(logs.at(-1).elapsed, 99);
  time = 1100;
  assert.equal((await request(`/__fnos/diagnostics/${attempt}/start.gif`)).status, 404);
  assert.equal((await request(`/src/__fnos_probe_classic.js?d=${attempt}`)).status, 404);
  assert.equal((await request(`/__fnos/diagnostics/${attempt}/text.txt`)).status, 404);
  assert.equal(logs.length, 2);
});

test("a saturated attempt map preserves active attempts and client event limits exclude HEAD and server probes", async t => {
  const { issueAttempt, logs, request } = await fixture(t, { maxAttempts: 2, maxEvents: 2 });
  const old = issueAttempt();
  const live = issueAttempt();
  assert.equal(issueAttempt(), null);
  assert.equal(logs.length, 2);
  for (const attempt of [old, live]) {
    const route = `/__fnos/diagnostics/${attempt}/probe-start.gif?mode=classic`;
    assert.equal((await request(route, "HEAD")).status, 200);
    assert.equal((await request(`/src/__fnos_probe_classic.js?d=${attempt}`)).status, 200);
    assert.equal((await request(`/__fnos/diagnostics/${attempt}/text.txt`)).status, 200);
    assert.equal((await request(route)).status, 200);
    assert.equal((await request(route)).status, 200);
    assert.equal((await request(route)).status, 429);
    assert.equal((await request(route, "HEAD")).status, 200);
  }
  assert.equal(logs.filter(item => item.event === "probe-start").length, 4);
});

test("expired attempts release capacity without invalidating a newer active attempt", async t => {
  let time = 1000;
  const { issueAttempt, logs, request } = await fixture(t, { now: () => time, ttlMs: 100, maxAttempts: 2 });
  const oldest = issueAttempt();
  time = 1050;
  const active = issueAttempt();
  assert.equal(issueAttempt(), null);
  time = 1100;
  const newest = issueAttempt();
  assert.match(newest, /^[a-f0-9]{24}$/);
  assert.equal(issueAttempt(), null);
  assert.equal(logs.filter(item => item.event === "issued").length, 3);
  assert.equal((await request(`/__fnos/diagnostics/${oldest}/start.gif`)).status, 404);
  for (const attempt of [active, newest]) {
    assert.equal((await request(`/__fnos/diagnostics/${attempt}/start.gif`)).status, 200);
  }
});

test("server probe and text logs share a 16-record budget, including HEAD, without blocking responses or client evidence", async t => {
  const { issueAttempt, logs, request } = await fixture(t, { maxEvents: 2 });
  const attempt = issueAttempt();
  for (let index = 0; index < 24; index += 1) {
    const route = index % 2 === 0 ? `/src/__fnos_probe_classic.js?d=${attempt}` : `/__fnos/diagnostics/${attempt}/text.txt`;
    assert.equal((await request(route, index % 3 === 0 ? "HEAD" : "GET")).status, 200);
  }
  const serverLogs = logs.filter(item => item.event === "server-probe" || item.event === "server-text");
  assert.equal(serverLogs.length, 16);
  assert.equal(serverLogs.filter(item => item.method === "HEAD").length, 6);
  assert.equal(serverLogs.filter(item => item.event === "server-probe").length, 8);
  assert.equal(serverLogs.filter(item => item.event === "server-text").length, 8);
  const event = `/__fnos/diagnostics/${attempt}/probe-executed.gif?mode=classic`;
  assert.equal((await request(event)).status, 200);
  assert.equal((await request(event)).status, 200);
  assert.equal((await request(event)).status, 429);
  assert.equal(logs.filter(item => item.event === "probe-executed").length, 2);
  const secondAttempt = issueAttempt();
  assert.equal((await request(`/src/__fnos_probe_classic.js?d=${secondAttempt}`)).status, 200);
  assert.equal(logs.filter(item => item.attempt === secondAttempt && item.event === "server-probe").length, 1);
});

test("invalid diagnostic options fail closed", () => {
  for (const options of [{ log: null }, { log() {}, ttlMs: 0 }, { log() {}, maxAttempts: -1 }, { log() {}, maxEvents: Infinity }, { log() {}, now: null }]) {
    assert.throws(() => createDiagnostics(options), /Diagnostic/);
  }
});
