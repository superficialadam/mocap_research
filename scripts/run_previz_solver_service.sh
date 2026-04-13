#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${ROOT_DIR}/.venv"

# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

export PYTHONPATH="${ROOT_DIR}:${PYTHONPATH:-}"
export PYTHONUNBUFFERED=1
export PREVIZ_SOLVER_HOST="${PREVIZ_SOLVER_HOST:-127.0.0.1}"
export PREVIZ_SOLVER_PORT="${PREVIZ_SOLVER_PORT:-8765}"

exec python -m previz_solver.app
