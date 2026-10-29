# Wheelhouse ↔ Hub sync API (v1)

How Wheelhouse on the HiBy R4 gets music from the cloud Hub over Wi-Fi.

## Model

- Hub keeps a **download queue**. "Push to HiBy" in the dashboard adds albums or playlists to it.
- Wheelhouse calls `GET /api/wheelhouse/sync`. Each queued item comes with a download link for every file.
- Wheelhouse downloads the files into its music folder at the item's `relPath`, then reports the item `done` (or `error`).
- File links point straight at Cloudflare R2 (signed, valid ~6 hours), so music never passes through the small server.
- The R4 mirrors the library's folder layout: `Music/<relPath>`. Playlists live at `Music/Playlists/*.m3u8` and use paths like `../Artist/Album/01 Track.flac`, which resolve because of that mirroring.

## Auth

Every request needs:

```
Authorization: Bearer <WHEELHOUSE_TOKEN>
```

The token is printed at the end of `deploy/setup.sh` and is stored as `WHEELHOUSE_TOKEN` in the server's `.env`. `/api/wheelhouse/*` has a Cloudflare Access **Bypass** rule, so the token is the only gate. Keep it secret.

Optional headers on any call, which the dashboard shows:

| Header | Example |
|---|---|
| `X-Device-Name` | `HiBy R4` |
| `X-App-Version` | `1.3.0` |
| `X-Free-MB` / `X-Total-MB` | `81234` / `243000` |

Any authenticated call counts as a check-in. The dashboard shows the R4 as online when it has checked in within the last 10 minutes.

**Don't send the `Authorization` header to R2 links.** They're pre-signed, and R2 rejects requests that carry both. OkHttp and most HTTP clients drop it automatically on a cross-host redirect.

## Endpoints

Base: `https://<hub host>/api/wheelhouse`

### `GET /ping`

Cheap check for whether there's anything to do.

```json
{ "ok": true, "apiVersion": 1, "queued": 3, "scanWanted": false, "time": "…" }
```

### `GET /sync`

Returns up to 25 open queue items per call. `remaining` says how many more are waiting.

```json
{
  "ok": true,
  "scanWanted": false,
  "linksVia": "r2",
  "linkTtlSeconds": 21600,
  "remaining": 0,
  "queue": [
    {
      "id": 41, "kind": "album", "action": "download",
      "relPath": "Massive Attack/Mezzanine",
      "artist": "Massive Attack", "album": "Mezzanine",
      "tracks": 11, "sizeMB": 412.3, "status": "queued",
      "files": [
        { "path": "Massive Attack/Mezzanine/01 Angel.flac", "size": 41234567,
          "mtime": 1793310006729, "audio": true, "url": "https://…r2.cloudflarestorage.com/…&X-Amz-Signature=…" },
        { "path": "Massive Attack/Mezzanine/cover.jpg", "size": 182311, "audio": false, "url": "…" }
      ]
    },
    { "id": 42, "kind": "playlist", "action": "download", "relPath": "Playlists/Dance.m3u8", "files": [ … ] },
    { "id": 43, "kind": "playlist", "action": "delete",   "relPath": "Playlists/Dance (1).m3u8" }
  ],
  "playlists": [ { "name": "Dance", "file": "Dance.m3u8", "relPath": "Playlists/Dance.m3u8", "size": 2048, "mtime": 1793310000000 } ]
}
```

- `kind`: `album` or `playlist`
- `action`: `download` or `delete`. A delete removes the file or folder at `Music/<relPath>`.
- A link that has expired (403) only needs a fresh `/sync` call.
- `playlists` is the full current list. Wheelhouse may refresh any playlist whose `mtime` changed, even if it wasn't queued.
- An item with an `error` field (for example, the album was deleted from the library) can't be fetched. Report it as `error`.

### `POST /queue/:id`

```json
{ "status": "running" }
{ "status": "done", "tracksOnDevice": 11 }
{ "status": "error", "error": "SD card full" }
```

Send `running` when starting, then `done` after every file is written and verified by size. `done` records the album in Hub's push log, which removes it from the sync backlog. Items left in `running` for 6 hours go back to `queued`. A cancelled item answers `{ "ok": true, "cancelled": true }`; skip it.

### `POST /inventory`

Sends what's actually on the R4. Do this when `scanWanted` is true, after finishing a batch, and occasionally (for example, daily).

```json
{
  "albums": [ { "artist": "Massive Attack", "album": "Mezzanine", "tracks": 11, "sizeMB": 412.3, "relPath": "Massive Attack/Mezzanine" } ],
  "playlists": [ "Playlists/Dance.m3u8" ],
  "freeMB": 81234, "totalMB": 243000
}
```

This replaces Hub's "on device" list and clears `scanWanted`. For albums, use the folder's parent as `artist` and the folder name as `album`, or the tags if Wheelhouse has them.

### `GET /library?q=&limit=&offset=`

Browse the library from the R4. Returns `{ total, albums: [{ key, artist, album, relPath, tracks, genre, addedAt }] }`.

### `POST /request`

```json
{ "relPath": "Air/Moon Safari" }
```

Queues an album picked on the R4. It shows up in the next `/sync`.

### `GET /file?path=<relPath>`

Redirects to a signed R2 link for one file. When R2 isn't configured, it streams the file through the Hub instead (Range requests supported).

## Suggested Wheelhouse loop

1. On Wi-Fi and unmetered, call `/ping` every 5–15 minutes, plus when the app opens.
2. If `queued > 0` or `scanWanted`, call `/sync`.
3. For each item: `POST running` → download each file to `Music/<path>.part`, check its size, rename → `POST done`.
4. Repeat `/sync` while `remaining > 0`.
5. If `scanWanted` was set, or anything changed, `POST /inventory`.
6. Ask Android's media scanner to rescan the folders that changed.
