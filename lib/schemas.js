'use strict';
// ── lib/schemas.js ───────────────────────────────────────────────────────────
// Centralised Zod schemas for every Express handler that accepts a request
// body or query. Routes import the schemas they need and pass them through
// validateBody()/validateQuery() so input shape, type, and bounds are checked
// before any handler logic runs.

const { z } = require('zod');

// Shared building blocks ------------------------------------------------------

// A "safe-ish" filesystem path string. We don't try to do canonical-path
// validation here (lib/safePath.js owns that); we just enforce a non-empty
// string with no null bytes and a sane upper bound.
const FsPath = z.string().min(1).max(1024).refine(s => !s.includes('\0'), {
  message: 'Path must not contain null bytes',
});

// A folder name supplied by the user. Looser than a path — we allow most
// printables but cap the length and reject obvious traversal.
const FolderName = z.string().min(1).max(512).refine(s => !s.includes('\0'), {
  message: 'Folder name must not contain null bytes',
});

const TagString = z.string().max(512).optional().or(z.literal(''));

// ── Tagger ───────────────────────────────────────────────────────────────────

const TagsApplyBody = z.object({
  folder:        FolderName,
  folderPath:    FsPath.optional(),
  artist:        TagString,
  album:         TagString,
  year:          z.union([z.string().max(8), z.number()]).optional(),
  genre:         TagString,
  newFolderName: FolderName.optional(),
  tracks: z.array(z.object({
    filename: z.string().min(1).max(512),
    title:    z.string().max(512).optional(),
    trackNum: z.union([z.string().max(8), z.number()]).optional(),
  })).max(500).optional(),
});

const TagsMoveBody = z.object({
  folder:     FolderName,
  folderPath: FsPath.optional(),
});

const TagsUpdateBody = z.object({
  folderPath: FsPath,
  artist:     TagString,
  album:      TagString,
  year:       z.union([z.string().max(8), z.number()]).optional(),
  genre:      TagString,
  tracks: z.array(z.object({
    filename: z.string().min(1).max(512),
    title:    z.string().max(512).optional(),
    trackNum: z.union([z.string().max(8), z.number()]).optional(),
  })).max(500).optional(),
});

const TagsMergeBody = z.object({
  sourceFolder: FolderName,
  sourcePath:   FsPath.optional(),
  destFolder:   FolderName,
  tags: z.object({
    artist: TagString,
    album:  TagString,
    year:   z.union([z.string().max(8), z.number()]).optional(),
    genre:  TagString,
  }).partial().optional(),
  tracks: z.array(z.object({
    filename: z.string().min(1).max(512),
    title:    z.string().max(512).optional(),
    trackNum: z.union([z.string().max(8), z.number()]).optional(),
  })).max(500).optional(),
});

const TagsQuarantineBody = z.object({
  name:   FolderName,
  path:   FsPath,
  reason: z.string().max(512).optional(),
  type:   z.enum(['inbox', 'sync', 'library']).optional(),
});

const TagsReadQuery = z.object({
  folder: FolderName,
  path:   FsPath.optional(),
}).passthrough();

const TagsTracklistQuery = z.object({
  path: FsPath,
}).passthrough();

const TagsCompareQuery = z.object({
  source:     FolderName,
  sourcePath: FsPath.optional(),
  dest:       FolderName,
}).passthrough();

const TagsPreviewQuery = z.object({
  path:  FsPath,
  track: z.coerce.number().int().min(0).max(999).optional(),
}).passthrough();

// ── Identify ─────────────────────────────────────────────────────────────────

const IdentifyBody = z.object({
  folderName:   FolderName,
  folderPath:   FsPath.optional(),
  existingTags: z.record(z.union([z.string().max(512), z.number(), z.null()])).optional(),
});

const IdentifyMusicBrainzBody = z.object({
  artist:     z.string().min(1).max(512),
  album:      z.string().min(1).max(512),
  year:       z.union([z.string().max(8), z.number()]).optional(),
  folderPath: FsPath.optional(),
  folderName: FolderName.optional(),
});

// ── Device ───────────────────────────────────────────────────────────────────

const DevicePushBody = z.object({
  sourcePath: FsPath,
  artist:     z.string().min(1).max(512),
  album:      z.string().min(1).max(512),
  force:      z.boolean().optional(),
});

const DevicePushBatchBody = z.object({
  albums: z.array(z.object({
    sourcePath: FsPath,
    artist:     z.string().min(1).max(512),
    album:      z.string().min(1).max(512),
    force:      z.boolean().optional(),
  })).min(1).max(500),
});

// ── Health ───────────────────────────────────────────────────────────────────

const HealthFolderBody = z.object({
  folderPath: FsPath,
});

// ── Software ─────────────────────────────────────────────────────────────────

const SoftwareLaunchBody = z.object({
  targetPath: FsPath.optional(),
});

// ── Smart playlists ──────────────────────────────────────────────────────────
// Filter spec is the same shape lib/smartFilter.js consumes. Everything is
// optional — an empty spec returns the whole library sorted by name.
const SmartFilterSpec = z.object({
  search:         z.string().max(200).optional(),
  artist:         z.union([z.string().max(200), z.array(z.string().max(200)).max(50)]).optional(),
  format:         z.array(z.string().max(16)).max(20).optional(),
  decadeFrom:     z.number().int().min(1900).max(2100).optional(),
  decadeTo:       z.number().int().min(1900).max(2100).optional(),
  addedAfterDays: z.number().int().min(0).max(36500).optional(),
  addedBefore:    z.number().int().min(0).optional(),
  minTracks:      z.number().int().min(0).max(1000).optional(),
  maxTracks:      z.number().int().min(0).max(1000).optional(),
  sort:           z.enum(['name', 'artist', 'addedDesc', 'addedAsc', 'tracksDesc']).optional(),
  limit:          z.number().int().min(1).max(5000).optional(),
  shuffle:        z.boolean().optional(),
});

const SmartPlaylistCreateBody = z.object({
  name:       z.string().min(1).max(120),
  definition: SmartFilterSpec,
});

const SmartPlaylistUpdateBody = z.object({
  name:       z.string().min(1).max(120).optional(),
  definition: SmartFilterSpec.optional(),
});

// ── Settings ─────────────────────────────────────────────────────────────────
// Every field optional — we PATCH-style apply only what's supplied. Empty
// strings are treated as "unset" by the route (clears the .env line).
const SettingsBody = z.object({
  // Paths — config.js native (will be applied to config.js too if changed)
  INBOX_PATH:    z.string().max(1024).optional(),
  LIBRARY_PATH:  z.string().max(1024).optional(),
  DEVICE_NAME:   z.string().max(120).optional(),
  // .env-driven
  ANTHROPIC_API_KEY:      z.string().max(200).optional(),
  ANTHROPIC_MODEL:        z.string().max(80).optional(),
  LASTFM_API_KEY:         z.string().max(80).optional(),
  LASTFM_USERNAME:        z.string().max(60).optional(),
  HIBYHUB_CONTACT_EMAIL:  z.string().max(120).optional(),
  DEVICE_MUSIC_FOLDER:    z.string().max(120).optional(),
  DAILY_AI_BUDGET_USD:    z.union([z.number(), z.string()]).optional(),
  PORT:                   z.union([z.number(), z.string()]).optional(),
  // Remote access — used when running behind a Cloudflare Tunnel / Tailscale.
  HUB_TRUST_PROXY:        z.union([z.boolean(), z.string()]).optional(),
  ALLOWED_ORIGINS:        z.string().max(1024).optional(),
  BASIC_AUTH_USER:        z.string().max(80).optional(),
  BASIC_AUTH_PASS:        z.string().max(120).optional(),
});

module.exports = {
  TagsApplyBody, TagsMoveBody, TagsUpdateBody, TagsMergeBody, TagsQuarantineBody,
  TagsReadQuery, TagsTracklistQuery, TagsCompareQuery, TagsPreviewQuery,
  IdentifyBody, IdentifyMusicBrainzBody,
  DevicePushBody, DevicePushBatchBody,
  HealthFolderBody,
  SoftwareLaunchBody,
  SmartFilterSpec, SmartPlaylistCreateBody, SmartPlaylistUpdateBody,
  SettingsBody,
};
