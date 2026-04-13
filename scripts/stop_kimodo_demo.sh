#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${ROOT_DIR}/run"

stop_pid_tree() {
  local pid="$1"
  local children

  children="$(pgrep -P "${pid}" || true)"
  for child in ${children}; do
    stop_pid_tree "${child}"
  done

  if kill -0 "${pid}" 2>/dev/null; then
    kill "${pid}" 2>/dev/null || true
  fi
}

for name in demo text-encoder previz-solver; do
  pid_file="${RUN_DIR}/${name}.pid"
  if [[ ! -f "${pid_file}" ]]; then
    echo "${name}: not running"
    continue
  fi

  pid="$(cat "${pid_file}")"
  if kill -0 "${pid}" 2>/dev/null; then
    stop_pid_tree "${pid}"
    echo "${name}: stopped ${pid}"
  else
    echo "${name}: stale pid ${pid}"
  fi
  rm -f "${pid_file}"
done
