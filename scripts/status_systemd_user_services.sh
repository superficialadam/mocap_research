#!/usr/bin/env bash
set -euo pipefail

systemctl --user --no-pager --full status \
  kimodo-text-encoder.service \
  kimodo-demo.service \
  oauth2-proxy.service
