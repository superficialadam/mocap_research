#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${ROOT_DIR}/run"

for name in demo text-encoder; do
  pid_file="${RUN_DIR}/${name}.pid"
  if [[ ! -f "${pid_file}" ]]; then
    echo "${name}: not running"
    continue
  fi

  pid="$(cat "${pid_file}")"
  if kill -0 "${pid}" 2>/dev/null; then
    kill "${pid}"
    echo "${name}: stopped ${pid}"
  else
    echo "${name}: stale pid ${pid}"
  fi
  rm -f "${pid_file}"
done
