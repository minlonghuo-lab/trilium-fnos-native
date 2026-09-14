#!/bin/bash
set -euo pipefail
export COPYFILE_DISABLE=1

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS_DIR="${ROOT_DIR}/.tools"
CACHE_DIR="${ROOT_DIR}/.cache/upstream"
DIST_DIR="${ROOT_DIR}/dist"
FNPACK_VERSION="1.2.3"
UPSTREAM_VERSION="${UPSTREAM_VERSION:-v0.105.0}"
PACKAGE_VERSION="${PACKAGE_VERSION:-${UPSTREAM_VERSION#v}-r3}"
PACKAGE_VERSION="${PACKAGE_VERSION#v}"
OUTPUT_VERSION="v${PACKAGE_VERSION}"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) FNPACK_TARGET="darwin-arm64" ;;
  Darwin-x86_64) FNPACK_TARGET="darwin-amd64" ;;
  Linux-aarch64|Linux-arm64) FNPACK_TARGET="linux-arm64" ;;
  Linux-x86_64) FNPACK_TARGET="linux-amd64" ;;
  *) echo "Unsupported build host: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$TOOLS_DIR" "$CACHE_DIR" "$DIST_DIR"
FNPACK="${TOOLS_DIR}/fnpack-${FNPACK_VERSION}-${FNPACK_TARGET}"

if tar --version 2>&1 | grep -qi bsdtar; then
  TAR_OWNER_ARGS=(--uid 0 --gid 0 --uname root --gname root --no-xattrs)
else
  TAR_OWNER_ARGS=(--owner=0 --group=0 --numeric-owner --no-xattrs)
fi

md5_file() {
  if command -v md5sum >/dev/null 2>&1; then
    md5sum "$1" | awk '{print $1}'
  else
    md5 -q "$1"
  fi
}

if [ ! -x "$FNPACK" ]; then
  curl --fail --location --retry 3 \
    "https://static2.fnnas.com/fnpack/fnpack-${FNPACK_VERSION}-${FNPACK_TARGET}" \
    --output "$FNPACK"
  chmod +x "$FNPACK"
fi

SKIP_INTEGRATION=0 "${ROOT_DIR}/scripts/validate.sh" "${ROOT_DIR}/trilium-fnos"

RELEASE_JSON="$(curl --fail --location --retry 3 \
  -H 'Accept: application/vnd.github+json' \
  -H 'User-Agent: trilium-fnos-builder/1.0' \
  "https://api.github.com/repos/TriliumNext/Trilium/releases/tags/${UPSTREAM_VERSION}")"

build_one() {
  local fnos_platform="$1"
  local release_arch="$2"
  local output_arch="$3"
  local asset_name="TriliumNotes-Server-${UPSTREAM_VERSION}-${release_arch}.tar.xz"
  local archive_path="${CACHE_DIR}/${asset_name}"
  local asset_meta
  local asset_url
  local expected_sha
  local actual_sha
  local build_dir
  local fpk_path
  local unsafe_upstream_link
  local normalize_dir
  local app_checksum

  asset_meta="$(printf '%s' "$RELEASE_JSON" | python3 -c '
import json, sys
name = sys.argv[1]
release = json.load(sys.stdin)
asset = next((item for item in release.get("assets", []) if item.get("name") == name), None)
if not asset:
    raise SystemExit(f"Release asset not found: {name}")
digest = str(asset.get("digest") or "")
if not digest.startswith("sha256:"):
    raise SystemExit(f"Release asset has no SHA-256 digest: {name}")
print(asset["browser_download_url"])
print(digest.removeprefix("sha256:"))
' "$asset_name")"
  asset_url="$(printf '%s\n' "$asset_meta" | sed -n '1p')"
  expected_sha="$(printf '%s\n' "$asset_meta" | sed -n '2p')"

  if [ ! -f "$archive_path" ]; then
    curl --fail --location --retry 3 "$asset_url" --output "$archive_path"
  fi
  actual_sha="$(python3 -c '
import hashlib, sys
h = hashlib.sha256()
with open(sys.argv[1], "rb") as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        h.update(chunk)
print(h.hexdigest())
' "$archive_path")"
  if [ "$actual_sha" != "$expected_sha" ]; then
    echo "SHA-256 mismatch for ${asset_name}" >&2
    exit 1
  fi

  build_dir="$(mktemp -d)"
  cp -R "${ROOT_DIR}/trilium-fnos" "${build_dir}/trilium-fnos"
  mkdir -p "${build_dir}/trilium-fnos/app/server"
  tar -xJf "$archive_path" -C "${build_dir}/trilium-fnos/app/server" --strip-components=1
  unsafe_upstream_link="${build_dir}/trilium-fnos/app/server/node_modules/tesseract.js/node_modules/.bin/opencollective-postinstall"
  if [ -L "$unsafe_upstream_link" ]; then
    unlink "$unsafe_upstream_link"
  fi
  printf '%s\n' "${UPSTREAM_VERSION#v}" > "${build_dir}/trilium-fnos/app/server/VERSION"

  python3 - "${build_dir}/trilium-fnos" "$fnos_platform" "$release_arch" "$PACKAGE_VERSION" <<'PY'
from pathlib import Path
import sys

package_dir = Path(sys.argv[1])
platform, release_arch, version = sys.argv[2:]
manifest = package_dir.joinpath("manifest").read_text()
lines = []
for line in manifest.splitlines():
    if line.startswith("platform="):
        line = f"platform={platform}"
    elif line.startswith("version="):
        line = f"version={version}"
    lines.append(line)
package_dir.joinpath("manifest").write_text("\n".join(lines) + "\n")
for script in package_dir.joinpath("cmd").iterdir():
    if script.is_file():
        text = script.read_text()
        script.write_text(text.replace("__RELEASE_ARCH__", release_arch))
PY

  chmod +x "${build_dir}/trilium-fnos"/cmd/*
  chmod +x "${build_dir}/trilium-fnos/app/server/node/bin/node"
  [ ! -f "${build_dir}/trilium-fnos/app/server/trilium.sh" ] || \
    chmod +x "${build_dir}/trilium-fnos/app/server/trilium.sh"
  cp "${build_dir}/trilium-fnos/LICENSE" "${build_dir}/trilium-fnos/app/LICENSE"

  SKIP_INTEGRATION=1 "${ROOT_DIR}/scripts/validate.sh" "${build_dir}/trilium-fnos"
  (
    cd "$build_dir"
    "$FNPACK" build --directory trilium-fnos
  )
  fpk_path="$(find "$build_dir" -maxdepth 2 -type f -name '*.fpk' -print -quit)"
  if [ -z "$fpk_path" ]; then
    echo "fnpack completed without producing an .fpk file." >&2
    exit 1
  fi

  normalize_dir="$(mktemp -d)"
  mkdir -p "${normalize_dir}/outer" "${normalize_dir}/payload"
  tar -xzf "$fpk_path" -C "${normalize_dir}/outer"
  tar -xzf "${normalize_dir}/outer/app.tgz" -C "${normalize_dir}/payload"
  tar "${TAR_OWNER_ARGS[@]}" -czf "${normalize_dir}/app.tgz" \
    -C "${normalize_dir}/payload" LICENSE THIRD_PARTY_NOTICES.md proxy server ui
  mv "${normalize_dir}/app.tgz" "${normalize_dir}/outer/app.tgz"
  app_checksum="$(md5_file "${normalize_dir}/outer/app.tgz")"
  python3 - "${normalize_dir}/outer/manifest" "$app_checksum" <<'PY'
from pathlib import Path
import sys

manifest_path = Path(sys.argv[1])
checksum = sys.argv[2]
lines = []
for line in manifest_path.read_text().splitlines():
    if line.lstrip().startswith("checksum"):
        line = f"checksum                   = {checksum}"
    lines.append(line)
manifest_path.write_text("\n".join(lines) + "\n")
PY
  tar "${TAR_OWNER_ARGS[@]}" -czf "${normalize_dir}/normalized.fpk" \
    -C "${normalize_dir}/outer" app.tgz cmd config wizard manifest ICON.PNG ICON_256.PNG
  fpk_path="${normalize_dir}/normalized.fpk"

  cp "$fpk_path" "${DIST_DIR}/trilium-fnos-${OUTPUT_VERSION}-${output_arch}.fpk"
  rm -rf "$build_dir"
  echo "Built ${DIST_DIR}/trilium-fnos-${OUTPUT_VERSION}-${output_arch}.fpk"
}

build_one x86 linux-x64 x86_64
build_one arm linux-arm64 arm64
