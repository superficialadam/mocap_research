#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="${ROOT_DIR}/vendor"
KIMODO_DIR="${VENDOR_DIR}/kimodo"
VISER_DIR="${KIMODO_DIR}/kimodo-viser"
VENV_DIR="${ROOT_DIR}/.venv"

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

if ! python3 -m venv "${VENV_DIR}" 2>/dev/null; then
  python3 -m pip install --user --upgrade pip virtualenv
  python3 -m virtualenv "${VENV_DIR}"
fi
# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

python -m pip install --upgrade pip setuptools wheel
python -m pip install --upgrade --index-url https://download.pytorch.org/whl/cu128 torch torchvision torchaudio
python -m pip install -e "${KIMODO_DIR}[all]"

cat <<EOF
Bootstrap complete.

Next steps:
  1. Ensure ~/.cache/huggingface/token exists on this host.
  2. Start the demo with: ./scripts/start_kimodo_demo.sh
EOF
