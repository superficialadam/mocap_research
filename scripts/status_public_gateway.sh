#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${ROOT_DIR}/run"
PID_FILE="${RUN_DIR}/oauth2-proxy.pid"

if [[ -f "${PID_FILE}" ]]; then
  pid="$(cat "${PID_FILE}")"
  if kill -0 "${pid}" 2>/dev/null; then
    echo "oauth2-proxy: running (pid ${pid})"
  else
    echo "oauth2-proxy: stale pid file (${pid})"
  fi
else
  echo "oauth2-proxy: not running"
fi

echo
echo "Local listener:"
if command -v ss >/dev/null 2>&1; then
  ss -ltnp '( sport = :4180 )' || true
fi

echo
echo "Funnel:"
tailscale funnel status || true
