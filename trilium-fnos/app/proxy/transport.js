"use strict";

const zlib = require("node:zlib");
const { Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

function hasResponseBody(method, status) {
  return method !== "HEAD" && status !== 204 && status !== 205 && status !== 304 && !(status >= 100 && status < 200);
}

function responseDecoders(headers, method, status) {
  if (!hasResponseBody(method, status)) return [];
  const encodings = String(headers["content-encoding"] || "").split(",")
    .map(value => value.trim().toLowerCase()).filter(value => value && value !== "identity");
  if (!encodings.length) return [];
  // A compressed byte range is not necessarily a complete compressed stream.
  if (status === 206) throw Object.assign(new Error("Compressed partial response is unsafe to decode"), { code: "ENCODED_PARTIAL_RESPONSE" });
  if (encodings.length > 4 || encodings.some(value => !["br", "gzip", "x-gzip", "deflate"].includes(value))) {
    throw Object.assign(new Error("Unsupported upstream content encoding"), { code: "UNSUPPORTED_CONTENT_ENCODING" });
  }
  // Content codings are applied left-to-right, so decode right-to-left.
  return encodings.reverse().map(value => value === "br" ? zlib.createBrotliDecompress()
    : value === "deflate" ? zlib.createInflate() : zlib.createGunzip());
}

function clearChangedEntityHeaders(headers) {
  for (const name of ["content-encoding", "content-length", "transfer-encoding", "etag", "content-md5", "digest", "content-digest", "repr-digest", "accept-ranges", "content-range", "trailer"]) {
    delete headers[name];
  }
}

function gatewayTransportHeaders(headers, encoded, startupAsset) {
  // This boundary feeds fnOS's private mobile transport. It must receive the
  // decoded representation, not browser-negotiated Brotli from the backend.
  if (encoded) clearChangedEntityHeaders(headers);
  delete headers["content-encoding"];
  // Old compression validators must not resurrect a cached encoded response.
  delete headers.etag;
  const directives = String(headers["cache-control"] || "").split(",").map(value => value.trim()).filter(Boolean);
  if (startupAsset) {
    // Revalidate hashed modules after a packaging/transport change as well.
    headers["cache-control"] = "no-cache, no-transform";
  } else {
    if (!directives.some(value => /^no-transform$/i.test(value))) directives.push("no-transform");
    headers["cache-control"] = directives.join(", ");
  }
  for (const name of String(headers.connection || "").split(",")) delete headers[name.trim().toLowerCase()];
  for (const name of ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade"]) delete headers[name];
}

async function readResponse(source, decoders, limit) {
  const chunks = [];
  let size = 0;
  const sink = new Writable({
    write(chunk, _encoding, done) {
      size += chunk.length;
      if (size > limit) return done(Object.assign(new Error("Decoded response exceeds size limit"), { code: "RESPONSE_TOO_LARGE" }));
      chunks.push(chunk);
      done();
    }
  });
  // pipeline propagates truncated streams, decoding errors and cancellation
  // to every participant; never mark a partial buffer as a successful body.
  await pipeline(source, ...decoders, sink);
  return Buffer.concat(chunks, size);
}

module.exports = { hasResponseBody, responseDecoders, clearChangedEntityHeaders, gatewayTransportHeaders, readResponse, pipeline };
