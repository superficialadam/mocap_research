#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIMODO_DIR="${ROOT_DIR}/vendor/kimodo"
PATCH_DIR="${ROOT_DIR}/patches"

if [[ ! -d "${KIMODO_DIR}/.git" ]]; then
  echo "Missing Kimodo checkout at ${KIMODO_DIR}" >&2
  exit 1
fi

if [[ ! -d "${PATCH_DIR}" ]]; then
  exit 0
fi

shopt -s nullglob
patches=("${PATCH_DIR}"/*.patch)
shopt -u nullglob

if [[ ${#patches[@]} -eq 0 ]]; then
  exit 0
fi

for patch_path in "${patches[@]}"; do
  patch_name="$(basename "${patch_path}")"
  if git -C "${KIMODO_DIR}" apply --check "${patch_path}" >/dev/null 2>&1; then
    git -C "${KIMODO_DIR}" apply "${patch_path}"
    echo "Applied ${patch_name}"
    continue
  fi

  if git -C "${KIMODO_DIR}" apply -R --check "${patch_path}" >/dev/null 2>&1; then
    echo "Already applied ${patch_name}"
    continue
  fi

  echo "Patch ${patch_name} does not apply cleanly to ${KIMODO_DIR}" >&2
  exit 1
done
