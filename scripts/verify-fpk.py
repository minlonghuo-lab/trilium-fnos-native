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
args = parser.parse_args()
expected_roots = {"app.tgz", "cmd", "config", "wizard", "manifest", "ICON.PNG", "ICON_256.PNG"}
with tarfile.open(args.fpk, "r:gz") as outer:
    entries = outer.getmembers()
    assert {PurePosixPath(entry.name).parts[0] for entry in entries} == expected_roots
    for entry in entries:
        check_entry(entry)
    manifest = dict(line.split("=", 1) for line in outer.extractfile("manifest").read().decode().splitlines() if "=" in line)
    manifest = {key.strip(): value.strip() for key, value in manifest.items()}
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
    packaged = {}
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
                assert entry_config["type"] == "url"
                assert entry_config["gatewayPrefix"] == "/app/trilium-fnos"
                assert entry_config["gatewaySocket"] == "app.sock"
                assert entry_config["url"] == "/app/trilium-fnos/"
            elif entry.name == "proxy/server.js":
                proxy = stream.read().decode()
                assert "TRILIUM_BACKEND_PORT || 18888" in proxy and "18080" not in proxy
                assert "TRILIUM_NETWORK_TRUSTEDREVERSEPROXY: BACKEND_HOST" in proxy

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
print(f"PASS {args.fpk}: native metadata, 18888, trusted proxy IP, new-tab gateway, root ownership, checksums; {len(official)} official files match byte-for-byte")
