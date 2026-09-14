#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_DIR="${1:-${ROOT_DIR}/trilium-fnos}"

python3 -m json.tool "${PACKAGE_DIR}/config/privilege" >/dev/null
python3 -m json.tool "${PACKAGE_DIR}/config/resource" >/dev/null
python3 -m json.tool "${PACKAGE_DIR}/app/ui/config" >/dev/null

for wizard in install upgrade uninstall config; do
  python3 -m json.tool "${PACKAGE_DIR}/wizard/${wizard}" >/dev/null
done

for script in "${PACKAGE_DIR}"/cmd/*; do
  bash -n "$script"
done

node --check "${PACKAGE_DIR}/app/proxy/server.js"
node --check "${PACKAGE_DIR}/app/proxy/public/update.js"
if [ "${SKIP_INTEGRATION:-0}" != "1" ]; then
  node --test "${ROOT_DIR}"/tests/*.test.js
fi

test -s "${PACKAGE_DIR}/manifest"
test -s "${PACKAGE_DIR}/ICON.PNG"
test -s "${PACKAGE_DIR}/ICON_256.PNG"
test -s "${PACKAGE_DIR}/LICENSE"

if [ -d "${PACKAGE_DIR}/app/server" ]; then
  test -x "${PACKAGE_DIR}/app/server/node/bin/node"
  test -s "${PACKAGE_DIR}/app/server/main.cjs"
  test -s "${PACKAGE_DIR}/app/server/VERSION"
  ! rg -q '__RELEASE_ARCH__' "${PACKAGE_DIR}/cmd"
  while IFS= read -r link; do
    target="$(readlink "$link")"
    case "$target" in
      /*)
        echo "Unsafe absolute symlink in app payload: ${link} -> ${target}" >&2
        exit 1
        ;;
    esac
  done < <(find "${PACKAGE_DIR}/app/server" -type l -print)
fi

if rg -qi 'docker-project|join-groups[^\n]*docker|app/docker' \
  "${PACKAGE_DIR}/config" "${PACKAGE_DIR}/cmd" "${PACKAGE_DIR}/app/ui"; then
  echo "Docker dependency detected in native package metadata." >&2
  exit 1
fi

echo "Validation passed: ${PACKAGE_DIR}"
