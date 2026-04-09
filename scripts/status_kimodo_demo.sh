#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${ROOT_DIR}/run"
SERVER_PORT="${SERVER_PORT:-7860}"
TEXT_PORT="${TEXT_PORT:-9550}"

for name in text-encoder demo; do
  pid_file="${RUN_DIR}/${name}.pid"
  if [[ -f "${pid_file}" ]]; then
    pid="$(cat "${pid_file}")"
    if kill -0 "${pid}" 2>/dev/null; then
      echo "${name}: running (pid ${pid})"
    else
      echo "${name}: stale pid file (${pid})"
    fi
  else
    echo "${name}: not running"
  fi
done

echo "ports:"
if command -v ss >/dev/null 2>&1; then
  ss -ltnp "( sport = :${SERVER_PORT} or sport = :${TEXT_PORT} )" || true
fi

