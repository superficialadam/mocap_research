#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${ROOT_DIR}/config/oauth2-proxy.env"
LOG_DIR="${ROOT_DIR}/logs"
RUN_DIR="${ROOT_DIR}/run"
PID_FILE="${RUN_DIR}/oauth2-proxy.pid"
LOG_FILE="${LOG_DIR}/oauth2-proxy.log"
OAUTH2_PROXY_BIN="${ROOT_DIR}/tools/oauth2-proxy/current/oauth2-proxy"

mkdir -p "${LOG_DIR}" "${RUN_DIR}"

if [[ ! -x "${OAUTH2_PROXY_BIN}" ]]; then
  echo "Missing oauth2-proxy binary at ${OAUTH2_PROXY_BIN}. Run ./scripts/install_oauth2_proxy.sh first." >&2
  exit 1
fi

if [[ ! -f "${CONFIG_FILE}" ]]; then
  echo "Missing config file at ${CONFIG_FILE}." >&2
  echo "Copy config/oauth2-proxy.env.example to config/oauth2-proxy.env and fill in the Google OAuth values." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${CONFIG_FILE}"
set +a

: "${OAUTH2_PROXY_CLIENT_ID:?Missing OAUTH2_PROXY_CLIENT_ID in ${CONFIG_FILE}}"
: "${OAUTH2_PROXY_CLIENT_SECRET:?Missing OAUTH2_PROXY_CLIENT_SECRET in ${CONFIG_FILE}}"
: "${OAUTH2_PROXY_COOKIE_SECRET:?Missing OAUTH2_PROXY_COOKIE_SECRET in ${CONFIG_FILE}}"

PUBLIC_HOST="${PUBLIC_HOST:-$(tailscale status --self --json | jq -r '.Self.DNSName' | sed 's/\\.$//')}"
OAUTH2_PROXY_EMAIL_DOMAIN="${OAUTH2_PROXY_EMAIL_DOMAIN:-blendalabs.com}"
OAUTH2_PROXY_HTTP_ADDRESS="${OAUTH2_PROXY_HTTP_ADDRESS:-127.0.0.1:4180}"
KIMODO_UPSTREAM_URL="${KIMODO_UPSTREAM_URL:-http://127.0.0.1:7860}"
REDIRECT_URL="https://${PUBLIC_HOST}/oauth2/callback"

if [[ -f "${PID_FILE}" ]]; then
  old_pid="$(cat "${PID_FILE}")"
  if kill -0 "${old_pid}" 2>/dev/null; then
    echo "oauth2-proxy is already running with PID ${old_pid}."
    echo "If you changed config, run ./scripts/stop_public_gateway.sh first." >&2
    exit 0
  fi
  rm -f "${PID_FILE}"
fi

nohup "${OAUTH2_PROXY_BIN}" \
  --provider=google \
  --http-address="${OAUTH2_PROXY_HTTP_ADDRESS}" \
  --reverse-proxy=true \
  --upstream="${KIMODO_UPSTREAM_URL}" \
  --redirect-url="${REDIRECT_URL}" \
  --client-id="${OAUTH2_PROXY_CLIENT_ID}" \
  --client-secret="${OAUTH2_PROXY_CLIENT_SECRET}" \
  --cookie-secret="${OAUTH2_PROXY_COOKIE_SECRET}" \
  --cookie-secure=true \
  --cookie-refresh=1h \
  --cookie-expire=8h \
  --email-domain="${OAUTH2_PROXY_EMAIL_DOMAIN}" \
  --scope="openid email profile" \
  --skip-provider-button=true \
  --whitelist-domain="${PUBLIC_HOST}" \
  --silence-ping-logging=true \
  >>"${LOG_FILE}" 2>&1 &

echo $! >"${PID_FILE}"
sleep 2

if ! kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
  echo "oauth2-proxy failed to start. See ${LOG_FILE}" >&2
  exit 1
fi

tailscale funnel --bg --yes "${OAUTH2_PROXY_HTTP_ADDRESS##*:}" >/dev/null

cat <<EOF
Public gateway started.

Public URL:
  https://${PUBLIC_HOST}

OAuth callback URL:
  ${REDIRECT_URL}

Logs:
  ${LOG_FILE}
EOF
