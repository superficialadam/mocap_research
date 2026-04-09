#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${ROOT_DIR}/run"
PID_FILE="${RUN_DIR}/oauth2-proxy.pid"

if [[ -f "${PID_FILE}" ]]; then
  pid="$(cat "${PID_FILE}")"
  if kill -0 "${pid}" 2>/dev/null; then
    kill "${pid}"
    echo "Stopped oauth2-proxy (${pid})"
  else
    echo "oauth2-proxy PID file was stale (${pid})"
  fi
  rm -f "${PID_FILE}"
else
  echo "oauth2-proxy: not running"
fi

tailscale funnel reset >/dev/null 2>&1 || true
echo "Funnel reset"
