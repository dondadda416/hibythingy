# HiBy Hub

Music control centre for a HiBy R4: upload new albums, tag and identify them, file them into the library, build playlists, and send everything to the R4 over Wi-Fi.

- **Library** lives in Cloudflare R2. The server mounts it with rclone.
- **Inbox**: upload from any browser, including a phone.
- **R4 sync**: the Wheelhouse app on the R4 pulls queued albums and playlists. API: [WHEELHOUSE_SYNC.md](WHEELHOUSE_SYNC.md).
- **Hosting**: one small Ubuntu server behind a Cloudflare Tunnel and Access. Setup: [DEPLOY.md](DEPLOY.md).

## Branches

- `main`: the original Windows version (USB/MTP push, runs on the PC).
- `cloud`: this version.

## Development

```bash
npm install
cp .env.example .env      # point HUB_* paths at local folders
npm test
npm start                 # http://127.0.0.1:3847
```

Node 22.5 or newer is required (it uses the built-in `node:sqlite`).
