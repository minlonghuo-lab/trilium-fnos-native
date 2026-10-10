"use strict";

const crypto = require("node:crypto");

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const TEXT = Buffer.from("fnos-diagnostic-text-ok\n", "ascii");
const NONCE = /^[a-f0-9]{24}$/;
const MAX_URL_LENGTH = 1024;

const oneOf = values => value => values.includes(value) ? value : undefined;
const boolean = value => value === "1" || value === "true" ? true
  : value === "0" || value === "false" ? false : undefined;
const integer = maximum => value => /^(0|[1-9]\d{0,5})$/.test(value) && Number(value) <= maximum
  ? Number(value) : undefined;
const ready = oneOf(["loading", "interactive", "complete"]);
const splash = oneOf(["visible", "hidden", "absent"]);
const mode = oneOf(["classic", "anonymous", "credentials"]);
const duration = integer(22000);
const asset = oneOf(["index", "font", "splash", "theme", "helper", "other"]);
const realFields = { kind: oneOf(["entry", "preload", "css"]), asset };
const probeFields = { mode, ms: duration };
const SCHEMAS = {
  start: {
    fields: {
      protocol: oneOf(["http", "https", "file", "custom", "other"]),
      opaque: boolean, base_same: boolean, script_same: boolean, framed: boolean,
      client: oneOf(["ios", "android", "browser", "unknown"]),
      app_ver: value => value.length <= 20 && /^\d+(?:\.\d+)*$/.test(value) ? value : undefined,
      ready, base: oneOf(["gateway", "root", "other"])
    }
  },
  dom: {
    fields: {
      modules: integer(16), preloads: integer(16),
      entry: oneOf(["missing", "gateway", "root", "other", "cross"]),
      credentials: oneOf(["anonymous", "include", "absent", "other"]),
      ready, splash, glob: boolean, bootstrap: boolean, local_fetch: boolean,
      failure: oneOf(["none", "css", "module", "network", "syntax", "other"])
    }
  },
  "real-load": { fields: realFields, required: ["kind", "asset"] },
  "real-error": { fields: realFields, required: ["kind", "asset"] },
  entry: { fields: { phase: oneOf(["queued", "inserted", "load", "error", "invalid"]), ready }, required: ["phase"] },
  "probe-start": { fields: probeFields, required: ["mode"] },
  "probe-load": { fields: probeFields, required: ["mode"] },
  "probe-executed": { fields: probeFields, required: ["mode"] },
  "probe-error": { fields: probeFields, required: ["mode"] },
  "probe-timeout": { fields: probeFields, required: ["mode"] },
  fetch: {
    fields: {
      result: oneOf(["ok", "http", "error", "timeout"]), status: integer(599),
      mime: oneOf(["text", "js", "html", "other"]), bytes: integer(4096), ms: duration
    },
    required: ["result"]
  },
  csp: { fields: { directive: oneOf(["script-src", "script-src-elem", "connect-src", "style-src", "other"]) }, required: ["directive"] },
  error: { fields: { reason: oneOf(["cors", "module", "network", "syntax", "csp", "other"]) }, required: ["reason"] },
  finish: {
    fields: { reason: oneOf(["ready", "timeout", "pagehide"]), ms: integer(120000), ready, splash, glob: boolean },
    required: ["reason"]
  }
};

function validateFields(params, schema) {
  const result = Object.create(null);
  for (const [key, rawValue] of params) {
    if (!Object.hasOwn(schema.fields, key) || Object.hasOwn(result, key)) return undefined;
    const value = schema.fields[key](rawValue);
    if (value === undefined) return undefined;
    result[key] = value;
  }
  if (schema.required && schema.required.some(key => !Object.hasOwn(result, key))) return undefined;
  return result;
}

function send(req, res, status, body, contentType, completed) {
  // No ACAO or credentials-dependent response: module probes intentionally keep
  // the same-origin restrictions used by the actual application resources.
  const headers = {
    "content-type": contentType,
    "content-length": body.length,
    "cache-control": "no-store, no-transform",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin"
  };
  if (status === 405) headers.allow = "GET, HEAD";
  if (completed) {
    let recorded = false;
    const record = finish => {
      if (recorded) return;
      recorded = true;
      completed({ status, bytes: req.method === "HEAD" ? 0 : body.length, finish });
    };
    res.once("finish", () => record(true));
    res.once("close", () => record(false));
  }
  res.writeHead(status, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}

function createDiagnostics({ log, now = Date.now, ttlMs = 120000, maxAttempts = 64, maxEvents = 40 }) {
  if (typeof log !== "function" || typeof now !== "function") throw new TypeError("Diagnostic callbacks must be functions");
  if (![ttlMs, maxAttempts, maxEvents].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError("Diagnostic bounds must be positive safe integers");
  }
  const attempts = new Map();
  const record = payload => log(`fnos-diag ${JSON.stringify(payload)}`);
  function prune(time) {
    for (const [attempt, state] of attempts) {
      if (time >= state.expires) attempts.delete(attempt);
    }
  }
  function issueAttempt() {
    const created = now();
    prune(created);
    // A new page must not invalidate diagnostics still running in another
    // window. Saturation simply skips issuing diagnostics for the new page.
    if (attempts.size >= maxAttempts) return null;
    let attempt;
    do { attempt = crypto.randomBytes(12).toString("hex"); } while (attempts.has(attempt));
    attempts.set(attempt, { created, expires: created + ttlMs, events: 0, serverLogs: 0 });
    record({ attempt, event: "issued" });
    return attempt;
  }

  function handle(req, res, pathname) {
    const reserved = pathname === "/__fnos/diagnostics" || pathname.startsWith("/__fnos/diagnostics/")
      || pathname.startsWith("/src/__fnos_probe_");
    if (!reserved) return false;
    const fail = status => {
      send(req, res, status, Buffer.from(status === 405 ? "Method not allowed\n" : status === 400 ? "Bad request\n" : status === 429 ? "Diagnostic event limit\n" : "Not found\n", "ascii"), "text/plain; charset=us-ascii");
      return true;
    };
    if (!["GET", "HEAD"].includes(req.method)) return fail(405);
    if (typeof req.url !== "string" || req.url.length > MAX_URL_LENGTH) return fail(400);
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch { return fail(400); }
    if (url.pathname !== pathname) return fail(400);
    const probe = /^\/src\/__fnos_probe_(classic|anonymous|credentials)\.js$/.exec(pathname);
    const diagnostic = /^\/__fnos\/diagnostics\/([a-f0-9]{24})\/(text\.txt|([a-z-]+)\.gif)$/.exec(pathname);
    if (!probe && !diagnostic) return fail(404);
    let attempt;
    if (probe) {
      if (Array.from(url.searchParams).length !== 1 || !url.searchParams.has("d")) return fail(400);
      attempt = url.searchParams.get("d");
      if (!NONCE.test(attempt)) return fail(404);
    } else {
      attempt = diagnostic[1];
    }
    const time = now();
    prune(time);
    const state = attempts.get(attempt);
    if (!state) return fail(404);
    const elapsed = Math.max(0, Math.round(time - state.created));
    const recordResponse = (event, fields = {}) => response => {
      // Server completion records have their own bounded budget, including
      // HEAD probes, so they cannot exhaust useful browser event evidence.
      if (state.serverLogs >= 16) return;
      state.serverLogs += 1;
      record({ attempt, event, ...fields, elapsed, ...response });
    };
    if (probe) {
      const fixedMode = probe[1];
      const body = Buffer.from(`window.dispatchEvent(new CustomEvent('fnos:probe-executed',{detail:'${fixedMode}'}));\n`, "ascii");
      send(req, res, 200, body, "application/javascript; charset=utf-8",
        recordResponse("server-probe", { mode: fixedMode, method: req.method }));
      return true;
    }
    if (diagnostic[2] === "text.txt") {
      if (Array.from(url.searchParams).length) return fail(400);
      send(req, res, 200, TEXT, "text/plain; charset=us-ascii",
        recordResponse("server-text", { method: req.method }));
      return true;
    }
    const event = diagnostic[3];
    if (!Object.hasOwn(SCHEMAS, event)) return fail(404);
    const fields = validateFields(url.searchParams, SCHEMAS[event]);
    if (!fields) return fail(400);
    // HEAD checks resource reachability, never masquerades as a browser event.
    if (req.method !== "HEAD") {
      if (state.events >= maxEvents) return fail(429);
      state.events += 1;
      record({ attempt, event, elapsed, ...fields });
    }
    send(req, res, 200, GIF, "image/gif");
    return true;
  }

  return { issueAttempt, handle };
}

module.exports = { createDiagnostics };
