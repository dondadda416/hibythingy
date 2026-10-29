import { describe, it, expect } from 'vitest';
import path from 'node:path';
import r2 from '../lib/r2.js';

const root = path.resolve('/srv/hiby/library');
const config = {
  LIBRARY_PATH: root,
  R2: {
    ACCOUNT_ID: 'acct123',
    ACCESS_KEY_ID: 'AKIDEXAMPLE0000000000000000000000',
    SECRET_ACCESS_KEY: 'secretsecretsecretsecretsecretsecretsecretsecretsecretsecret00',
    BUCKET: 'hiby-library',
    LIBRARY_PREFIX: 'library',
    LINK_TTL_SECONDS: 3600,
  },
};

describe('r2 path mapping', () => {
  it('maps library paths to relative paths', () => {
    expect(r2.relFromLibrary(config, path.join(root, 'Artist', 'Album', '01.flac'))).toBe('Artist/Album/01.flac');
  });

  it('rejects paths outside the library', () => {
    expect(r2.relFromLibrary(config, '/srv/hiby/inbox/x.flac')).toBeNull();
    expect(r2.relFromLibrary(config, root)).toBeNull();
    expect(r2.relFromLibrary(config, '/srv/hiby/library-evil/x')).toBeNull();
  });

  it('turns relative paths back into absolute ones', () => {
    expect(r2.absFromRel(config, 'Artist/Album')).toBe(path.join(root, 'Artist', 'Album'));
    expect(r2.absFromRel(config, '/Artist/Album')).toBe(path.join(root, 'Artist', 'Album'));
  });

  it('refuses traversal', () => {
    expect(r2.absFromRel(config, '../etc/passwd')).toBeNull();
    expect(r2.absFromRel(config, 'Artist/../../x')).toBeNull();
    expect(r2.absFromRel(config, 'a\0b')).toBeNull();
    expect(r2.absFromRel(config, '')).toBeNull();
  });

  it('builds object keys with the prefix', () => {
    expect(r2.keyForRel(config, 'A/B/c.flac')).toBe('library/A/B/c.flac');
    expect(r2.keyForRel({ R2: { LIBRARY_PREFIX: '' } }, 'A/c.flac')).toBe('A/c.flac');
  });

  it('knows when it is configured', () => {
    expect(r2.isConfigured(config)).toBe(true);
    expect(r2.isConfigured({ R2: { ...config.R2, SECRET_ACCESS_KEY: '' } })).toBe(false);
  });
});

describe('r2 presigned links', () => {
  it('signs a GET for the right bucket, key and lifetime', async () => {
    r2._resetClient();
    const url = new URL(await r2.presignRel(config, 'Daft Punk/Discovery/01 One More Time.flac'));
    expect(url.hostname).toBe('acct123.r2.cloudflarestorage.com');
    expect(decodeURIComponent(url.pathname)).toBe('/hiby-library/library/Daft Punk/Discovery/01 One More Time.flac');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^AKIDEXAMPLE0+\/\d{8}\/auto\/s3\/aws4_request$/);
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('caps the lifetime at 7 days', async () => {
    const url = new URL(await r2.presignRel(config, 'a/b.flac', { expiresIn: 99 * 24 * 3600 }));
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(7 * 24 * 3600));
  });
});
