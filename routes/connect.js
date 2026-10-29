// /connect — hands out the Wheelhouse setup code for the R4.
//
// GET /connect          small page: the code, a copy button, a hub.txt download
// GET /connect/hub.txt  the same code as a file to drop on the player
// GET /connect/code     JSON { ok, code, link, url, serviceToken }
//
// The code is "WH1:" + base64url(JSON {u, t, ci, cs}). It contains the
// Wheelhouse token and the Access service token, so this route sits behind the
// dashboard's own login (Cloudflare Access / Basic auth), never under
// /api/wheelhouse.
'use strict';
const express = require('express');
const config  = require('../config');

const router = express.Router();

function publicUrl(req) {
  if (config.PUBLIC_URL) return config.PUBLIC_URL;
  const o = (config.ALLOWED_ORIGINS || []).find(x => /^https:\/\//.test(x));
  if (o) return o.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host  = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

function setup(req) {
  if (!config.WHEELHOUSE_TOKEN) return null;
  const u = publicUrl(req);
  const body = { u, t: config.WHEELHOUSE_TOKEN };
  if (config.CF_ACCESS_CLIENT_ID && config.CF_ACCESS_CLIENT_SECRET) {
    body.ci = config.CF_ACCESS_CLIENT_ID;
    body.cs = config.CF_ACCESS_CLIENT_SECRET;
  }
  const code = 'WH1:' + Buffer.from(JSON.stringify(body)).toString('base64url');
  return { code, link: 'wheelhouse://setup?c=' + encodeURIComponent(code), url: u, serviceToken: !!body.ci };
}

function noStore(res) {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex');
}

router.get('/code', (req, res) => {
  noStore(res);
  const s = setup(req);
  if (!s) return res.status(503).json({ ok: false, error: 'WHEELHOUSE_TOKEN is not set on the server' });
  res.json({ ok: true, ...s });
});

router.get('/hub.txt', (req, res) => {
  noStore(res);
  const s = setup(req);
  if (!s) return res.status(503).type('text/plain').send('WHEELHOUSE_TOKEN is not set on the server\n');
  res.set('Content-Disposition', 'attachment; filename="hub.txt"');
  res.type('text/plain').send(
    '# Wheelhouse Hub setup. Copy to Download/ or Wheelhouse/ on the R4,\n' +
    '# then Hub > Setup > Load hub.txt From Card. Wheelhouse deletes it after loading.\n' +
    s.code + '\n');
});

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

router.get('/', (req, res) => {
  noStore(res);
  const s = setup(req);
  const warn = !s ? '<p class="warn">WHEELHOUSE_TOKEN is not set on the server, so sync is off.</p>'
    : !s.serviceToken ? '<p class="warn">No Cloudflare Access service token is set (CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET). If this Hub is behind Access, the R4 will be turned away.</p>'
    : '';
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect the R4</title>
<style>
:root{--bg:#f6f5f2;--fg:#1d1d1b;--mut:#6b6a66;--card:#fff;--line:#dedcd6;--acc:#2f6f5e;--warn:#9a4b00}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe7;--mut:#9c9b96;--card:#21211f;--line:#353532;--acc:#6cc2a8;--warn:#f0a34a}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:32px 16px}
h1{font-size:1.5rem;margin:0 0 4px}.mut{color:var(--mut)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0}
code{display:block;word-break:break-all;font:13px/1.4 ui-monospace,monospace;background:var(--bg);padding:10px;border-radius:6px}
button,a.btn{display:inline-block;margin:10px 8px 0 0;padding:8px 14px;border-radius:6px;border:1px solid var(--acc);background:var(--acc);color:var(--card);font:inherit;text-decoration:none;cursor:pointer}
a.btn.alt{background:none;color:var(--acc)}ol{padding-left:20px}.warn{color:var(--warn)}
</style></head><body><main>
<h1>Connect the R4</h1><p class="mut">Wheelhouse 1.10 or newer. This code holds the Hub's keys, so treat it like a password.</p>
${warn}
${s ? `<div class="card"><strong>Setup code</strong><code id="c">${esc(s.code)}</code>
<button id="copy" type="button">Copy code</button><a class="btn alt" href="/connect/hub.txt">Download hub.txt</a></div>
<div class="card"><strong>Easiest: hub.txt</strong><ol>
<li>Download hub.txt and copy it to the R4's <em>Download</em> folder (USB, or the card in a reader).</li>
<li>On the R4 open Wheelhouse &rarr; <em>Hub</em> &rarr; <em>Set up</em> &rarr; <em>Load hub.txt From Card</em>.</li>
<li>Press <em>Sync Now</em>. Albums you queue on the Hub then download over Wi-Fi.</li></ol>
<p class="mut">Or copy the code to the R4's clipboard and use <em>Paste Setup Code</em>.</p></div>
<p class="mut">Hub address in the code: ${esc(s.url)}</p>` : ''}
</main><script>
var b=document.getElementById('copy');if(b)b.onclick=function(){var t=document.getElementById('c').textContent;
(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){b.textContent='Copied'},function(){
var r=document.createRange();r.selectNodeContents(document.getElementById('c'));var s=getSelection();s.removeAllRanges();s.addRange(r);b.textContent='Selected — press Ctrl+C'})};
</script></body></html>`);
});

module.exports = router;
