#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOLVER_DIR="${ROOT_DIR}/previz_solver_js"

export PYTHONPATH="${ROOT_DIR}:${PYTHONPATH:-}"
export PYTHONUNBUFFERED=1
export PREVIZ_SOLVER_HOST="${PREVIZ_SOLVER_HOST:-127.0.0.1}"
export PREVIZ_SOLVER_PORT="${PREVIZ_SOLVER_PORT:-8765}"
export PATH="${ROOT_DIR}/tools/node/current/bin:${PATH}"

if ! command -v npm >/dev/null 2>&1; then
  "${ROOT_DIR}/scripts/install_node_runtime.sh"
  export PATH="${ROOT_DIR}/tools/node/current/bin:${PATH}"
fi

if [[ ! -d "${SOLVER_DIR}/node_modules" ]]; then
  npm --prefix "${SOLVER_DIR}" install --omit=dev
fi

exec npm --prefix "${SOLVER_DIR}" run start
