#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${ROOT_DIR}/.venv"
KIMODO_DIR="${ROOT_DIR}/vendor/kimodo"
LOG_DIR="${ROOT_DIR}/logs"
RUN_DIR="${ROOT_DIR}/run"
TOKEN_FILE="${HOME}/.cache/huggingface/token"
TEXT_PID_FILE="${RUN_DIR}/text-encoder.pid"
DEMO_PID_FILE="${RUN_DIR}/demo.pid"
SERVER_PORT="${SERVER_PORT:-7860}"
TEXT_PORT="${TEXT_PORT:-9550}"
TAILSCALE_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"

mkdir -p "${LOG_DIR}" "${RUN_DIR}"

if [[ ! -f "${TOKEN_FILE}" ]]; then
  echo "Missing Hugging Face token at ${TOKEN_FILE}" >&2
  exit 1
fi

if [[ ! -d "${VENV_DIR}" ]]; then
  echo "Missing virtualenv at ${VENV_DIR}. Run ./scripts/bootstrap_remote.sh first." >&2
  exit 1
fi

if [[ ! -d "${KIMODO_DIR}" ]]; then
  echo "Missing Kimodo checkout at ${KIMODO_DIR}. Run ./scripts/bootstrap_remote.sh first." >&2
  exit 1
fi

"${ROOT_DIR}/scripts/apply_local_patches.sh" >/dev/null

# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

start_if_not_running() {
  local pid_file="$1"
  shift

  if [[ -f "${pid_file}" ]]; then
    local pid
    pid="$(cat "${pid_file}")"
    if kill -0 "${pid}" 2>/dev/null; then
      echo "Process already running with PID ${pid}: ${pid_file}"
      return 0
    fi
    rm -f "${pid_file}"
  fi

  nohup "$@" >/dev/null 2>&1 &
  echo $! >"${pid_file}"
}

cd "${KIMODO_DIR}"

start_if_not_running \
  "${TEXT_PID_FILE}" \
  env \
    GRADIO_SERVER_NAME=0.0.0.0 \
    GRADIO_SERVER_PORT="${TEXT_PORT}" \
    HF_HOME="${HOME}/.cache/huggingface" \
    PYTHONUNBUFFERED=1 \
    bash -lc "source '${VENV_DIR}/bin/activate' && python -m kimodo.scripts.run_text_encoder_server >>'${LOG_DIR}/text-encoder.log' 2>&1"

sleep 10

start_if_not_running \
  "${DEMO_PID_FILE}" \
  env \
    SERVER_NAME=0.0.0.0 \
    SERVER_PORT="${SERVER_PORT}" \
    TEXT_ENCODER_URL="http://127.0.0.1:${TEXT_PORT}/" \
    HF_HOME="${HOME}/.cache/huggingface" \
    PYTHONUNBUFFERED=1 \
    bash -lc "source '${VENV_DIR}/bin/activate' && python -m kimodo.demo >>'${LOG_DIR}/demo.log' 2>&1"

cat <<EOF
Kimodo launch requested.

Tailnet URL:
  ${TAILSCALE_IP:+http://${TAILSCALE_IP}:${SERVER_PORT}}
  ${TAILSCALE_IP:-tailscale ip unavailable}

Local logs:
  ${LOG_DIR}/text-encoder.log
  ${LOG_DIR}/demo.log
EOF
