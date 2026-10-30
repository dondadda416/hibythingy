#!/usr/bin/env bash
# Pull new Soulseek downloads into the Hub inbox.
#
# The simpc mirrors "Soulseek Downloads\complete" to r2:<bucket>/soulseek
# (scripts/soulseek-push.ps1). This copies any file there that hasn't been
# pulled before into /srv/hiby/inbox, keeping the folder layout, and records it
# in a ledger so albums you have filed or deleted from the inbox never come back.
# Runs as hiby from hiby-soulseek-pull.timer.
set -euo pipefail
BUCKET="${R2_BUCKET:-hiby-library}"
SRC="r2:$BUCKET/soulseek"
INBOX="${HUB_INBOX_PATH:-/srv/hiby/inbox}"
DATA=/srv/hiby/data
CONF=/etc/rclone/hiby.conf
LEDGER="$DATA/soulseek-pulled.txt"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
touch "$LEDGER"

# Every file in the mirror (an object only exists once it has fully uploaded).
if ! rclone --config "$CONF" lsf -R --files-only "$SRC" > "$TMP/all" 2> "$TMP/err"; then
  grep -qi "directory not found" "$TMP/err" && exit 0
  cat "$TMP/err" >&2; exit 1
fi
# Skip partial-download markers, then anything already pulled.
grep -viE '\.(incomplete|part|partial|crdownload|dwnl|tmp)$' "$TMP/all" | sort -u > "$TMP/files" || true
sort -u "$LEDGER" > "$TMP/seen"
comm -23 "$TMP/files" "$TMP/seen" > "$TMP/new"
N=$(wc -l < "$TMP/new")
[ "$N" -eq 0 ] && exit 0

rclone --config "$CONF" copy "$SRC" "$INBOX" --files-from-raw "$TMP/new" --no-traverse --transfers 4
cat "$TMP/new" >> "$LEDGER"
echo "Pulled $N new file(s) from $SRC into $INBOX"
