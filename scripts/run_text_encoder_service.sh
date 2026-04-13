#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${ROOT_DIR}/.venv"

"${ROOT_DIR}/scripts/apply_local_patches.sh" >/dev/null

# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

cd "${ROOT_DIR}/vendor/kimodo"

export GRADIO_SERVER_NAME="${GRADIO_SERVER_NAME:-0.0.0.0}"
export GRADIO_SERVER_PORT="${GRADIO_SERVER_PORT:-9550}"
export HF_HOME="${HF_HOME:-${HOME}/.cache/huggingface}"
export PYTHONUNBUFFERED=1
export PYTHONPATH="${ROOT_DIR}:${PYTHONPATH:-}"

exec python -m kimodo.scripts.run_text_encoder_server
