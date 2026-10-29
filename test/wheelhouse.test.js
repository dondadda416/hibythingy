// End-to-end tests for the cloud flow: queue an album from the dashboard,
// let "Wheelhouse" sync it, report it done, and send an inventory.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hiby-wh-'));
const LIB = path.join(tmp, 'library');
const INBOX = path.join(tmp, 'inbox');
const DATA = path.join(tmp, 'data');
const TOKEN = 'test-token-0123456789abcdef';

process.env.HUB_LIBRARY_PATH = LIB;
process.env.HUB_INBOX_PATH = INBOX;
process.env.HUB_DATA_DIR = DATA;
process.env.WHEELHOUSE_TOKEN = TOKEN;
process.env.R2_ACCOUNT_ID = '';
process.env.R2_ACCESS_KEY_ID = '';
process.env.R2_SECRET_ACCESS_KEY = '';

const request = require('supertest');
const express = require('express');
const db = require('../lib/db');

let app;
const auth = { Authorization: `Bearer ${TOKEN}` };

function write(rel, bytes = 1024) {
  const p = path.join(LIB, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
}

beforeAll(() => {
  fs.mkdirSync(INBOX, { recursive: true });
  write('Daft Punk/Discovery/01 One More Time.flac', 4096);
  write('Daft Punk/Discovery/02 Aerodynamic.flac', 2048);
  write('Daft Punk/Discovery/cover.jpg', 100);
  write('Daft Punk/Discovery/Thumbs.db', 10);
  write('Playlists/Dance.m3u8', 50);
  db.open(DATA);
  db.setAlbums('library', [{
    key: 'Daft Punk — Discovery', name: 'Discovery', artist: 'Daft Punk', album: 'Discovery',
    tracks: 2, path: path.join(LIB, 'Daft Punk', 'Discovery'), addedAt: 1,
  }]);
  app = express();
  app.use(express.json());
  app.use('/api/wheelhouse', require('../routes/wheelhouse'));
  app.use('/api/device', require('../routes/device'));
  app.use('/api/playlist', require('../routes/playlist'));
  app.use('/api/inbox', require('../routes/inbox'));
});

afterAll(() => {
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
});

describe('wheelhouse auth', () => {
  it('rejects missing or wrong tokens', async () => {
    await request(app).get('/api/wheelhouse/ping').expect(401);
    await request(app).get('/api/wheelhouse/ping').set('Authorization', 'Bearer nope').expect(401);
  });

  it('accepts the right token and records a check-in', async () => {
    const r = await request(app).get('/api/wheelhouse/ping').set(auth)
      .set('X-Device-Name', 'HiBy R4').set('X-Free-MB', '12345').expect(200);
    expect(r.body.ok).toBe(true);
    const status = await request(app).get('/api/device/status').expect(200);
    expect(status.body.connected).toBe(true);
    expect(status.body.name).toBe('HiBy R4');
    expect(status.body.freeMB).toBe(12345);
  });
});

describe('push → sync → done', () => {
  let jobId;

  it('refuses albums that are still in the inbox', async () => {
    fs.mkdirSync(path.join(INBOX, 'New Album'), { recursive: true });
    const r = await request(app).post('/api/device/push')
      .send({ sourcePath: path.join(INBOX, 'New Album'), artist: 'X', album: 'New Album' }).expect(400);
    expect(r.body.error).toMatch(/inbox/i);
  });

  it('queues a library album', async () => {
    const r = await request(app).post('/api/device/push')
      .send({ sourcePath: path.join(LIB, 'Daft Punk', 'Discovery'), artist: 'Daft Punk', album: 'Discovery' }).expect(200);
    expect(r.body.queued).toBe(true);
    jobId = r.body.jobId;
    const jobs = await request(app).get('/api/device/push').expect(200);
    const job = jobs.body.jobs.find(j => j.id === jobId);
    expect(job.status).toBe('queued');
    expect(job.tracks).toBe(2);
  });

  it('hands Wheelhouse the album with a link per file (no junk files)', async () => {
    const r = await request(app).get('/api/wheelhouse/sync').set(auth).expect(200);
    expect(r.body.linksVia).toBe('hub');
    const item = r.body.queue.find(q => q.id === jobId);
    expect(item.relPath).toBe('Daft Punk/Discovery');
    expect(item.files.map(f => f.path)).toEqual([
      'Daft Punk/Discovery/01 One More Time.flac',
      'Daft Punk/Discovery/02 Aerodynamic.flac',
      'Daft Punk/Discovery/cover.jpg',
    ]);
    expect(item.files[0].size).toBe(4096);
    expect(item.files[0].url).toContain('/api/wheelhouse/file?path=');
    expect(r.body.playlists.map(p => p.name)).toEqual(['Dance']);
  });

  it('streams a file when R2 is not configured', async () => {
    const r = await request(app).get('/api/wheelhouse/file')
      .query({ path: 'Daft Punk/Discovery/02 Aerodynamic.flac' }).set(auth).expect(200);
    expect(r.body.length || Number(r.headers['content-length'])).toBe(2048);
  });

  it('refuses traversal on the file endpoint', async () => {
    await request(app).get('/api/wheelhouse/file').query({ path: '../data/hub.db' }).set(auth).expect(400);
  });

  it('records the push once Wheelhouse reports done', async () => {
    await request(app).post(`/api/wheelhouse/queue/${jobId}`).set(auth).send({ status: 'done' }).expect(200);
    const jobs = await request(app).get('/api/device/push').expect(200);
    expect(jobs.body.jobs.find(j => j.id === jobId).status).toBe('done');
    expect(db.getPushLog().albums.map(a => a.key)).toContain('Daft Punk — Discovery');
    // Now it's "on device", so a second push is skipped.
    const again = await request(app).post('/api/device/push')
      .send({ sourcePath: path.join(LIB, 'Daft Punk', 'Discovery'), artist: 'Daft Punk', album: 'Discovery' }).expect(200);
    expect(again.body.skipped).toBe(true);
  });

  it('lets the dashboard cancel a queued item', async () => {
    const r = await request(app).post('/api/device/push')
      .send({ sourcePath: path.join(LIB, 'Daft Punk', 'Discovery'), artist: 'Daft Punk', album: 'Discovery', force: true }).expect(200);
    await request(app).delete(`/api/device/queue/${r.body.jobId}`).expect(200);
    const sync = await request(app).get('/api/wheelhouse/sync').set(auth).expect(200);
    expect(sync.body.queue.find(q => q.id === r.body.jobId)).toBeUndefined();
  });
});

describe('playlists and scans', () => {
  it('queues a playlist for the R4', async () => {
    const r = await request(app).post('/api/playlist/push').send({ name: 'Dance' }).expect(200);
    expect(r.body.queued).toBe(true);
    const sync = await request(app).get('/api/wheelhouse/sync').set(auth).expect(200);
    const pl = sync.body.queue.find(q => q.kind === 'playlist');
    expect(pl.files[0].path).toBe('Playlists/Dance.m3u8');
  });

  it('scan request → inventory completes it', async () => {
    await request(app).post('/api/device/scan').expect(200);
    expect((await request(app).get('/api/device/scan-status')).body.status).toBe('scanning');
    expect((await request(app).get('/api/wheelhouse/ping').set(auth)).body.scanWanted).toBe(true);

    await request(app).post('/api/wheelhouse/inventory').set(auth).send({
      albums: [{ artist: 'Daft Punk', album: 'Discovery', tracks: 2 }, { artist: 'Air', album: 'Moon Safari', tracks: 10 }],
      playlists: ['Playlists/Dance.m3u8', 'Playlists/Dance (1).m3u8'],
    }).expect(200);

    const st = (await request(app).get('/api/device/scan-status')).body;
    expect(st.status).toBe('done');
    expect(st.albumCount).toBe(2);
    expect((await request(app).get('/api/wheelhouse/ping').set(auth)).body.scanWanted).toBe(false);

    const dl = (await request(app).get('/api/playlist/device-list')).body;
    expect(dl.total).toBe(2);
    expect(dl.suggestedCount).toBe(1);
  });

  it('lets the R4 browse and request albums itself', async () => {
    const lib = await request(app).get('/api/wheelhouse/library').query({ q: 'daft' }).set(auth).expect(200);
    expect(lib.body.albums[0].relPath).toBe('Daft Punk/Discovery');
    const req = await request(app).post('/api/wheelhouse/request').set(auth).send({ relPath: 'Daft Punk/Discovery' }).expect(200);
    expect(db.getQueueItem(req.body.id).album).toBe('Discovery');
  });
});

describe('inbox upload', () => {
  it('streams an uploaded file into the inbox', async () => {
    const body = Buffer.alloc(300000, 7);
    await request(app).post('/api/inbox/import-file')
      .set('X-Rel-Path', 'Upload Test/01 Song.flac')
      .set('Content-Type', 'audio/flac')
      .send(body).expect(200);
    const written = fs.readFileSync(path.join(INBOX, 'Upload Test', '01 Song.flac'));
    expect(written.length).toBe(300000);
    expect(fs.readdirSync(path.join(INBOX, 'Upload Test')).filter(n => n.includes('.part-'))).toEqual([]);
  });

  it('rejects traversal in the upload path', async () => {
    await request(app).post('/api/inbox/import-file')
      .set('X-Rel-Path', 'a/../../etc/x').set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('x')).expect(400);
  });
});
