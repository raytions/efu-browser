#!/bin/sh
set -eu

SCANS_MODE_VAL="${SCANS_MODE:-demo}"
SCANS_API_BASE_VAL="${SCANS_API_BASE:-/api/scans}"
SCANS_API_UPSTREAM_VAL="${SCANS_API_UPSTREAM:-http://efu-scanner:3001}"

case "$(printf '%s' "$SCANS_MODE_VAL" | tr '[:upper:]' '[:lower:]')" in
  real)
    SCANS_MODE_NORM="real"
    ;;
  *)
    SCANS_MODE_NORM="demo"
    ;;
esac

if [ -f /config/config.json ]; then
  BASE_CONFIG="/config/config.json"
else
  BASE_CONFIG="/usr/share/nginx/html/config.json"
fi

jq \
  --arg mode "$SCANS_MODE_NORM" \
  --arg apiBase "$SCANS_API_BASE_VAL" \
  '.scans = (if $mode == "real" then ((.scans // {}) + {mode: "real", apiBase: $apiBase}) else ((.scans // {}) + {mode: "demo"}) end)' \
  "$BASE_CONFIG" > /tmp/efu-runtime-config.json

mkdir -p /etc/nginx/snippets
if [ "$SCANS_MODE_NORM" = "real" ]; then
  cat > /etc/nginx/snippets/scans-api.conf <<EOF
location ^~ ${SCANS_API_BASE_VAL} {
    proxy_pass ${SCANS_API_UPSTREAM_VAL};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_buffering off;
    add_header Cache-Control "no-store";
}
EOF
else
  cat > /etc/nginx/snippets/scans-api.conf <<EOF
location ^~ ${SCANS_API_BASE_VAL} {
    return 404;
}
EOF
fi
