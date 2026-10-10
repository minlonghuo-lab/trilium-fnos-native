"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawn } = require("node:child_process");
const { after, before, test } = require("node:test");

const root = path.resolve(__dirname, "..");
// Separate from the main proxy integration fixture, including its backend port.
const backendPort = 19388;
const publicPort = 19380;
const prefix = "/app/trilium-fnos";
const encoders = { br: zlib.brotliCompressSync, gzip: zlib.gzipSync, deflate: zlib.deflateSync };
const script = Buffer.from('export const greeting = "原生笔记 🌿";\n'.repeat(128));
const stylesheet = Buffer.from('.note::before { content: "笔记 🌿"; }\n'.repeat(96));
const attachment = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256));
const html = Buffer.from('<!doctype html><html><head><title>Trilium</title></head><body>笔记 🌿<script type="module" src="src/index-fixture.js"></script></body></html>');
let backend;
let proxy;
let socketDir;
let socketPath;
let releaseStreamingResponse;
let interruptStreamingResponse;
let streamingEnded;
let proxyOutput = "";

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function request(route, { gateway = true, method = "GET", headers = {}, body, onData } = {}) {
  return new Promise((resolve, reject) => {
    const options = gateway
      ? { socketPath, host: "nas.example", path: prefix + route }
      : { hostname: "127.0.0.1", port: publicPort, path: route };
    const req = http.request({ ...options, method, headers }, res => {
      const chunks = [];
      res.on("data", chunk => { chunks.push(chunk); if (onData) onData(chunk); });
      res.on("error", reject);
      res.on("aborted", () => reject(new Error(`Response aborted for ${route}`)));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.setTimeout(4000, () => req.destroy(new Error(`Request stalled for ${route}; proxy: ${proxyOutput}`)));
    req.end(body);
  });
}

function compressed(res, req, encoding, body, contentType = "application/octet-stream", status = 200) {
  const encoded = encoders[encoding](body);
  res.writeHead(status, {
    "content-type": contentType,
    "content-encoding": encoding,
    "content-length": encoded.length,
    "cache-control": "public, max-age=31536000, immutable",
    etag: '"compressed-representation"',
    "content-md5": "compressed-md5",
    digest: "sha-256=compressed-digest",
    "x-seen-encoding": req.headers["accept-encoding"] || ""
  });
  res.end(encoded);
}

before(async () => {
  socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-"));
  socketPath = path.join(socketDir, "a.sock");
  backend = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/inspect") {
      const chunks = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json", etag: '"identity-representation"' });
        res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("base64") }));
      });
      return;
    }
    const staticMatch = /^\/src\/fixture-(br|gzip|deflate)\.(js|css)$/.exec(url.pathname);
    if (staticMatch) {
      const original = staticMatch[2] === "js" ? script : stylesheet;
      const body = url.searchParams.get("revision") === "2" ? Buffer.concat([original, Buffer.from("\n/* updated fixture */\n")]) : original;
      return compressed(res, req, staticMatch[1], body,
        staticMatch[2] === "js" ? "application/javascript; charset=utf-8" : "text/css; charset=utf-8");
    }
    if (url.pathname === "/src/range.js") {
      res.writeHead(206, { "content-type": "application/javascript", "content-range": `bytes 2-8/${script.length}`, "content-length": 7 });
      return res.end(script.subarray(2, 9));
    }
    if (url.pathname === "/src/stacked.js") {
      const encoded = zlib.brotliCompressSync(zlib.gzipSync(script));
      res.writeHead(200, { "content-type": "application/javascript", "content-encoding": "gzip, br", "content-length": encoded.length });
      return res.end(encoded);
    }
    if (url.pathname === "/src/truncated.js") {
      const encoded = zlib.gzipSync(script).subarray(0, -8);
      res.writeHead(200, { "content-type": "application/javascript", "content-encoding": "gzip", "content-length": encoded.length });
      return res.end(encoded);
    }
    if (url.pathname === "/src/oversized.js") {
      const encoded = zlib.gzipSync(Buffer.alloc(32 * 1024 * 1024 + 1, 0x61));
      res.writeHead(200, { "content-type": "application/javascript", "content-encoding": "gzip", "content-length": encoded.length });
      return res.end(encoded);
    }
    if (url.pathname === "/") return compressed(res, req, url.searchParams.get("encoding") || "br", html, "text/html; charset=utf-8");
    if (url.pathname === "/attachment.bin") return compressed(res, req, url.searchParams.get("encoding") || "br", attachment);
    if (url.pathname === "/attachment.html") return compressed(res, req, "gzip", html, "text/html; charset=utf-8");
    if (url.pathname === "/api/stream") {
      const compressor = zlib.createGzip();
      streamingEnded = false;
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", etag: '"compressed-stream"', digest: "sha-256=compressed-digest" });
      compressor.pipe(res);
      // Hold completion until the client receives the first decoded bytes: a
      // proxy buffering arbitrary responses will stall and fail this test.
      releaseStreamingResponse = () => {
        if (streamingEnded) return;
        streamingEnded = true;
        compressor.end('"last":true}');
      };
      compressor.write('{"first":"笔记 🌿",');
      compressor.flush(zlib.constants.Z_SYNC_FLUSH);
      res.on("close", () => compressor.destroy());
      return;
    }
    if (url.pathname === "/api/interrupted") {
      const compressor = zlib.createGzip();
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      compressor.pipe(res);
      interruptStreamingResponse = () => res.destroy();
      compressor.write('{"first":"笔记 🌿",');
      compressor.flush(zlib.constants.Z_SYNC_FLUSH);
      res.on("close", () => compressor.destroy());
      return;
    }
    if (url.pathname === "/src/broken.js") {
      res.writeHead(200, { "content-type": "application/javascript", "content-encoding": url.searchParams.get("encoding") || "gzip" });
      return res.end("This is not a compressed stream");
    }
    if (url.pathname === "/src/head.js") {
      res.writeHead(200, { "content-type": "application/javascript", "content-encoding": "br", "content-length": 123, etag: '"compressed-head"' });
      return res.end();
    }
    if (url.pathname === "/no-body") {
      res.writeHead(Number(url.searchParams.get("status")), { "content-encoding": "gzip", "content-length": 123, etag: '"compressed-empty"' });
      return res.end();
    }
    if (url.pathname === "/range") {
      if (url.searchParams.has("compressed")) {
        res.writeHead(206, { "content-type": "application/octet-stream", "content-encoding": "gzip", "content-range": "bytes 2-8/100", "content-length": 7 });
        return res.end(Buffer.from([0x08, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03]));
      }
      res.writeHead(206, { "content-type": "application/octet-stream", "content-range": "bytes 2-8/4096", "content-length": 7,
        "x-seen-range": req.headers.range || "", "x-seen-if-range": req.headers["if-range"] || "" });
      return res.end(attachment.subarray(2, 9));
    }
    res.writeHead(404).end();
  });
  await listen(backend, backendPort);
  proxy = spawn(process.execPath, [path.join(root, "trilium-fnos/app/proxy/server.js")], {
    env: { ...process.env, TRILIUM_PUBLIC_PORT: String(publicPort), TRILIUM_BACKEND_PORT: String(backendPort), TRILIUM_GATEWAY_SOCKET: socketPath },
    stdio: ["ignore", "pipe", "pipe"]
  });
  proxy.stdout.on("data", chunk => { proxyOutput += chunk.toString(); });
  proxy.stderr.on("data", chunk => { proxyOutput += chunk.toString(); });
  const deadline = Date.now() + 5000;
  while (true) {
    try { await request("/inspect", { gateway: false }); break; }
    catch (error) {
      if (proxy.exitCode !== null || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
});

after(async () => {
  if (releaseStreamingResponse) releaseStreamingResponse();
  if (proxy && proxy.exitCode === null) {
    await new Promise(resolve => { proxy.once("exit", resolve); proxy.kill("SIGTERM"); });
  }
  if (backend) await new Promise(resolve => { backend.close(resolve); backend.closeAllConnections(); });
  if (socketDir) fs.rmSync(socketDir, { recursive: true, force: true });
});

test("gateway GET negotiates identity and bypasses legacy compressed validators", async () => {
  const response = await request("/inspect?encoded=a%2Fb", { headers: {
    "accept-encoding": "gzip, deflate, br", "if-none-match": '"legacy-br"', "if-modified-since": "Thu, 01 Oct 2026 00:00:00 GMT"
  } });
  assert.equal(response.status, 200);
  const inspected = JSON.parse(response.body);
  assert.equal(inspected.url, "/inspect?encoded=a%2Fb");
  assert.equal(inspected.headers["accept-encoding"], "identity");
  assert.equal(inspected.headers["if-none-match"], undefined);
  assert.equal(inspected.headers["if-modified-since"], undefined);
  assert.equal(response.headers.etag, undefined);
  assert.match(response.headers["cache-control"], /\bno-transform\b/);
});

test("gateway mutation preconditions and binary request bytes remain intact", async () => {
  const response = await request("/inspect", { method: "POST", body: attachment, headers: {
    "content-type": "application/octet-stream", "accept-encoding": "br", "if-none-match": "*", "if-match": '"required-version"',
    "if-unmodified-since": "Thu, 01 Oct 2026 00:00:00 GMT"
  } });
  const inspected = JSON.parse(response.body);
  assert.equal(inspected.headers["accept-encoding"], "identity");
  assert.equal(inspected.headers["if-none-match"], "*");
  assert.equal(inspected.headers["if-match"], '"required-version"');
  assert.equal(inspected.headers["if-unmodified-since"], "Thu, 01 Oct 2026 00:00:00 GMT");
  assert.deepEqual(Buffer.from(inspected.body, "base64"), attachment);
});

test("gateway decodes br, gzip and deflate JS/CSS into complete byte-correct responses", async () => {
  for (const encoding of Object.keys(encoders)) {
    for (const extension of ["js", "css"]) {
      const response = await request(`/src/fixture-${encoding}.${extension}`, { headers: { "accept-encoding": "gzip, deflate, br" } });
      const expected = extension === "js" ? script : stylesheet;
      assert.equal(response.status, 200, `${encoding}/${extension}`);
      assert.deepEqual(response.body, expected, `${encoding}/${extension} decoded bytes`);
      assert.equal(response.headers["x-seen-encoding"], "identity");
      assert.equal(response.headers["content-encoding"], undefined);
      assert.equal(Number(response.headers["content-length"]), expected.length);
      const identityTag = `W/"fnos-identity-${crypto.createHash("sha256").update(expected).digest("hex")}"`;
      assert.equal(response.headers.etag, identityTag, `${encoding}/${extension} identity byte validator`);
      assert.notEqual(response.headers.etag, '"compressed-representation"');
      for (const header of ["content-md5", "digest"]) assert.equal(response.headers[header], undefined, `${encoding}/${extension} ${header}`);
      assert.match(response.headers["cache-control"], /\bno-transform\b/);
      assert.match(response.headers["cache-control"], /\bno-cache\b/);
      assert.doesNotMatch(response.headers["cache-control"], /\bimmutable\b/);
    }
  }
});

test("gateway startup cache revalidates identity bytes without reusing compressed validators", async () => {
  const route = "/src/fixture-br.js";
  const first = await request(route, { headers: { "if-none-match": '"compressed-representation"', "accept-encoding": "br" } });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, script);
  assert.match(first.headers.etag, /^W\/"fnos-identity-[a-f0-9]{64}"$/);
  const cached = await request(route, { headers: { "if-none-match": first.headers.etag, "accept-encoding": "gzip, br" } });
  assert.equal(cached.status, 304);
  assert.equal(cached.body.length, 0);
  assert.equal(cached.headers.etag, first.headers.etag);
  assert.equal(cached.headers["content-encoding"], undefined);
  assert.equal(cached.headers["content-length"], undefined);
  assert.match(cached.headers["cache-control"], /\bno-cache\b/);
  assert.match(cached.headers["cache-control"], /\bno-transform\b/);
  const changed = await request(`${route}?revision=2`, { headers: { "if-none-match": first.headers.etag } });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body, Buffer.concat([script, Buffer.from("\n/* updated fixture */\n")]));
  assert.notEqual(changed.headers.etag, first.headers.etag);
  assert.match(changed.headers.etag, /^W\/"fnos-identity-[a-f0-9]{64}"$/);
});

test("gateway decodes root HTML before injecting startup and sync resources", async () => {
  const response = await request("/?encoding=br", { headers: { "accept-encoding": "br" } });
  assert.equal(response.status, 200);
  const document = response.body.toString("utf8");
  assert.match(document, /笔记 🌿/);
  assert.match(document, /<head><script src="\/app\/trilium-fnos\/__fnos\/assets\/startup\.js"/);
  assert.match(document, /src="\/app\/trilium-fnos\/__fnos\/assets\/sync\.js"/);
  assert.equal(response.headers["content-encoding"], undefined);
  assert.equal(Number(response.headers["content-length"]), response.body.length);
  assert.match(response.headers["cache-control"], /\bno-store\b/);
  assert.match(response.headers["cache-control"], /\bno-transform\b/);
});

test("gateway decodes stacked content codings in reverse application order", async () => {
  const response = await request("/src/stacked.js");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, script);
  assert.equal(response.headers["content-encoding"], undefined);
  assert.equal(Number(response.headers["content-length"]), script.length);
});

test("truncated compressed startup assets never become successful partial scripts", async () => {
  const response = await request("/src/truncated.js");
  assert.equal(response.status, 502);
  assert.equal(response.headers["content-encoding"], undefined);
  assert.match(response.body.toString(), /compressed|decode|encoding|response/i);
});

test("gateway limits decoded startup asset size rather than its compressed byte length", async () => {
  const response = await request("/src/oversized.js");
  assert.equal(response.status, 502);
  assert.equal(response.headers["content-encoding"], undefined);
  assert.equal(JSON.parse(response.body).code, "RESPONSE_TOO_LARGE");
  // A failed buffered response must not return the tens of MiB of script data.
  assert.ok(response.body.length < 4096);
});

test("decoded attachments retain original bytes and lose encoded representation metadata", async () => {
  const response = await request("/attachment.bin?encoding=deflate");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, attachment);
  for (const header of ["content-encoding", "content-length", "etag", "content-md5", "digest"]) assert.equal(response.headers[header], undefined, header);
  assert.match(response.headers["cache-control"], /\bno-transform\b/);
  const document = await request("/attachment.html");
  assert.deepEqual(document.body, html);
  assert.doesNotMatch(document.body.toString(), /data-trilium-fnos/);
});

test("gateway sends first decoded streaming bytes before upstream completion", async () => {
  let firstChunkReceived = false;
  const response = await request("/api/stream", { onData() {
    if (firstChunkReceived) return;
    firstChunkReceived = true;
    assert.equal(streamingEnded, false, "stream must reach the client before its final upstream chunk");
    releaseStreamingResponse();
  } });
  assert.equal(firstChunkReceived, true);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { first: "笔记 🌿", last: true });
  assert.equal(response.headers["content-encoding"], undefined);
  assert.equal(response.headers["content-length"], undefined);
  assert.equal(response.headers.digest, undefined);
});

test("interrupted encoded streams abort the client instead of ending successfully", async () => {
  let firstChunkReceived = false;
  await assert.rejects(request("/api/interrupted", { onData() {
    if (firstChunkReceived) return;
    firstChunkReceived = true;
    interruptStreamingResponse();
  } }), /aborted|premature|socket|reset/i);
  assert.equal(firstChunkReceived, true, "the connection must fail after decoded bytes have reached the client");
  assert.equal((await request("/inspect")).status, 200, "stream failure must not stop the proxy");
});

test("direct transport keeps negotiated compressed bytes, validators and request bytes", async () => {
  for (const encoding of ["br", "gzip"]) {
    const response = await request(`/attachment.bin?encoding=${encoding}`, { gateway: false, headers: { "accept-encoding": encoding } });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, encoders[encoding](attachment));
    assert.equal(response.headers["content-encoding"], encoding);
    assert.equal(response.headers["x-seen-encoding"], encoding);
    assert.equal(response.headers.etag, '"compressed-representation"');
    assert.equal(Number(response.headers["content-length"]), response.body.length);
  }
  const response = await request("/inspect?encoded=a%2Fb", { gateway: false, method: "POST", body: attachment, headers: {
    "accept-encoding": "gzip, deflate, br", "if-none-match": '"direct-validator"', "content-type": "application/octet-stream"
  } });
  const inspected = JSON.parse(response.body);
  assert.equal(inspected.headers["accept-encoding"], "gzip, deflate, br");
  assert.equal(inspected.headers["if-none-match"], '"direct-validator"');
  assert.deepEqual(Buffer.from(inspected.body, "base64"), attachment);
});

test("gateway handles encoded HEAD, 304 and 204 without decoding absent bodies", async () => {
  const cases = [["/src/head.js", "HEAD", 200], ["/no-body?status=304", "GET", 304], ["/no-body?status=204", "GET", 204]];
  for (const [route, method, status] of cases) {
    const response = await request(route, { method });
    assert.equal(response.status, status, `${method} ${status}`);
    assert.equal(response.body.length, 0);
    assert.equal(response.headers["content-encoding"], undefined);
    assert.equal(response.headers["content-length"], undefined);
    assert.equal(response.headers.etag, undefined);
    assert.match(response.headers["cache-control"], /\bno-transform\b/);
  }
});

test("invalid encoded startup assets fail clearly instead of returning corrupt JavaScript", async () => {
  for (const encoding of Object.keys(encoders)) {
    const response = await request(`/src/broken.js?encoding=${encoding}`);
    assert.equal(response.status, 502, encoding);
    assert.equal(response.headers["content-encoding"], undefined);
    assert.match(response.body.toString(), /compressed|decode|encoding|response/i);
    assert.doesNotMatch(response.body.toString(), /This is not a compressed stream/);
  }
});

test("gateway rejects compressed partial responses and preserves identity Range/If-Range", async () => {
  const headers = { range: "bytes=2-8", "if-range": '"matching-identity-version"' };
  const compressedResponse = await request("/range?compressed", { headers });
  assert.equal(compressedResponse.status, 502);
  assert.equal(compressedResponse.headers["content-encoding"], undefined);
  assert.match(compressedResponse.body.toString(), /range|partial|206/i);
  const identityResponse = await request("/range", { headers });
  assert.equal(identityResponse.status, 206);
  assert.equal(identityResponse.headers["content-range"], "bytes 2-8/4096");
  assert.equal(identityResponse.headers["x-seen-range"], headers.range);
  assert.equal(identityResponse.headers["x-seen-if-range"], headers["if-range"]);
  assert.equal(Number(identityResponse.headers["content-length"]), 7);
  assert.deepEqual(identityResponse.body, attachment.subarray(2, 9));
});

test("buffered identity startup ranges preserve Content-Range and exact partial bytes", async () => {
  const response = await request("/src/range.js", { headers: { range: "bytes=2-8" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers["content-range"], `bytes 2-8/${script.length}`);
  assert.equal(Number(response.headers["content-length"]), 7);
  assert.equal(response.headers["content-encoding"], undefined);
  assert.equal(response.headers.etag, undefined);
  assert.deepEqual(response.body, script.subarray(2, 9));
});
