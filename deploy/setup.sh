#!/usr/bin/env bash
# ── HiBy Hub — one-shot server setup ────────────────────────────────────────
# Run on a fresh Ubuntu 24.04 server as root:
#
#   curl -fsSL https://raw.githubusercontent.com/dondadda416/hibythingy/cloud/deploy/setup.sh | sudo bash
#
# It asks for the R2 keys and the Cloudflare Tunnel token, then installs and
# starts everything:
#   hiby-library.service   rclone mount of r2:<bucket>/library at /srv/hiby/library
#   hiby-hub.service       the Hub (Node) on 127.0.0.1:3847
#   cloudflared            the tunnel that serves hiby.<your domain>
#   hiby-backup.timer      nightly database backup to r2:<bucket>/backups
#
# Safe to re-run: existing settings in /opt/hiby-hub/.env are kept.
# Any prompt can be pre-answered with an environment variable of the same name
# (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
# TUNNEL_TOKEN, HUB_HOSTNAME).
set -euo pipefail

REPO_URL="${HUB_REPO_URL:-https://github.com/dondadda416/hibythingy.git}"
REPO_BRANCH="${HUB_REPO_BRANCH:-cloud}"
APP_DIR=/opt/hiby-hub
SRV=/srv/hiby
RCLONE_CONF=/etc/rclone/hiby.conf
SVC_USER=hiby

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mxx  %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this as root (sudo bash)."
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || warn "Built for Ubuntu 24.04; this is ${PRETTY_NAME:-unknown}. Carrying on."

# Prompts read from the terminal even when the script itself is piped in.
ask() {   # ask VAR "Question" [default] [secret]
  local var="$1" q="$2" def="${3:-}" secret="${4:-}" val="${!1:-}"
  if [ -n "$val" ]; then return; fi
  if [ ! -r /dev/tty ]; then
    [ -n "$def" ] && { printf -v "$var" '%s' "$def"; return; }
    die "$var is required (no terminal to ask on)."
  fi
  local prompt="$q"; [ -n "$def" ] && prompt="$q [$def]"
  while [ -z "$val" ]; do
    if [ -n "$secret" ]; then read -r -s -p "$prompt: " val < /dev/tty; echo > /dev/tty
    else read -r -p "$prompt: " val < /dev/tty; fi
    val="${val:-$def}"
  done
  printf -v "$var" '%s' "$val"
}

env_get() { [ -f "$APP_DIR/.env" ] && grep -E "^$1=" "$APP_DIR/.env" | tail -1 | cut -d= -f2- || true; }

# Reuse answers from a previous run.
R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-$(env_get R2_ACCOUNT_ID)}"
R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-$(env_get R2_ACCESS_KEY_ID)}"
R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-$(env_get R2_SECRET_ACCESS_KEY)}"
R2_BUCKET="${R2_BUCKET:-$(env_get R2_BUCKET)}"
HUB_HOSTNAME="${HUB_HOSTNAME:-$(env_get ALLOWED_ORIGINS | sed -E 's#^https?://##; s#,.*##')}"

say "A few questions (paste values; secrets are hidden)"
ask R2_ACCOUNT_ID        "Cloudflare account ID"
ask R2_ACCESS_KEY_ID     "R2 Access Key ID"
ask R2_SECRET_ACCESS_KEY "R2 Secret Access Key" "" secret
ask R2_BUCKET            "R2 bucket" "hiby-library"
ask HUB_HOSTNAME         "Hub web address (no https://)" "hiby.jp-copeland.com"
if ! systemctl is-active --quiet cloudflared 2>/dev/null; then
  ask TUNNEL_TOKEN       "Cloudflare Tunnel token (from Zero Trust > Networks > Tunnels)" "" secret
fi

# ── Packages ────────────────────────────────────────────────────────────────
say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git fuse3 unzip openssl ufw >/dev/null
apt-get install -y -qq rsgain >/dev/null 2>&1 || warn "rsgain not available — ReplayGain tagging will be off."

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

if ! command -v rclone >/dev/null; then
  say "Installing rclone"
  curl -fsSL https://rclone.org/install.sh | bash >/dev/null
fi

if ! command -v cloudflared >/dev/null; then
  say "Installing cloudflared"
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq && apt-get install -y -qq cloudflared >/dev/null
fi

# ── User + folders ──────────────────────────────────────────────────────────
say "Creating the hiby user and folders"
id "$SVC_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/hiby --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$SRV"/{inbox,library,data,vfs-cache}
chown -R "$SVC_USER:$SVC_USER" "$SRV"

# ── rclone remote ───────────────────────────────────────────────────────────
say "Configuring R2 access"
mkdir -p "$(dirname "$RCLONE_CONF")"
cat > "$RCLONE_CONF" <<EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = ${R2_ACCESS_KEY_ID}
secret_access_key = ${R2_SECRET_ACCESS_KEY}
endpoint = https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com
acl = private
no_check_bucket = true
EOF
chown root:"$SVC_USER" "$RCLONE_CONF"
chmod 640 "$RCLONE_CONF"
if ! sudo -u "$SVC_USER" rclone --config "$RCLONE_CONF" lsf "r2:${R2_BUCKET}" --max-depth 1 >/dev/null 2>&1; then
  die "Couldn't read r2:${R2_BUCKET} with those keys. Check the Account ID, key ID and secret, then re-run."
fi
echo "    R2 bucket reachable."

# ── App code ────────────────────────────────────────────────────────────────
say "Fetching HiBy Hub ($REPO_BRANCH)"
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q origin "$REPO_BRANCH"
  git -C "$APP_DIR" checkout -q "$REPO_BRANCH"
  git -C "$APP_DIR" reset -q --hard "origin/$REPO_BRANCH"
else
  git clone -q -b "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
fi
( cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error )

# ── .env ────────────────────────────────────────────────────────────────────
say "Writing settings"
ENV_FILE="$APP_DIR/.env"
touch "$ENV_FILE"
set_env() {  # set_env KEY VALUE [only-if-missing]
  local k="$1" v="$2" keep="${3:-}"
  if grep -qE "^$k=" "$ENV_FILE"; then
    [ -n "$keep" ] && return
    local tmp; tmp="$(mktemp)"
    awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k {print k"="v; next} {print}' "$ENV_FILE" > "$tmp"
    cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
  else
    printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"
  fi
}
set_env HUB_INBOX_PATH   "$SRV/inbox"
set_env HUB_LIBRARY_PATH "$SRV/library"
set_env HUB_DATA_DIR     "$SRV/data"
set_env HUB_HOST         127.0.0.1
set_env PORT             3847
set_env HUB_TRUST_PROXY  true
set_env ALLOWED_ORIGINS  "https://${HUB_HOSTNAME}"
set_env R2_ACCOUNT_ID        "$R2_ACCOUNT_ID"
set_env R2_ACCESS_KEY_ID     "$R2_ACCESS_KEY_ID"
set_env R2_SECRET_ACCESS_KEY "$R2_SECRET_ACCESS_KEY"
set_env R2_BUCKET            "$R2_BUCKET"
set_env R2_LIBRARY_PREFIX    library
set_env WHEELHOUSE_TOKEN "$(openssl rand -hex 24)" keep
chown "$SVC_USER:$SVC_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ── Bring over the database from the old PC, once ───────────────────────────
if [ ! -f "$SRV/data/hub.db" ]; then
  if sudo -u "$SVC_USER" rclone --config "$RCLONE_CONF" lsf "r2:${R2_BUCKET}/migrate/" 2>/dev/null | grep -qx 'hub.db'; then
    say "Importing hub.db from r2:${R2_BUCKET}/migrate/"
    for f in hub.db hub.db-wal; do
      sudo -u "$SVC_USER" rclone --config "$RCLONE_CONF" copyto "r2:${R2_BUCKET}/migrate/$f" "$SRV/data/$f" 2>/dev/null || true
    done
    echo "    Favourites, push log, playlists and history carried over."
  fi
fi

# ── systemd ─────────────────────────────────────────────────────────────────
say "Installing services"
sed -e "s#@BUCKET@#${R2_BUCKET}#g" "$APP_DIR/deploy/systemd/hiby-library.service" > /etc/systemd/system/hiby-library.service
cp "$APP_DIR/deploy/systemd/hiby-hub.service"    /etc/systemd/system/
sed -e "s#@BUCKET@#${R2_BUCKET}#g" "$APP_DIR/deploy/systemd/hiby-backup.service" > /etc/systemd/system/hiby-backup.service
cp "$APP_DIR/deploy/systemd/hiby-backup.timer"   /etc/systemd/system/
chmod +x "$APP_DIR/deploy/"*.sh
systemctl daemon-reload
systemctl enable --now hiby-library.service
for _ in $(seq 1 20); do mountpoint -q "$SRV/library" && break; sleep 1; done
mountpoint -q "$SRV/library" || die "The R2 mount didn't come up. See: journalctl -u hiby-library -n 50"
echo "    Library mounted: $(ls "$SRV/library" | wc -l) top-level folders."
systemctl enable --now hiby-hub.service
systemctl enable --now hiby-backup.timer

if [ -n "${TUNNEL_TOKEN:-}" ]; then
  say "Connecting the Cloudflare Tunnel"
  cloudflared service install "$TUNNEL_TOKEN" >/dev/null 2>&1 || warn "cloudflared service install reported a problem; check: systemctl status cloudflared"
fi

# ── Firewall: nothing inbound except SSH (the tunnel dials out) ─────────────
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null

# ── Check ───────────────────────────────────────────────────────────────────
say "Checking the Hub"
ok=""
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3847/api/status >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ -n "$ok" ] || die "The Hub didn't answer on port 3847. See: journalctl -u hiby-hub -n 50"

TOKEN="$(env_get WHEELHOUSE_TOKEN)"
cat <<EOF

────────────────────────────────────────────────────────────────────
  HiBy Hub is running.

  Web:        https://${HUB_HOSTNAME}
  Library:    $SRV/library  (r2:${R2_BUCKET}/library)
  Uploads:    $SRV/inbox
  Database:   $SRV/data/hub.db  (backed up nightly to r2:${R2_BUCKET}/backups)

  Wheelhouse sync token (enter this in Wheelhouse on the R4):
      ${TOKEN}

  Useful commands:
      sudo journalctl -u hiby-hub -f        live Hub log
      sudo systemctl restart hiby-hub       restart after changing .env
      sudo /opt/hiby-hub/deploy/update.sh   pull the latest code and restart
────────────────────────────────────────────────────────────────────
EOF
