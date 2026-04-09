#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="${ROOT_DIR}/tools/oauth2-proxy"
VERSION="${OAUTH2_PROXY_VERSION:-7.15.1}"
OS="$(uname -s)"
ARCH="$(uname -m)"

if [[ "${OS}" != "Linux" ]]; then
  echo "This installer currently supports Linux only." >&2
  exit 1
fi

case "${ARCH}" in
  x86_64|amd64)
    ARCH="amd64"
    ;;
  aarch64|arm64)
    ARCH="arm64"
    ;;
  *)
    echo "Unsupported architecture: ${ARCH}" >&2
    exit 1
    ;;
esac

mkdir -p "${TOOLS_DIR}"

ARCHIVE="oauth2-proxy-v${VERSION}.linux-${ARCH}.tar.gz"
CHECKSUM_FILE="${ARCHIVE}-sha256sum.txt"
BASE_URL="https://github.com/oauth2-proxy/oauth2-proxy/releases/download/v${VERSION}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

curl -fsSL "${BASE_URL}/${ARCHIVE}" -o "${TMP_DIR}/${ARCHIVE}"
curl -fsSL "${BASE_URL}/${CHECKSUM_FILE}" -o "${TMP_DIR}/${CHECKSUM_FILE}"

(
  cd "${TMP_DIR}"
  sha256sum -c "${CHECKSUM_FILE}" --ignore-missing
)

tar -xzf "${TMP_DIR}/${ARCHIVE}" -C "${TMP_DIR}"
SRC_DIR="${TMP_DIR}/oauth2-proxy-v${VERSION}.linux-${ARCH}"
DEST_DIR="${TOOLS_DIR}/${VERSION}"

rm -rf "${DEST_DIR}"
mkdir -p "${DEST_DIR}"
install -m 0755 "${SRC_DIR}/oauth2-proxy" "${DEST_DIR}/oauth2-proxy"
ln -sfn "${DEST_DIR}" "${TOOLS_DIR}/current"

cat <<EOF
Installed oauth2-proxy ${VERSION} at:
  ${DEST_DIR}/oauth2-proxy

Current symlink:
  ${TOOLS_DIR}/current/oauth2-proxy
EOF
