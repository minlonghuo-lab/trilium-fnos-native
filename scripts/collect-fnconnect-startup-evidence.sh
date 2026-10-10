#!/bin/sh
# Read-only NAS diagnostic. Prints only public startup paths and safe metadata.
set -eu

access_log="${1:-/usr/trim/nginx/logs/access.log}"
case "$access_log" in
  /*) ;;
  *) printf '%s\n' 'Please supply an absolute nginx access log path.' >&2; exit 2 ;;
esac
if [ ! -r "$access_log" ] || [ ! -f "$access_log" ]; then
  printf '%s\n' 'nginx access log is not a readable regular file.' >&2
  exit 1
fi

printf '%s\n' '# Read-only startup evidence; no IPs, cookies, queries, referrer URLs or note contents.'
printf '%s\n' '# Deliberately searches every path and every User-Agent, not only the application prefix.'
printf '%s\n' '# Columns: time | client category | HTTP version | status | nginx body bytes | public path | app referrer present | FNApp version'

awk -F '"' '
  {
    # nginx combined format: prefix "request" status/bytes "referrer" "UA".
    if (NF < 6) next;
    split($2, request, / +/);
    if (request[1] != "GET" && request[1] != "HEAD") next;
    target = request[2];
    sub(/[?#].*$/, "", target);
    sub(/^https?:\/\/[^\/]+/, "", target);
    # Strict public resource allowlist. Never print note or attachment URLs.
    current_entry = target ~ /\/(index-2IAUW27Z|font-DMVOl4cV|splash-BuLZdf1c|preload-helper-uBIymjUX|theme-DIqmDpk8)\.js$/;
    public_asset = current_entry || target ~ /^\/(app\/trilium-fnos\/)?(assets\/v[0-9.]+\/)?src\/[A-Za-z0-9_.-]+\.(js|css)$/;
    manager_asset = target ~ /^\/(app\/trilium-fnos\/)?__fnos\/assets\/(startup|sync|diagnostics)(-v0\.106\.0-p1)?\.(js|css)$/;
    namespace_asset = target ~ /^\/app\/trilium-fnos\/__fnos\/static\/v0\.106\.0-p1\/(src\/|assets\/|stylesheets\/)([A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(js|css)$/;
    app_document = target == "/app/trilium-fnos/" || target == "/app/trilium-fnos";
    manifest = target == "/manifest.webmanifest" || target == "/app/trilium-fnos/manifest.webmanifest";
    bootstrap = target == "/bootstrap" || target == "/app/trilium-fnos/bootstrap";
    audit_asset = target ~ /^\/(app\/trilium-fnos\/)?src\/__fnos_audit\/[a-f0-9]+\/(classic|tiny|large|ecma|graph|credentials|preload|graph-ecma)\/(tiny|large|entry|branch|leaf-[0-9]+)\.js$/;
    audit_page = target ~ /^\/(app\/trilium-fnos\/)?__fnos\/module-audit\/$/;
    audit_resource = target ~ /^\/(app\/trilium-fnos\/)?__fnos\/module-audit\/[a-f0-9]+\/(client\.js|event\.gif|official\/(toggle|index|large|css))$/;
    if (!public_asset && !manager_asset && !namespace_asset && !app_document && !manifest && !bootstrap && !audit_asset && !audit_page && !audit_resource) next;
    display_path = target;
    if (audit_asset || audit_resource) {
      audit_count = split(target, audit_parts, "/");
      for (audit_index = 1; audit_index <= audit_count; audit_index++) {
        if (audit_parts[audit_index] == "__fnos_audit" || audit_parts[audit_index] == "module-audit") break;
      }
      if (length(audit_parts[audit_index + 1]) != 24) next;
      sub(/\/[a-f0-9]+\//, "/<attempt>/", display_path);
    }
    # Exact known entry filenames are searched under ANY prefix. Show common
    # misresolved prefixes; redact arbitrary prefixes which could contain tokens.
    if (current_entry && !namespace_asset && target !~ /^\/(app\/trilium-fnos\/|app\/|trilium-fnos\/)?src\//) {
      count = split(target, segments, "/");
      display_path = "<other-prefix>/" segments[count];
    }
    split($3, metadata, / +/);
    if (metadata[2] !~ /^[0-9][0-9][0-9]$/ || metadata[3] !~ /^[0-9]+$/) next;
    timestamp = "unknown";
    if (match($1, /\[[^]]+\]/)) timestamp = substr($1, RSTART + 1, RLENGTH - 2);
    ua = $6;
    client = "other";
    if (ua ~ /FNAppType\/iOS/) client = "FNApp-iOS";
    else if (ua ~ /FNAppType\//) client = "FNApp-other";
    else if (ua ~ /iPhone|iPad/) client = "iOS-unmarked";
    else if (ua ~ /Firefox\//) client = "Firefox";
    else if (ua ~ /Safari\//) client = "Safari-like";
    version = "-";
    if (match(ua, /FNAppVer\/[0-9.]+/)) version = substr(ua, RSTART + 9, RLENGTH - 9);
    referrer_present = $4 ~ /\/app\/trilium-fnos(\/|[?#]|$)/ ? "yes" : "no";
    records[(++count_records) % 500] = sprintf("%s | %s | %s | %s | %s | %s | %s | %s", timestamp, client, request[3], metadata[2], metadata[3], display_path, referrer_present, version);
  }
  END {
    first = count_records > 500 ? count_records - 499 : 1;
    for (entry = first; entry <= count_records; entry++) print records[entry % 500];
  }
' "$access_log"
