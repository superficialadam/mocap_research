#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC_DIR="${ROOT_DIR}/systemd"
UNIT_DST_DIR="${HOME}/.config/systemd/user"

mkdir -p "${UNIT_DST_DIR}"

install -m 0644 "${UNIT_SRC_DIR}/kimodo-text-encoder.service" "${UNIT_DST_DIR}/kimodo-text-encoder.service"
install -m 0644 "${UNIT_SRC_DIR}/kimodo-demo.service" "${UNIT_DST_DIR}/kimodo-demo.service"
install -m 0644 "${UNIT_SRC_DIR}/kimodo-previz-solver.service" "${UNIT_DST_DIR}/kimodo-previz-solver.service"
install -m 0644 "${UNIT_SRC_DIR}/oauth2-proxy.service" "${UNIT_DST_DIR}/oauth2-proxy.service"

systemctl --user daemon-reload
systemctl --user enable kimodo-text-encoder.service kimodo-demo.service kimodo-previz-solver.service oauth2-proxy.service

cat <<EOF
Installed user services:
  kimodo-text-encoder.service
  kimodo-demo.service
  kimodo-previz-solver.service
  oauth2-proxy.service

To start them now:
  systemctl --user restart kimodo-previz-solver.service kimodo-text-encoder.service kimodo-demo.service oauth2-proxy.service

To survive reboot without interactive login, enable lingering once:
  sudo loginctl enable-linger ${USER}
EOF
