#!/usr/bin/env bash
# Pull the latest Hub code and restart. Run with sudo.
set -euo pipefail
APP_DIR=/opt/hiby-hub
BRANCH="$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD)"
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
git -C "$APP_DIR" fetch -q origin "$BRANCH"
BEFORE="$(git -C "$APP_DIR" rev-parse --short HEAD)"
git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
AFTER="$(git -C "$APP_DIR" rev-parse --short HEAD)"
( cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error )
chmod +x "$APP_DIR"/deploy/*.sh
systemctl restart hiby-hub
echo "Updated $BEFORE -> $AFTER and restarted hiby-hub."
