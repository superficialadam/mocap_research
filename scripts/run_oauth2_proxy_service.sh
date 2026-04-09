#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${ROOT_DIR}/config/oauth2-proxy.env"
OAUTH2_PROXY_BIN="${ROOT_DIR}/tools/oauth2-proxy/current/oauth2-proxy"

if [[ ! -x "${OAUTH2_PROXY_BIN}" ]]; then
  echo "Missing oauth2-proxy binary at ${OAUTH2_PROXY_BIN}" >&2
  exit 1
fi

if [[ ! -f "${CONFIG_FILE}" ]]; then
  echo "Missing config file at ${CONFIG_FILE}" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${CONFIG_FILE}"
set +a

: "${OAUTH2_PROXY_CLIENT_ID:?Missing OAUTH2_PROXY_CLIENT_ID in ${CONFIG_FILE}}"
: "${OAUTH2_PROXY_CLIENT_SECRET:?Missing OAUTH2_PROXY_CLIENT_SECRET in ${CONFIG_FILE}}"
: "${OAUTH2_PROXY_COOKIE_SECRET:?Missing OAUTH2_PROXY_COOKIE_SECRET in ${CONFIG_FILE}}"

if [[ "${OAUTH2_PROXY_CLIENT_ID}" == fill-me* || "${OAUTH2_PROXY_CLIENT_SECRET}" == "fill-me" ]]; then
  echo "Google OAuth values in ${CONFIG_FILE} are still placeholders." >&2
  exit 1
fi

PUBLIC_HOST="${PUBLIC_HOST:-$(tailscale status --self --json | jq -r '.Self.DNSName' | sed 's/\.$//')}"
OAUTH2_PROXY_EMAIL_DOMAIN="${OAUTH2_PROXY_EMAIL_DOMAIN:-blendalabs.com}"
OAUTH2_PROXY_HTTP_ADDRESS="${OAUTH2_PROXY_HTTP_ADDRESS:-127.0.0.1:4180}"
KIMODO_UPSTREAM_URL="${KIMODO_UPSTREAM_URL:-http://127.0.0.1:7860}"
REDIRECT_URL="https://${PUBLIC_HOST}/oauth2/callback"

for _ in $(seq 1 60); do
  if curl -fsS "${KIMODO_UPSTREAM_URL}" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! curl -fsS "${KIMODO_UPSTREAM_URL}" >/dev/null 2>&1; then
  echo "Kimodo demo did not become ready at ${KIMODO_UPSTREAM_URL}" >&2
  exit 1
fi

exec "${OAUTH2_PROXY_BIN}" \
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
  --silence-ping-logging=true
