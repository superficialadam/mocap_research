#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="${ROOT_DIR}/tools/node"
INSTALL_ROOT="${TOOLS_DIR}/versions"
CURRENT_LINK="${TOOLS_DIR}/current"
NODE_MAJOR_VERSION="${NODE_MAJOR_VERSION:-22}"

if [[ -x "${CURRENT_LINK}/bin/node" && -x "${CURRENT_LINK}/bin/npm" ]]; then
  echo "Node runtime already installed at ${CURRENT_LINK}"
  exit 0
fi

case "$(uname -m)" in
  x86_64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *)
    echo "Unsupported architecture for bundled Node runtime: $(uname -m)" >&2
    exit 1
    ;;
esac

BASE_URL="https://nodejs.org/dist/latest-v${NODE_MAJOR_VERSION}.x"
SHASUMS="$(curl -fsSL "${BASE_URL}/SHASUMS256.txt")"
TARBALL="$(printf '%s\n' "${SHASUMS}" | awk "/linux-${NODE_ARCH}\\.tar\\.xz$/ { print \$2; exit }")"

if [[ -z "${TARBALL}" ]]; then
  echo "Could not determine Node tarball for architecture ${NODE_ARCH}" >&2
  exit 1
fi

mkdir -p "${INSTALL_ROOT}"
TMP_TARBALL="$(mktemp "/tmp/${TARBALL}.XXXXXX")"
trap 'rm -f "${TMP_TARBALL}"' EXIT

curl -fsSL "${BASE_URL}/${TARBALL}" -o "${TMP_TARBALL}"
tar -xJf "${TMP_TARBALL}" -C "${INSTALL_ROOT}"

VERSION_DIR="${INSTALL_ROOT}/${TARBALL%.tar.xz}"
ln -sfn "${VERSION_DIR}" "${CURRENT_LINK}"

echo "Installed Node runtime at ${CURRENT_LINK}"
