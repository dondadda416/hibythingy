# Deploying HiBy Hub behind a Cloudflare Tunnel

This guide makes Hub reachable from anywhere (your phone, a friend's laptop, a hotel) without exposing it directly to the internet. Your PC stays the host — Hub still needs your D: drive, your Soulseek inbox, and your USB-connected R4 — but **cloudflared** opens a private tunnel from Cloudflare's edge to `localhost:3847`, and **Cloudflare Access** sits in front to gate it with one-time-PIN email auth.

Cost: **$0** for personal use. Cloudflare's free plan covers the tunnel, the DNS, and Access for up to 50 users.

---

## What you need

- Your home PC running Hub (the one that talks to the R4).
- A domain on Cloudflare (free tier is fine; transfer one in, or buy one for ~$10/year).
- Five minutes.

---

## 1. Install `cloudflared` on the host PC

Download the Windows installer from <https://github.com/cloudflare/cloudflared/releases> (file is `cloudflared-windows-amd64.msi`) and run it. After install, open a new PowerShell terminal (so the new `PATH` is loaded) and verify:

```powershell
cloudflared --version
```

## 2. Log in to your Cloudflare account

```powershell
cloudflared tunnel login
```

A browser tab opens. Pick the domain you want to use; Cloudflare drops a certificate at `C:\Users\<you>\.cloudflared\cert.pem`.

## 3. Create the tunnel

```powershell
cloudflared tunnel create hiby-hub
```

This prints a tunnel UUID and writes a credentials JSON to `C:\Users\<you>\.cloudflared\<UUID>.json`. Note the UUID; you'll need it next.

## 4. Configure the tunnel

Create `C:\Users\<you>\.cloudflared\config.yml` (replace `<UUID>` and `<your-host>`):

```yaml
tunnel: <UUID>
credentials-file: C:\Users\<you>\.cloudflared\<UUID>.json

ingress:
  - hostname: <your-host>          # e.g. hiby.example.com
    service: http://localhost:3847
    originRequest:
      noTLSVerify: true            # Hub runs plain HTTP on localhost; tunnel encrypts the outer leg
      connectTimeout: 10s
  # Catch-all rule required by cloudflared
  - service: http_status:404
```

## 5. Route DNS at your host

```powershell
cloudflared tunnel route dns hiby-hub <your-host>
```

This creates a `CNAME` in your Cloudflare DNS pointing at the tunnel. Propagation is instant.

## 6. Install as a Windows service so it survives reboots

```powershell
cloudflared service install
```

That registers `cloudflared` as a Windows service running under `LOCAL SYSTEM`. To verify it's running:

```powershell
Get-Service cloudflared
```

You should see `Status: Running`.

## 7. Lock the front door with Cloudflare Access

By default, anyone on the internet who knows the hostname can hit your Hub. Add Access to gate it.

1. In your Cloudflare dashboard, go to **Zero Trust → Access → Applications → Add an application → Self-hosted**.
2. **Application name**: `HiBy Hub`. **Domain**: `<your-host>`. Session duration: whatever you want (24h is fine).
3. **Add policy**: name it `Owner`, action `Allow`, include rule **Emails** → your email address. Save.
4. The next time you hit `https://<your-host>` from a fresh browser, Cloudflare asks for your email and emails you a one-time PIN.

That's it. Hub is now reachable from anywhere, and only signed-in users get past Cloudflare's edge.

---

## 8. Tell Hub it's behind a proxy

Open **Settings → Remote access** in Hub (or edit `.env` directly):

```ini
HUB_TRUST_PROXY=true
ALLOWED_ORIGINS=https://<your-host>
```

Optional belt-and-braces password (in case Cloudflare Access is ever bypassed):

```ini
BASIC_AUTH_USER=your-name
BASIC_AUTH_PASS=a-long-random-string
```

Hub's basic-auth gate skips `/api/coverart/serve` and `/api/tags/preview` so `<img>` and `<audio>` tags keep working without manual headers.

Restart the server (`Ctrl+C`, `npm start`). The boot banner now reads:

```
  Proxy:     enabled (X-Forwarded-* trusted from loopback)
  Auth:      Basic — user "your-name"
  Origins:   localhost + https://<your-host>
```

---

## Troubleshooting

**"CORS: origin not allowed"** in the browser console
→ `ALLOWED_ORIGINS` is missing your tunnel hostname. Add it in Settings → Remote access, restart.

**Rate-limit returns 429 for every request from outside**
→ `HUB_TRUST_PROXY` is off, so every request looks like it came from `127.0.0.1` and shares the same bucket. Flip it on.

**Cloudflare Access loop**
→ Your domain isn't fully proxied through Cloudflare. In Cloudflare DNS, the CNAME for `<your-host>` must have the orange cloud icon enabled.

**`cloudflared` service won't start**
→ Open `Event Viewer → Windows Logs → Application` and filter on Source `cloudflared`. The most common cause is the credentials JSON path being wrong in `config.yml` — Windows is picky about backslashes.

**Hub serves but device push fails over the tunnel**
→ The tunnel only fronts the HTTP server. Device push runs PowerShell on the host PC, which is fine — it doesn't care where the request came from.

---

## Alternative: Tailscale

If a custom domain feels like overkill, Tailscale gives you the same "reachable from anywhere" with one installer and no DNS. Install Tailscale on the host PC and on whatever you're using to reach Hub. Then `http://<machine-name>:3847` works from any device on your tailnet. Skip Access; Tailscale already authenticates you.

Trade-off: no public URL to share, and the listening device has to be on Tailscale too.
