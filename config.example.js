// ── HiBy Hub Configuration ──────────────────────────────────────────────────
// Copy this file to config.js and fill in your folder paths.
// Secrets (API keys) come from .env — see .env.example.
// config.js is gitignored so your local paths stay private.

'use strict';
const path = require('path');

// Load .env early. Failure is non-fatal; config still loads.
try { require('dotenv').config(); } catch (_) {
  console.warn('[config] dotenv not installed — run `npm install` to enable .env support.');
}

function envOrEmpty(name) {
  const v = process.env[name];
  return (typeof v === 'string') ? v.trim() : '';
}

module.exports = {

  // ── AI Identification ─────────────────────────────────────────────────────
  // Set ANTHROPIC_API_KEY in .env. Get a key at https://console.anthropic.com
  ANTHROPIC_API_KEY:     envOrEmpty('ANTHROPIC_API_KEY'),
  ANTHROPIC_MODEL:       'claude-haiku-4-5-20251001',
  ANTHROPIC_PRICE_INPUT:  0.80,
  ANTHROPIC_PRICE_OUTPUT: 4.00,

  // ── Folders ──────────────────────────────────────────────────────────────
  // Where Soulseek (or other) downloads land — the staging inbox
  INBOX_PATH: 'C:\\Users\\YourName\\Documents\\Soulseek Downloads\\complete',

  // How many days back to show in inbox (0 = show everything)
  INBOX_DAYS: 30,

  // Master library on your external drive
  LIBRARY_PATH: 'D:\\Music Library',

  // ── Device ───────────────────────────────────────────────────────────────
  // Name of the HiBy player as shown in Windows "This PC" when connected via USB
  DEVICE_NAME: 'R4',   // e.g. R4, R6 Pro, RS2, RS6, R3 etc.

  // ── Last.fm ──────────────────────────────────────────────────────────────
  // Set LASTFM_API_KEY + LASTFM_USERNAME in .env. Free key at:
  //   https://www.last.fm/api/account/create
  LASTFM_API_KEY:  envOrEmpty('LASTFM_API_KEY'),
  LASTFM_USERNAME: envOrEmpty('LASTFM_USERNAME'),

  // Contact email used in outbound HTTP User-Agent strings (MusicBrainz etc.).
  // Override via HIBYHUB_CONTACT_EMAIL in .env.
  CONTACT_EMAIL: envOrEmpty('HIBYHUB_CONTACT_EMAIL') || 'admin@example.com',

  // ── Server ───────────────────────────────────────────────────────────────
  PORT: parseInt(envOrEmpty('PORT'), 10) || 3847,

  // Cache directory — stores device scan data, push log, AI usage counters
  CACHE_DIR: path.join(__dirname, 'cache'),

  // ── Software ─────────────────────────────────────────────────────────────
  // Hub tries each path in order and uses the first one that exists.
  SOFTWARE: {
    soulseek: {
      name: 'Soulseek',
      exePaths: [
        'C:\\Users\\YourName\\AppData\\Local\\Programs\\Soulseek\\Soulseek.exe',
        'C:\\Program Files\\Soulseek\\Soulseek.exe',
      ],
    },
    mp3tag: {
      name: 'Mp3tag',
      exePaths: [
        'C:\\Program Files\\Mp3tag\\Mp3tag.exe',
        'C:\\Program Files (x86)\\Mp3tag\\Mp3tag.exe',
      ],
    },
    picard: {
      name: 'MusicBrainz Picard',
      exePaths: [
        'C:\\Program Files\\MusicBrainz Picard\\picard.exe',
        'C:\\Program Files (x86)\\MusicBrainz Picard\\picard.exe',
      ],
    },
    foobar: {
      name: 'foobar2000',
      exePaths: [
        'C:\\Program Files\\foobar2000\\foobar2000.exe',
        'C:\\Program Files (x86)\\foobar2000\\foobar2000.exe',
      ],
    },
    freac: {
      name: 'fre:ac',
      exePaths: [
        'C:\\Program Files\\fre:ac\\freac.exe',
        'C:\\Program Files (x86)\\fre:ac\\freac.exe',
      ],
    },
  },
};
