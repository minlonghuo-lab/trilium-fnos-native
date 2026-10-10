#!/usr/bin/env python3
"""Verify nested FPK metadata and byte identity against the official server archive."""
import argparse
import hashlib
import json
import tarfile
from pathlib import PurePosixPath


def digest(stream, algorithm="sha256"):
    value = hashlib.new(algorithm)
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        value.update(chunk)
    return value.hexdigest()


def check_entry(entry):
    parts = PurePosixPath(entry.name).parts
    assert not entry.name.startswith("/") and ".." not in parts, entry.name
    assert entry.uid == entry.gid == 0, f"Unexpected owner: {entry.name}"
    assert entry.isfile() or entry.isdir(), f"Link or special file: {entry.name}"


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("fpk")
parser.add_argument("--upstream", required=True)
parser.add_argument("--entry-type", choices=["url", "iframe"], default="url")
parser.add_argument("--ios-entry", choices=["parser", "deferred"], default="parser")
parser.add_argument("--asset-namespace", choices=["0", "1"], default="0")
parser.add_argument("--diagnostics", choices=["0", "1"])
args = parser.parse_args()
expected_roots = {"app.tgz", "cmd", "config", "wizard", "manifest", "ICON.PNG", "ICON_256.PNG"}
with tarfile.open(args.fpk, "r:gz") as outer:
    entries = outer.getmembers()
    assert {PurePosixPath(entry.name).parts[0] for entry in entries} == expected_roots
    for entry in entries:
        check_entry(entry)
    manifest = dict(line.split("=", 1) for line in outer.extractfile("manifest").read().decode().splitlines() if "=" in line)
    manifest = {key.strip(): value.strip() for key, value in manifest.items()}
    assert manifest["maintainer"] == "TriliumNext"
    assert manifest["maintainer_url"] == "https://github.com/TriliumNext/Trilium"
    assert manifest["distributor"] == "Epochwl"
    assert manifest["distributor_url"] == "https://github.com/minlonghuo-lab/trilium-fnos-native"
    assert digest(outer.extractfile("app.tgz"), "md5") == manifest["checksum"]
    resource = json.load(outer.extractfile("config/resource"))
    privilege = json.load(outer.extractfile("config/privilege"))
    assert "docker-project" not in resource
    assert "docker" not in privilege.get("join-groups", [])
    assert privilege["defaults"]["run-as"] == "package"
    main = outer.extractfile("cmd/main").read().decode()
    assert 'BACKEND_PORT="18888"' in main and "18080" not in main
    assert 'TRILIUM_NETWORK_TRUSTEDREVERSEPROXY="127.0.0.1"' in main
    assert 'TRILIUM_GATEWAY_SOCKET="$GATEWAY_SOCKET"' in main
    assert "__RELEASE_ARCH__" not in main
    assert "main.mjs" in main and "main.cjs" in main
    packaged = {}
    diagnostic_marker = False
    ios_entry_marker = False
    compatibility_source = False
    namespace_marker = False
    namespace_source = False
    with tarfile.open(fileobj=outer.extractfile("app.tgz"), mode="r|gz") as payload:
        for entry in payload:
            check_entry(entry)
            if not entry.isfile():
                continue
            stream = payload.extractfile(entry)
            if entry.name.startswith("server/") and entry.name != "server/VERSION":
                packaged[entry.name[len("server/"):]] = digest(stream)
            elif entry.name == "ui/config":
                entry_config = next(iter(json.load(stream)[".url"].values()))
                assert entry_config["type"] == args.entry_type
                assert entry_config["gatewayPrefix"] == "/app/trilium-fnos"
                assert entry_config["gatewaySocket"] == "app.sock"
                assert entry_config["url"] == "/app/trilium-fnos/"
            elif entry.name == "proxy/diagnostic-mode.json":
                diagnostic_marker = json.load(stream) == {"enabled": True}
            elif entry.name == "proxy/ios-entry-mode.json":
                ios_entry_marker = json.load(stream) == {"mode": "deferred"}
            elif entry.name == "proxy/ios-entry.js":
                compatibility_source = "function deferEntry" in stream.read().decode()
            elif entry.name == "proxy/asset-namespace-mode.json":
                namespace_marker = json.load(stream) == {"enabled": True}
            elif entry.name == "proxy/asset-namespace.js":
                namespace_source = 'const REVISION = "v0.106.0-p1"' in stream.read().decode()
            elif entry.name == "proxy/module-audit-mode.json":
                raise AssertionError("Temporary module audit must not be enabled in an FPK")
            elif entry.name == "proxy/server.js":
                proxy = stream.read().decode()
                assert "TRILIUM_BACKEND_PORT || 18888" in proxy and "18080" not in proxy
                assert "createUpdateController" not in proxy
                assert "performUpdate" not in proxy
                assert "/__fnos/api/connections" in proxy
    if args.entry_type == "iframe":
        assert diagnostic_marker, "The comparison entry requires an explicitly diagnostic package"
    assert ios_entry_marker == (args.ios_entry == "deferred"), "Unexpected iOS entry mode"
    assert namespace_marker == (args.asset_namespace == "1"), "Unexpected static namespace mode"
    if args.diagnostics is not None:
        assert diagnostic_marker == (args.diagnostics == "1"), "Unexpected diagnostics mode"
    if namespace_marker:
        assert namespace_source, "Missing static namespace implementation"
        assert manifest["version"].startswith("0.106.0-"), "Static namespace/upstream mismatch"
    if ios_entry_marker:
        assert compatibility_source, "Missing iOS entry transformation"

official = {}
removed_link = "node_modules/tesseract.js/node_modules/.bin/opencollective-postinstall"
with tarfile.open(args.upstream, "r|xz") as upstream:
    for entry in upstream:
        relative = entry.name.partition("/")[2]
        if relative == removed_link:
            assert entry.issym(), "Only the known build-time symlink may be removed"
            continue
        if entry.isfile():
            official[relative] = digest(upstream.extractfile(entry))
assert official == packaged, "Packaged Trilium files differ from the official archive"
print(f"PASS {args.fpk}: native metadata, 18888, trusted proxy IP, {args.entry_type} gateway entry, root ownership, checksums; {len(official)} official files match byte-for-byte")
