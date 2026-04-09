#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="${ROOT_DIR}/vendor"
KIMODO_DIR="${VENDOR_DIR}/kimodo"
VISER_DIR="${KIMODO_DIR}/kimodo-viser"
VENV_DIR="${ROOT_DIR}/.venv"
VENV_PYTHON="${VENV_DIR}/bin/python"

mkdir -p "${VENDOR_DIR}" "${ROOT_DIR}/logs" "${ROOT_DIR}/run"

clone_or_update() {
  local repo_url="$1"
  local target_dir="$2"

  if [[ -d "${target_dir}/.git" ]]; then
    git -C "${target_dir}" fetch --depth 1 origin main
    git -C "${target_dir}" reset --hard origin/main
  else
    git clone --depth 1 "${repo_url}" "${target_dir}"
  fi
}

clone_or_update "https://github.com/nv-tlabs/kimodo.git" "${KIMODO_DIR}"
clone_or_update "https://github.com/nv-tlabs/kimodo-viser.git" "${VISER_DIR}"

if [[ -e "${VENV_DIR}" && ! -x "${VENV_PYTHON}" ]]; then
  rm -rf "${VENV_DIR}"
fi

if command -v uv >/dev/null 2>&1; then
  uv venv --python 3.10 "${VENV_DIR}"
  uv pip install --python "${VENV_PYTHON}" --upgrade setuptools wheel
  uv pip install --python "${VENV_PYTHON}" --upgrade --index-url https://download.pytorch.org/whl/cu128 torch torchvision torchaudio
  uv pip install --python "${VENV_PYTHON}" -e "${KIMODO_DIR}[all]"
else
  if ! python3 -m venv "${VENV_DIR}" 2>/dev/null; then
    if python3 -m pip --version >/dev/null 2>&1; then
      python3 -m pip install --user --upgrade pip virtualenv
      python3 -m virtualenv "${VENV_DIR}"
    else
      echo "Need either 'uv' or a Python installation with pip available." >&2
      exit 1
    fi
  fi

  # shellcheck disable=SC1091
  source "${VENV_DIR}/bin/activate"
  python -m pip install --upgrade pip setuptools wheel
  python -m pip install --upgrade --index-url https://download.pytorch.org/whl/cu128 torch torchvision torchaudio
  python -m pip install -e "${KIMODO_DIR}[all]"
fi

cat <<EOF
Bootstrap complete.

Next steps:
  1. Ensure ~/.cache/huggingface/token exists on this host.
  2. Start the demo with: ./scripts/start_kimodo_demo.sh
EOF
