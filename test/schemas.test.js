import { describe, it, expect } from 'vitest';
import * as S from '../lib/schemas.js';

describe('schemas.TagsApplyBody', () => {
  it('accepts a minimal valid payload', () => {
    expect(() => S.TagsApplyBody.parse({ folder: 'Album' })).not.toThrow();
  });

  it('rejects empty folder', () => {
    expect(() => S.TagsApplyBody.parse({ folder: '' })).toThrow();
  });

  it('rejects null bytes in folder path', () => {
    expect(() => S.TagsApplyBody.parse({ folder: 'A', folderPath: 'C:\\x\0y' })).toThrow();
  });

  it('caps tracks array length', () => {
    const tracks = Array.from({ length: 600 }, (_, i) => ({ filename: `t${i}.flac` }));
    expect(() => S.TagsApplyBody.parse({ folder: 'A', tracks })).toThrow();
  });

  it('drops unknown fields silently', () => {
    const out = S.TagsApplyBody.parse({ folder: 'A', evil: 'stripped' });
    expect('evil' in out).toBe(false);
  });
});

describe('schemas.IdentifyBody', () => {
  it('accepts minimal valid payload', () => {
    expect(() => S.IdentifyBody.parse({ folderName: 'Album' })).not.toThrow();
  });
  it('rejects huge folderName (>512)', () => {
    expect(() => S.IdentifyBody.parse({ folderName: 'a'.repeat(2000) })).toThrow();
  });
  it('rejects missing folderName', () => {
    expect(() => S.IdentifyBody.parse({})).toThrow();
  });
});

describe('schemas.DevicePushBody', () => {
  it('accepts a valid push', () => {
    expect(() => S.DevicePushBody.parse({
      sourcePath: 'D:\\Music\\Album', artist: 'Pink Floyd', album: 'The Wall',
    })).not.toThrow();
  });
  it('rejects missing sourcePath', () => {
    expect(() => S.DevicePushBody.parse({ artist: 'A', album: 'B' })).toThrow();
  });
  it('rejects null bytes', () => {
    expect(() => S.DevicePushBody.parse({
      sourcePath: 'D:\\Music\0', artist: 'A', album: 'B',
    })).toThrow();
  });
});

describe('schemas.DevicePushBatchBody', () => {
  it('rejects empty albums array', () => {
    expect(() => S.DevicePushBatchBody.parse({ albums: [] })).toThrow();
  });
  it('rejects > 500 albums', () => {
    const albums = Array.from({ length: 501 }, () => ({
      sourcePath: 'D:\\X', artist: 'A', album: 'B',
    }));
    expect(() => S.DevicePushBatchBody.parse({ albums })).toThrow();
  });
});

describe('schemas.HealthFolderBody', () => {
  it('requires folderPath', () => {
    expect(() => S.HealthFolderBody.parse({})).toThrow();
  });
});

describe('schemas.SoftwareLaunchBody', () => {
  it('accepts empty body', () => {
    expect(() => S.SoftwareLaunchBody.parse({})).not.toThrow();
  });
  it('accepts a target path', () => {
    expect(() => S.SoftwareLaunchBody.parse({ targetPath: 'C:\\X' })).not.toThrow();
  });
  it('rejects null bytes', () => {
    expect(() => S.SoftwareLaunchBody.parse({ targetPath: 'C:\\X\0' })).toThrow();
  });
});
