#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${ROOT_DIR}/.venv"
TEXT_PORT="${TEXT_PORT:-9550}"

"${ROOT_DIR}/scripts/apply_local_patches.sh" >/dev/null

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${TEXT_PORT}/" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if ! curl -fsS "http://127.0.0.1:${TEXT_PORT}/" >/dev/null 2>&1; then
  echo "Text encoder did not become ready on port ${TEXT_PORT}" >&2
  exit 1
fi

# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

cd "${ROOT_DIR}/vendor/kimodo"

export SERVER_NAME="${SERVER_NAME:-0.0.0.0}"
export SERVER_PORT="${SERVER_PORT:-7860}"
export TEXT_ENCODER_URL="${TEXT_ENCODER_URL:-http://127.0.0.1:${TEXT_PORT}/}"
export PREVIZ_SOLVER_URL="${PREVIZ_SOLVER_URL:-http://127.0.0.1:8765}"
export PREVIZ_STORE_DIR="${PREVIZ_STORE_DIR:-${ROOT_DIR}/run/previz-shots}"
export HF_HOME="${HF_HOME:-${HOME}/.cache/huggingface}"
export PYTHONUNBUFFERED=1
export PYTHONPATH="${ROOT_DIR}:${PYTHONPATH:-}"

exec python -m kimodo.demo
