#!/bin/bash
set -euo pipefail
export COPYFILE_DISABLE=1

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS_DIR="${ROOT_DIR}/.tools"
CACHE_DIR="${ROOT_DIR}/.cache/upstream"
DIST_DIR="${ROOT_DIR}/dist"
FNPACK_VERSION="1.2.3"
UPSTREAM_VERSION="${UPSTREAM_VERSION:-v0.106.0}"
DEFAULT_PACKAGE_VERSION="${UPSTREAM_VERSION#v}-r1"
if [ "$UPSTREAM_VERSION" = "v0.106.0" ]; then DEFAULT_PACKAGE_VERSION="0.106.0-r7"; fi
PACKAGE_VERSION="${PACKAGE_VERSION:-$DEFAULT_PACKAGE_VERSION}"
PACKAGE_VERSION="${PACKAGE_VERSION#v}"
PACKAGE_DIAGNOSTICS="${PACKAGE_DIAGNOSTICS:-0}"
case "$PACKAGE_DIAGNOSTICS" in 0|1) ;; *) echo "PACKAGE_DIAGNOSTICS must be 0 or 1" >&2; exit 2 ;; esac
PACKAGE_ENTRY_TYPE="${PACKAGE_ENTRY_TYPE:-url}"
case "$PACKAGE_ENTRY_TYPE" in url|iframe) ;; *) echo "PACKAGE_ENTRY_TYPE must be url or iframe" >&2; exit 2 ;; esac
DEFAULT_ASSET_NAMESPACE=0
if [ "$UPSTREAM_VERSION" = "v0.106.0" ] && [ "$PACKAGE_VERSION" = "0.106.0-r7" ]; then DEFAULT_ASSET_NAMESPACE=1; fi
PACKAGE_ASSET_NAMESPACE="${PACKAGE_ASSET_NAMESPACE:-$DEFAULT_ASSET_NAMESPACE}"
case "$PACKAGE_ASSET_NAMESPACE" in 0|1) ;; *) echo "PACKAGE_ASSET_NAMESPACE must be 0 or 1" >&2; exit 2 ;; esac
if [ "$PACKAGE_ASSET_NAMESPACE" = "1" ] && [ "$UPSTREAM_VERSION" != "v0.106.0" ]; then
  echo "The static namespace is verified only for Trilium v0.106.0." >&2; exit 2
fi
DEFAULT_IOS_ENTRY=parser
if [ "$PACKAGE_ASSET_NAMESPACE" = "1" ]; then DEFAULT_IOS_ENTRY=deferred; fi
PACKAGE_IOS_ENTRY="${PACKAGE_IOS_ENTRY:-$DEFAULT_IOS_ENTRY}"
case "$PACKAGE_IOS_ENTRY" in parser|deferred) ;; *) echo "PACKAGE_IOS_ENTRY must be parser or deferred" >&2; exit 2 ;; esac
if [ "$PACKAGE_ENTRY_TYPE" = "iframe" ] && [ "$PACKAGE_DIAGNOSTICS" != "1" ]; then
  echo "The iframe entry is a diagnostic comparison; set PACKAGE_DIAGNOSTICS=1." >&2
  exit 2
fi
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

if ! RELEASE_JSON="$(curl --fail --location --retry 3 --connect-timeout 15 --max-time 60 \
  -H 'Accept: application/vnd.github+json' \
  -H 'User-Agent: trilium-fnos-builder/1.0' \
  "https://api.github.com/repos/TriliumNext/Trilium/releases/tags/${UPSTREAM_VERSION}")"; then
  # Public API limits should not block an already authenticated build host.
  # gh keeps credentials out of command arguments and build logs.
  if command -v gh >/dev/null 2>&1; then
    RELEASE_JSON="$(gh api "repos/TriliumNext/Trilium/releases/tags/${UPSTREAM_VERSION}")"
  else
    echo "Cannot read upstream release metadata; retry later or authenticate GitHub CLI." >&2
    exit 1
  fi
fi

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

  python3 - "${build_dir}/trilium-fnos" "$fnos_platform" "$release_arch" "$PACKAGE_VERSION" "$PACKAGE_DIAGNOSTICS" "$PACKAGE_ENTRY_TYPE" "$PACKAGE_IOS_ENTRY" "$PACKAGE_ASSET_NAMESPACE" <<'PY'
from pathlib import Path
import json
import sys

package_dir = Path(sys.argv[1])
platform, release_arch, version, diagnostic, entry_type, ios_entry, asset_namespace = sys.argv[2:]
manifest = package_dir.joinpath("manifest").read_text()
lines = []
for line in manifest.splitlines():
    if line.startswith("platform="):
        line = f"platform={platform}"
    elif line.startswith("version="):
        line = f"version={version}"
    elif asset_namespace == "1" and line.startswith("desc="):
        line = "desc=原生 Trilium Notes 0.106.0；修复手机网关静态资源缓存与启停识别，保留原笔记及电脑同步，待 FNID 实机验收。"
    elif asset_namespace == "1" and line.startswith("changelog="):
        line = f"changelog={version}：完整静态资源树切换至版本化新目录；修复生命周期别名识别，保留笔记、登录与同步协议；无 Docker、无在线更新器。"
    elif ios_entry == "deferred" and line.startswith("desc="):
        line = "desc=iPhone 飞牛 App 模块启动兼容候选包；原生 Trilium 0.106.0，真实入口延后启动，待 FN Connect 实机验证。"
    elif ios_entry == "deferred" and line.startswith("changelog="):
        line = f"changelog={version}：恢复新页面入口；iPhone App 网关移除初始模块预加载并单次延后启动官方入口，补齐早期诊断，不修改笔记或同步协议。"
    elif diagnostic == "1" and entry_type == "iframe" and line.startswith("desc="):
        line = "desc=FNID 旧入口对照诊断包；保留 Trilium 0.106.0，恢复飞牛内嵌窗口打开方式，待手机验证。"
    elif diagnostic == "1" and entry_type == "iframe" and line.startswith("changelog="):
        line = f"changelog={version}：在 r4 诊断包基础上仅将入口 url 改为 iframe；本体与代理不变，验证旧版手机 FNID 入口兼容性。"
    elif diagnostic == "1" and line.startswith("desc="):
        line = "desc=一次性手机远程加载诊断包，非修复版；原生 Trilium 0.106.0，自动记录安全启动事件，不修改笔记数据。"
    elif diagnostic == "1" and line.startswith("changelog="):
        line = f"changelog={version}：一次性 FN Connect 客户端诊断；约20秒自动采集，不清缓存、不改nginx、不恢复更新器。"
    lines.append(line)
package_dir.joinpath("manifest").write_text("\n".join(lines) + "\n")
entry_file = package_dir.joinpath("app/ui/config")
entry_config = json.loads(entry_file.read_text())
entry_config[".url"]["trilium-fnos.main"]["type"] = entry_type
entry_file.write_text(json.dumps(entry_config, ensure_ascii=False, indent=2) + "\n")
marker = package_dir.joinpath("app/proxy/diagnostic-mode.json")
if diagnostic == "1":
    marker.write_text('{"enabled":true}\n')
elif marker.exists():
    marker.unlink()
entry_marker = package_dir.joinpath("app/proxy/ios-entry-mode.json")
if ios_entry == "deferred":
    entry_marker.write_text('{"mode":"deferred"}\n')
elif entry_marker.exists():
    entry_marker.unlink()
namespace_marker = package_dir.joinpath("app/proxy/asset-namespace-mode.json")
if asset_namespace == "1":
    namespace_marker.write_text('{"enabled":true}\n')
elif namespace_marker.exists():
    namespace_marker.unlink()
audit_marker = package_dir.joinpath("app/proxy/module-audit-mode.json")
if audit_marker.exists():
    audit_marker.unlink()
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
  python3 "${ROOT_DIR}/scripts/verify-fpk.py" \
    "${DIST_DIR}/trilium-fnos-${OUTPUT_VERSION}-${output_arch}.fpk" --upstream "$archive_path" --entry-type "$PACKAGE_ENTRY_TYPE" --ios-entry "$PACKAGE_IOS_ENTRY" --asset-namespace "$PACKAGE_ASSET_NAMESPACE" --diagnostics "$PACKAGE_DIAGNOSTICS"
  rm -rf "$build_dir"
  echo "Built ${DIST_DIR}/trilium-fnos-${OUTPUT_VERSION}-${output_arch}.fpk"
}

build_one x86 linux-x64 x86_64
build_one arm linux-arm64 arm64

# Generate checksums only after both final packages have passed verification.
node - "$DIST_DIR" "$OUTPUT_VERSION" <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const [dist, version] = process.argv.slice(2);
const lines = ["x86_64", "arm64"].map(arch => {
  const name = `trilium-fnos-${version}-${arch}.fpk`;
  return `${crypto.createHash("sha256").update(fs.readFileSync(path.join(dist, name))).digest("hex")}  ${name}`;
});
fs.writeFileSync(path.join(dist, "SHA256SUMS"), `${lines.join("\n")}\n`);
JS
