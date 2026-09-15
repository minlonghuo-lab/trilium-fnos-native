"use strict";

const GATEWAY_PREFIX = "/app/trilium-fnos";

function gatewayRoute(rawUrl) {
  // Match a segment boundary, keeping the encoded path and query untouched.
  const queryIndex = rawUrl.indexOf("?");
  const pathname = queryIndex < 0 ? rawUrl : rawUrl.slice(0, queryIndex);
  if (pathname === GATEWAY_PREFIX) {
    return { redirect: `${GATEWAY_PREFIX}/${queryIndex < 0 ? "" : rawUrl.slice(queryIndex)}` };
  }
  if (!pathname.startsWith(`${GATEWAY_PREFIX}/`)) return null;
  return { upstream: rawUrl.slice(GATEWAY_PREFIX.length) };
}

function applyFramePolicy(headers, host, gateway) {
  let ancestors = "'self'";
  if (!gateway) {
    // Legacy direct-port access permits the same DNS host on fnOS's port.
    // Never infer trusted parent domains from Referer or client-forwarded headers.
    const hostname = new URL(`http://${host}`).hostname;
    if (/^[a-z0-9.-]+$/i.test(hostname)) {
      ancestors += ` http://${hostname}:* https://${hostname}:*`;
    }
  }
  const policies = headers["content-security-policy"];
  const values = Array.isArray(policies) ? policies : [policies || ""];
  // Each CSP policy is enforced independently; update every one, including
  // comma-combined policies, without discarding unrelated restrictions.
  headers["content-security-policy"] = values.flatMap((value) => String(value).split(","))
    .map((policy) => {
      const directives = policy.split(";").map((item) => item.trim())
        .filter((item) => item && !/^frame-ancestors(?:\s|$)/i.test(item));
      return [...directives, `frame-ancestors ${ancestors}`].join("; ");
    });
  delete headers["x-frame-options"];
}

function gatewayResponseHeaders(headers) {
  // Trilium uses relative asset/API URLs. Only absolute-root redirects and
  // cookies need translation; never rewrite user note bodies or attachments.
  const location = headers.location;
  if (typeof location === "string" && location.startsWith("/") && !location.startsWith("//") &&
      location !== GATEWAY_PREFIX && !location.startsWith(`${GATEWAY_PREFIX}/`)) {
    headers.location = `${GATEWAY_PREFIX}${location}`;
  }
  if (headers["set-cookie"]) {
    const cookies = Array.isArray(headers["set-cookie"]) ? headers["set-cookie"] : [headers["set-cookie"]];
    headers["set-cookie"] = cookies.map((cookie) => {
      const parts = cookie.split(";");
      let hasPath = false;
      const result = parts.filter((part) => !/^\s*domain=/i.test(part)).map((part) => {
        if (!/^\s*path=/i.test(part)) return part;
        hasPath = true;
        const oldPath = part.slice(part.indexOf("=") + 1).trim();
        if (oldPath === GATEWAY_PREFIX || oldPath.startsWith(`${GATEWAY_PREFIX}/`)) return part;
        return ` Path=${GATEWAY_PREFIX}${oldPath.startsWith("/") ? oldPath : "/"}`;
      });
      if (!hasPath) result.push(` Path=${GATEWAY_PREFIX}/`);
      return result.join(";");
    });
  }
}

function upstreamHeaders(req, gateway) {
  const headers = { ...req.headers };
  // Hop-by-hop headers are owned by this proxy, not an upstream connection.
  for (const name of String(headers.connection || "").split(",")) delete headers[name.trim().toLowerCase()];
  for (const name of ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade"]) delete headers[name];
  const forwardedProto = req.headers["x-forwarded-proto"];
  headers["x-forwarded-proto"] = gateway && ["http", "https"].includes(forwardedProto) ? forwardedProto : "http";
  headers["x-forwarded-host"] = req.headers.host || "localhost";
  headers["x-forwarded-for"] = req.socket.remoteAddress || "127.0.0.1";
  delete headers.forwarded;
  for (const name of Object.keys(headers)) if (name.startsWith("x-trim-")) delete headers[name];
  headers["accept-encoding"] = "identity";
  return headers;
}

module.exports = { GATEWAY_PREFIX, gatewayRoute, applyFramePolicy, gatewayResponseHeaders, upstreamHeaders };
