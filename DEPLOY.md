# Running HiBy Hub in the cloud

```
 you (any browser) ──► Cloudflare Access ──► Tunnel ──► small server: HiBy Hub (127.0.0.1:3847)
                                                              │  rclone mount
                                                              ▼
 HiBy R4 (Wheelhouse) ──► /api/wheelhouse (token) ──► signed links ──► Cloudflare R2: hiby-library/library/…
```

- **Library**: the R2 bucket `hiby-library`, under the `library/` prefix. The server mounts it at `/srv/hiby/library` with rclone, so the Hub treats it like a normal folder. Recently used files are cached on the server's disk (up to 15 GB).
- **Inbox**: `/srv/hiby/inbox` on the server's disk. You fill it by dragging folders onto the Home page, or with **Choose folder… / Choose files…** on a phone. Files over 95 MB are skipped because Cloudflare limits uploads to 100 MB each.
- **Database**: `/srv/hiby/data/hub.db`. It's backed up every night to `hiby-library/backups/` and kept for 30 days.
- **R4**: Wheelhouse pulls queued albums and playlists over Wi-Fi. See [WHEELHOUSE_SYNC.md](WHEELHOUSE_SYNC.md).

## 1. Server

Any Ubuntu 24.04 VPS with 2 GB+ RAM and 40 GB+ disk works. Nothing needs to be close to you: the R4 downloads straight from R2, and the server only handles the dashboard and uploads.

## 2. Cloudflare Tunnel

In Cloudflare **Zero Trust → Networks → Tunnels**:

1. **Create a tunnel** → Cloudflared → name it `hiby-hub-cloud`. Copy the **token** from the install command (the long string after `--token`). Don't run the command shown there; the setup script installs it.
2. **Public hostname**: `hiby.<your domain>` → service `HTTP` → `localhost:3847`.
   If the hostname is still pointed at an old tunnel, delete that DNS record (or the old tunnel's public hostname) first.

## 3. (Optional) bring the old database over

This keeps favourites, the push log, smart playlists and activity history. On the old PC, close the Hub, then:

```powershell
rclone copy "C:\Users\user\Documents\Claude\Projects\HIby Project\cache" r2:hiby-library/migrate --include "hub.db*"
```

The setup script imports it on first run.

## 4. Run the setup

SSH into the server, then:

```bash
curl -fsSL https://raw.githubusercontent.com/dondadda416/hibythingy/cloud/deploy/setup.sh | sudo bash
```

It asks for the Cloudflare account ID, the R2 key ID and secret, the bucket name, the web address and the tunnel token. It then installs Node 22, rclone and cloudflared, mounts the library, starts everything, and prints the **Wheelhouse token**.

## 5. Cloudflare Access

Keep your existing **HiBy Hub** Access application (email PIN) on `hiby.<your domain>`. The R4 can't type a PIN, so it carries an Access **service token** instead:

1. **Zero Trust → Access → Service credentials → Service Tokens → Create**. Name it `hiby-r4` and pick a long duration. Copy the **Client ID** and **Client Secret** (the secret is only shown once).
2. **Zero Trust → Access → Applications → Add → Self-hosted**: name `HiBy Hub – Wheelhouse`, domain `hiby.<your domain>`, path `api/wheelhouse`. Add a policy with action **Service Auth**, include **Service Token → hiby-r4**.
   The more specific path wins, so only `/api/wheelhouse/*` accepts the token; the dashboard keeps its PIN. Those requests also still need the Wheelhouse token.
3. On the server, add both values to `/opt/hiby-hub/.env` and restart:
   ```
   CF_ACCESS_CLIENT_ID=<client id>.access
   CF_ACCESS_CLIENT_SECRET=<client secret>
   ```
   `sudo systemctl restart hiby-hub`
4. Open `https://hiby.<your domain>/connect` (Device page → **Connect R4**), download `hub.txt`, copy it to the R4's `Download` folder, and in Wheelhouse choose Hub → Set up → **Load hub.txt From Card**.

## Day to day

| Task | Command |
|---|---|
| Live log | `sudo journalctl -u hiby-hub -f` |
| Restart after editing `/opt/hiby-hub/.env` | `sudo systemctl restart hiby-hub` |
| Update to the latest code | `sudo /opt/hiby-hub/deploy/update.sh` |
| Check the R2 mount | `systemctl status hiby-library` |
| Run a backup now | `sudo systemctl start hiby-backup` |

**Restore a backup**

```bash
sudo systemctl stop hiby-hub
sudo -u hiby rclone --config /etc/rclone/hiby.conf copyto r2:hiby-library/backups/hub-YYYY-MM-DD.db /srv/hiby/data/hub.db
sudo rm -f /srv/hiby/data/hub.db-wal /srv/hiby/data/hub.db-shm
sudo systemctl start hiby-hub
```

**Adding music outside the Hub.** Anything copied straight into the bucket (for example `rclone copy … r2:hiby-library/library` from a PC) appears within 30 minutes, when the mount's folder cache refreshes. For an immediate refresh, run `sudo systemctl restart hiby-library hiby-hub`.

## Troubleshooting

- **"CORS: origin not allowed"**: `ALLOWED_ORIGINS` in `.env` must be exactly `https://hiby.<your domain>`.
- **R4 gets 401**: the token in Wheelhouse doesn't match `WHEELHOUSE_TOKEN` in `.env`.
- **Wheelhouse says "Cloudflare blocked the R4"**: the `api/wheelhouse` Access application or its Service Auth policy is missing, or the service token in the setup code is wrong or expired. Check `CF_ACCESS_CLIENT_*` in `.env`, restart, and load a fresh `hub.txt`.
- **Library looks empty**: run `journalctl -u hiby-library -n 50`. Most often the R2 key is wrong, or it doesn't have access to the bucket.
