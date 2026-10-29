#!/usr/bin/env bash
# Nightly: consistent copy of the Hub database -> r2:<bucket>/backups/hub-YYYY-MM-DD.db
# Keeps 30 days. Restore: stop hiby-hub, copy a backup over /srv/hiby/data/hub.db
# (delete hub.db-wal and hub.db-shm), start hiby-hub.
set -euo pipefail
BUCKET="${R2_BUCKET:-hiby-library}"
DATA=/srv/hiby/data
CONF=/etc/rclone/hiby.conf
SNAP="$DATA/backup-snapshot.db"
rm -f "$SNAP"
NODE_NO_WARNINGS=1 node /opt/hiby-hub/deploy/backup-db.js "$DATA/hub.db" "$SNAP"
rclone --config "$CONF" copyto "$SNAP" "r2:$BUCKET/backups/hub-$(date +%F).db"
rclone --config "$CONF" delete "r2:$BUCKET/backups" --min-age 30d --include 'hub-*.db'
rm -f "$SNAP"
echo "Backed up hub.db to r2:$BUCKET/backups/hub-$(date +%F).db"
