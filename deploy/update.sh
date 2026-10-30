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
chown -R hiby:hiby "$APP_DIR"
chmod +x "$APP_DIR"/deploy/*.sh
# Install timers added after the first setup (safe to repeat).
BUCKET="$(grep -E '^R2_BUCKET=' "$APP_DIR/.env" | tail -1 | cut -d= -f2-)"; BUCKET="${BUCKET:-hiby-library}"
if [ ! -f /etc/systemd/system/hiby-soulseek-pull.timer ]; then
  sed -e "s#@BUCKET@#${BUCKET}#g" "$APP_DIR/deploy/systemd/hiby-soulseek-pull.service" > /etc/systemd/system/hiby-soulseek-pull.service
  cp "$APP_DIR/deploy/systemd/hiby-soulseek-pull.timer" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now hiby-soulseek-pull.timer
  echo "Installed hiby-soulseek-pull.timer (Soulseek downloads -> inbox every 3 min)."
fi
systemctl restart hiby-hub
echo "Updated $BEFORE -> $AFTER and restarted hiby-hub."
