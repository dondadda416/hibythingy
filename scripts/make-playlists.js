#!/usr/bin/env node
'use strict';
// ── make-playlists.js ──────────────────────────────────────────────────────
// Generates all themed playlists as .m3u files in D:\Music\Playlists\
// Usage: node scripts/make-playlists.js
// ──────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

const PROJECT_ROOT  = path.join(__dirname, '..');
const CACHE_FILE    = path.join(PROJECT_ROOT, 'cache', 'library.json');
const LIBRARY_PATH  = 'D:\\Music';
const PLAYLISTS_DIR = path.join(LIBRARY_PATH, 'Playlists');
const AUDIO_EXTS    = new Set(['.flac', '.mp3', '.wav', '.aac', '.m4a', '.ogg', '.wma', '.ape', '.opus']);

// ── Load library cache ────────────────────────────────────────────────────
const libData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
const albumsByKey = new Map();
for (const a of libData.albums || []) {
  if (a.key) albumsByKey.set(a.key, a);
}
console.log(`Loaded ${albumsByKey.size} albums from library cache.\n`);

// Normalize curly apostrophes (U+2018/U+2019) to straight apostrophe (U+0027)
// so lookups work regardless of which apostrophe style was used in the filename
function normApos(s) { return s.replace(/['']/g, "'"); }
const albumsByNormKey = new Map();
for (const [k, v] of albumsByKey) {
  const nk = normApos(k);
  if (!albumsByNormKey.has(nk)) albumsByNormKey.set(nk, v);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function getAudioFiles(folderPath) {
  try {
    return fs.readdirSync(folderPath)
      .filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()))
      .sort()
      .map(f => path.join(folderPath, f));
  } catch (_) { return []; }
}

function toRelPath(trackPath) {
  return path.relative(PLAYLISTS_DIR, trackPath).replace(/\\/g, '/');
}

// Return all tracks from an album folder by library key
function album(key) {
  const a = albumsByKey.get(key) || albumsByNormKey.get(normApos(key));
  if (!a) { console.warn(`  ⚠  Album not found: "${key}"`); return []; }
  const tracks = getAudioFiles(a.path);
  if (!tracks.length) console.warn(`  ⚠  No audio files in: ${a.path}`);
  return tracks;
}

// Find one specific track within an album folder (multi-level fuzzy match)
function track(albumKey, songName) {
  const a = albumsByKey.get(albumKey) || albumsByNormKey.get(normApos(albumKey));
  if (!a) { console.warn(`  ⚠  Album not found: "${albumKey}"`); return null; }
  const files = getAudioFiles(a.path);
  // Strip diacritics (handles Santeria with accent, etc.) then strip non-alphanum
  const norm  = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(songName);
  // 1. Exact match on base name
  let found = files.find(f => norm(path.basename(f, path.extname(f))) === target);
  // 2. File name contains the song name (handles track-number prefix like "01 ")
  if (!found) found = files.find(f => norm(path.basename(f, path.extname(f))).includes(target));
  // 3. Song name contains file base (handles abbreviated targets)
  if (!found) found = files.find(f => target.includes(norm(path.basename(f, path.extname(f))).replace(/^\d+/, '')));
  // 4. All significant words of target appear in the filename (handles reordering/extra words)
  if (!found) {
    const words = target.replace(/^\d+/, '').match(/.{3,}/g) || [];
    if (words.length > 0) found = files.find(f => {
      const base = norm(path.basename(f, path.extname(f)));
      return words.every(w => base.includes(w));
    });
  }
  if (!found) console.warn(`  ⚠  Track not found: "${songName}" in "${albumKey}"`);
  return found || null;
}

function writeM3U(name, trackPaths) {
  if (!fs.existsSync(PLAYLISTS_DIR)) fs.mkdirSync(PLAYLISTS_DIR, { recursive: true });
  const valid = trackPaths.filter(Boolean);
  if (!valid.length) { console.log(`  ✗  ${name} — no tracks found, skipped`); return; }
  const lines = ['#EXTM3U', ''];
  for (const t of valid) {
    lines.push(`#EXTINF:-1,${path.basename(t, path.extname(t))}`);
    lines.push(toRelPath(t));
    lines.push('');
  }
  const safeName = name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 80);
  const out = path.join(PLAYLISTS_DIR, `${safeName}.m3u`);
  fs.writeFileSync(out, lines.join('\n'), 'utf8');
  console.log(`  ✓  ${name} — ${valid.length} tracks → ${out}`);
}

// =============================================================================
// PLAYLIST DEFINITIONS
// =============================================================================

console.log('🎵 Generating playlists...\n');

// ── 1. RECENTLY ADDED (last 180 days, newest first) ───────────────────────
console.log('1. Recently Added');
const cutoff = Date.now() - 180 * 24 * 60 * 60 * 1000;
const recentTracks = (libData.albums || [])
  .filter(a => (a.addedAt || 0) > cutoff && a.tracks > 0 && a.key !== '.thumbnails')
  .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
  .flatMap(a => getAudioFiles(a.path));
writeM3U('Recently Added', recentTracks);

// ── 2. SUMMER BBQ ─────────────────────────────────────────────────────────
console.log('\n2. Summer BBQ');
writeM3U('Summer BBQ', [
  ...album("Jimmy Buffett — Songs You Know by Heart  Jimmy Buffett’s Greatest Hit(s)"),
  ...album('Jack Johnson — In Between Dreams'),
  ...album('Jack Johnson — On and On'),
  ...album('Sublime — Greatest Hits'),
  ...album('Sublime — 40 oz. to Freedom'),
  ...album('Bob Marley & The Wailers — Legend (Deluxe Edition)'),
  ...album('Bob Marley & The Wailers — Kaya'),
  ...album('Bob Marley & The Wailers — Exodus (Remastered Bonus Track Version)'),
  ...album('Anderson .Paak — Malibu'),
  ...album('Bedouin Soundclash — Street Gospels'),
  ...album('Sting & Shaggy — 44 876'),
  ...album('Miley Cyrus — Endless Summer Vacation'),
  ...album('Kacey Musgraves — Golden Hour'),
  ...album("Grateful Dead — Workingman’s Dead"),
  ...album('Runkus & Toddla T - Outside'),
]);

// ── 3. GOLFING ────────────────────────────────────────────────────────────
console.log('\n3. Golfing');
writeM3U('Golfing', [
  ...album('Miles Davis — Kind of Blue'),
  ...album('John Scofield — A Go Go'),
  ...album('Phish — Lawn Boy'),
  ...album('Phish — Hoist'),
  ...album('Phish — Billy Breathes'),
  ...album('Fleetwood Mac — Rumours'),
  ...album('Joni Mitchell — Blue'),
  ...album('Joni Mitchell — Court and Spark'),
  ...album('Willie Nelson — Stardust'),
  ...album('Willie Nelson — Red Headed Stranger'),
  ...album('George Strait — 50 Number Ones'),
  ...album('Chris Stapleton — Traveller'),
  ...album('Bob Dylan — Blood on the Tracks'),
  ...album('Jack Johnson — In Between Dreams'),
  ...album('Jack Johnson — On and On'),
  ...album('John Prine — John Prine'),
  ...album('John Prine — Souvenirs'),
  ...album('Neil Young — On the Beach'),
  ...album('John Denver — The Best of John Denver'),
]);

// ── 4. KIDS JAMS ──────────────────────────────────────────────────────────
console.log('\n4. Kids Jams');
writeM3U('Kids Jams', [
  ...album('Jack Johnson — Sing-A-Longs and Lullabies for the Film Curious George'),
  ...album('Michael Jackson — Thriller'),
  ...album('Michael Jackson — Off the Wall'),
  ...album('Cyndi Lauper — Time After Time  The Best Of'),
  ...album('Taylor Swift — Fearless'),
  ...album("Taylor Swift — Red (Taylor’s version)"),
  ...album('Katy Perry — Teenage Dream'),
  ...album("Harry Styles — Harry’s House"),
  ...album('Ed Sheeran — ×'),
  ...album('Ed Sheeran — ÷'),
  ...album('Ed Sheeran — Play'),
  ...album('Benson Boone — American Heart'),
  ...album('Coco Jones — Why Not More'),
  ...album('Justin Bieber — Justice (complete edition)'),
  ...album('KPop Demon Hunters Cast, HUNTR X & Saja Boys — KPop Demon Hunters Soundtrack from the Netflix Film'),
]);

// ── 5. 90s ────────────────────────────────────────────────────────────────
console.log('\n5. 90s');
writeM3U('90s', [
  ...album('Nirvana — Nevermind (30th Anniversary Super Deluxe)'),
  ...album('Nirvana — In Utero'),
  ...album('Pearl Jam — Ten'),
  ...album('Pearl Jam — Vs'),
  ...album('Pearl Jam — Vitalogy'),
  ...album('A Tribe Called Quest — The Low End Theory'),
  ...album('A Tribe Called Quest — Midnight Marauders'),
  ...album('Nas — Illmatic'),
  ...album('Dr. Dre — The Chronic'),
  ...album('Snoop Doggy Dogg — Doggystyle'),
  ...album('2Pac — All Eyez on Me'),
  ...album('Fugees — The Score'),
  ...album('Lauryn Hill — The Miseducation of Lauryn Hill'),
  ...album('Sublime — 40 oz. to Freedom'),
  ...album('Sublime — Sublime'),
  ...album('Phish — Lawn Boy'),
  ...album('Phish — Hoist'),
  ...album('Phish — Billy Breathes'),
  ...album('Johnny Cash — American Recordings'),
  ...album('Garth Brooks — No Fences'),
  ...album("Garth Brooks — Ropin’ the Wind"),
]);

// ── 6. HIP HOP ────────────────────────────────────────────────────────────
console.log('\n6. Hip Hop');
writeM3U('Hip Hop', [
  ...album('Kendrick Lamar — To Pimp a Butterfly'),
  ...album('Kendrick Lamar — DAMN'),
  ...album('Kendrick Lamar — good kid, m.A.A.d city'),
  ...album('Kendrick Lamar — GNX'),
  ...album('A Tribe Called Quest — The Low End Theory'),
  ...album('A Tribe Called Quest — Midnight Marauders'),
  ...album('Nas — Illmatic'),
  ...album('Dr. Dre — The Chronic'),
  ...album('Snoop Doggy Dogg — Doggystyle'),
  ...album('2Pac — All Eyez on Me'),
  ...album("Ice Cube — AmeriKKKa’s Most Wanted"),
  ...album('Fugees — The Score'),
  ...album('Fugees (Tranzlator Crew) — Blunted on Reality'),
  ...album('Lauryn Hill — The Miseducation of Lauryn Hill'),
  ...album('Lil Wayne — Tha Carter III'),
  ...album('Kanye West — My Beautiful Dark Twisted Fantasy'),
  ...album('Drake — Take Care'),
  ...album('Aesop Rock - Black Hole Superette'),
  ...album('Nas & Damian Marley — Distant Relatives'),
  ...album('Anderson .Paak — Malibu'),
  ...album('Anderson .Paak — Oxnard'),
]);

// ── 7. FOLK & AMERICANA ───────────────────────────────────────────────────
console.log('\n7. Folk & Americana');
writeM3U('Folk & Americana', [
  ...album('Bob Dylan — Blood on the Tracks'),
  ...album('John Prine — John Prine'),
  ...album('John Prine — Bruised Orange'),
  ...album('John Prine — Souvenirs'),
  ...album('John Prine — The Missing Years'),
  ...album('John Prine — In Spite of Ourselves'),
  ...album('Joni Mitchell — Blue'),
  ...album('Joni Mitchell — Court and Spark'),
  ...album('Neil Young — On the Beach'),
  ...album('Sufjan Stevens — Illinois'),
  ...album('Lucinda Williams — Car Wheels on a Gravel Road'),
  ...album('Carole King — Tapestry'),
  ...album("Grateful Dead — Workingman’s Dead"),
  ...album('Tyler Childers — Purgatory'),
  ...album('Tyler Childers — Long Violent History'),
  ...album('Colter Wall - Imaginary Appalachia'),
  ...album('Colter Wall - Songs of the Plains'),
  ...album('James Bay — Chaos and the Calm'),
  ...album('John Denver — Earth Songs'),
]);

// ── 8. COUNTRY ────────────────────────────────────────────────────────────
console.log('\n8. Country');
writeM3U('Country', [
  ...album('Johnny Cash — American Recordings'),
  ...album('Johnny Cash — At Folsom Prison'),
  ...album('Johnny Cash — American IV  The Man Comes Around'),
  ...album('Johnny Cash — American II  Unchained'),
  ...album('Hank Williams — 40 Greatest Hits'),
  ...album('George Jones — She Thinks I Still Care  The Complete United Artists Recordings, 1962-1964'),
  ...album('George Jones — The New Favorites of George Jones'),
  ...album('George Strait — 50 Number Ones'),
  ...album('Garth Brooks — No Fences'),
  ...album("Garth Brooks — Ropin’ the Wind"),
  ...album('Garth Brooks — The Chase'),
  ...album('Dolly Parton — Coat of Many Colors'),
  ...album('Dolly Parton — The Best of Dolly Parton'),
  ...album('Dolly Parton, Linda Ronstadt & Emmylou Harris — Trio'),
  ...album('Willie Nelson — Red Headed Stranger'),
  ...album('Willie Nelson — Stardust'),
  ...album('Randy Travis — Storms of Life'),
  ...album('Randy Travis — Forever and Ever... The Best of Randy Travis'),
  ...album('Chris Stapleton — Traveller'),
  ...album('Chris Stapleton — Starting Over'),
  ...album('Kacey Musgraves — Golden Hour'),
  ...album("Clint Black — Killin' Time"),
  ...album('Charley Pride — Country Charley Pride + Pride of Country Music'),
  ...album('Johnny Paycheck — Take This Job and Shove It'),
  ...album('Tyler Childers — Purgatory'),
  ...album('Colter Wall - Imaginary Appalachia'),
  ...album('Colter Wall - Songs of the Plains'),
  ...album('Beyoncé — COWBOY CARTER'),
]);

// ── 9. 100 AMAZING SONGS (individual track picks) ─────────────────────────
console.log('\n9. 100 Amazing Songs');

// Shorthand alias
const t = (albumKey, songName) => track(albumKey, songName);

const amazingSongs = [
  // ── ROCK ──────────────────────────────────────────────────────────────
  t('Led Zeppelin — [Led Zeppelin IV]',                                  'Stairway to Heaven'),
  t('Led Zeppelin — [Led Zeppelin IV]',                                  'Black Dog'),
  t('Fleetwood Mac — Rumours',                                           'The Chain'),
  t('Fleetwood Mac — Rumours',                                           'Dreams'),
  t('Fleetwood Mac — Rumours',                                           'Go Your Own Way'),
  t('The Rolling Stones — Let It Bleed',                                 'Gimme Shelter'),
  t('The Rolling Stones — Let It Bleed',                                 "You Can't Always Get What You Want"),
  t('The Rolling Stones — Sticky Fingers',                               'Wild Horses'),
  t('The Rolling Stones — Exile on Main St',                             'Tumbling Dice'),
  t('David Bowie — The Rise and Fall of Ziggy Stardust and the Spiders From Mars', 'Ziggy Stardust'),
  t('David Bowie — The Rise and Fall of Ziggy Stardust and the Spiders From Mars', 'Starman'),
  t('Pearl Jam — Ten',                                                   'Black'),
  t('Pearl Jam — Ten',                                                   'Alive'),
  t('Pearl Jam — Ten',                                                   'Jeremy'),
  t('Nirvana — Nevermind (30th Anniversary Super Deluxe)',                'Smells Like Teen Spirit'),
  t('Nirvana — Nevermind (30th Anniversary Super Deluxe)',                'Come as You Are'),
  t('Nirvana — In Utero',                                                'Heart-Shaped Box'),
  t('The Clash — London Calling',                                        'London Calling'),
  t('Arcade Fire — Funeral',                                             'Wake Up'),
  t('Arcade Fire — Funeral',                                             'Rebellion (Lies)'),
  // ── HIP HOP ───────────────────────────────────────────────────────────
  t('Kendrick Lamar — DAMN',                                             'HUMBLE.'),
  t('Kendrick Lamar — To Pimp a Butterfly',                              'Alright'),
  t('Kendrick Lamar — To Pimp a Butterfly',                              'King Kunta'),
  t('Kendrick Lamar — good kid, m.A.A.d city',                           'Money Trees'),
  t('Kendrick Lamar — GNX',                                              'luther'),
  t('Nas — Illmatic',                                                    'N.Y. State of Mind'),
  t('Nas — Illmatic',                                                    'The World Is Yours'),
  t('A Tribe Called Quest — The Low End Theory',                         'Check the Rhime'),
  t('A Tribe Called Quest — Midnight Marauders',                         'Electric Relaxation'),
  t('Dr. Dre — The Chronic',                                             "Nuthin' but a G Thang"),
  t('Snoop Doggy Dogg — Doggystyle',                                     'Gin and Juice'),
  t('2Pac — All Eyez on Me',                                             'California Love'),
  t('Fugees — The Score',                                                'Killing Me Softly With His Song'),
  t('Fugees — The Score',                                                'Ready or Not'),
  t('Lauryn Hill — The Miseducation of Lauryn Hill',                     'Doo Wop (That Thing)'),
  t('Lauryn Hill — The Miseducation of Lauryn Hill',                     'Ex-Factor'),
  t("Ice Cube — AmeriKKKa’s Most Wanted",                           "AmeriKKKa's Most Wanted"),
  t('Kanye West — My Beautiful Dark Twisted Fantasy',                    'Runaway'),
  t('Kanye West — My Beautiful Dark Twisted Fantasy',                    'Power'),
  // ── REGGAE ────────────────────────────────────────────────────────────
  t('Bob Marley & The Wailers — Legend (Deluxe Edition)',                'No Woman, No Cry'),
  t('Bob Marley & The Wailers — Uprising',                               'Redemption Song'),
  t('Bob Marley & The Wailers — Legend (Deluxe Edition)',                'One Love'),
  t('Bob Marley & The Wailers — Exodus (Remastered Bonus Track Version)', 'Exodus'),
  t('Bob Marley & The Wailers — Exodus (Remastered Bonus Track Version)', 'Jamming'),
  t("Damian Jr. Gong Marley — Welcome to Jamrock",                       'Welcome to Jamrock'),
  t("Buju Banton — 'Til Shiloh",                                         'Wanna Be Loved'),
  // ── SOUL / R&B ────────────────────────────────────────────────────────
  t("Marvin Gaye — What’s Going On",                                "What's Going On"),
  t("Marvin Gaye — What’s Going On",                                'Mercy Mercy Me'),
  t("D’Angelo — Voodoo",                                            'Untitled (How Does It Feel)'),
  t('Michael Jackson — Thriller',                                        'Billie Jean'),
  t('Michael Jackson — Thriller',                                        'Beat It'),
  t('Michael Jackson — Off the Wall',                                    "Don't Stop 'Til You Get Enough"),
  t('Anderson .Paak — Malibu',                                           'Come Down'),
  // ── FOLK / AMERICANA ──────────────────────────────────────────────────
  t('Bob Dylan — Blood on the Tracks',                                   'Tangled Up in Blue'),
  t('Bob Dylan — Blood on the Tracks',                                   'Idiot Wind'),
  t('John Prine — John Prine',                                           'Angel from Montgomery'),
  t('John Prine — John Prine',                                           'Sam Stone'),
  t('Joni Mitchell — Blue',                                              'A Case of You'),
  t('Joni Mitchell — Blue',                                              'River'),
  t("Grateful Dead — Workingman’s Dead",                            "Uncle John's Band"),
  t('Sufjan Stevens — Illinois',                                         'Come On! Feel the Illinoise!'),
  t('Carole King — Tapestry',                                            'I Feel the Earth Move'),
  t('Carole King — Tapestry',                                            "It's Too Late"),
  t('Lucinda Williams — Car Wheels on a Gravel Road',                    'Right in Time'),
  t('Tyler Childers — Purgatory',                                        'Feathered Indians'),
  // ── COUNTRY ───────────────────────────────────────────────────────────
  t('Johnny Cash — American IV  The Man Comes Around',                   'Hurt'),
  t('Johnny Cash — At Folsom Prison',                                    'Folsom Prison Blues'),
  t('Hank Williams — 40 Greatest Hits',                                  "I'm So Lonesome I Could Cry"),
  t('Hank Williams — 40 Greatest Hits',                                  "Your Cheatin' Heart"),
  t('George Strait — 50 Number Ones',                                    "All My Ex's Live in Texas"),
  t('Garth Brooks — No Fences',                                          'Friends in Low Places'),
  t('Willie Nelson — Stardust',                                          'Georgia on My Mind'),
  t('Willie Nelson — Red Headed Stranger',                               'Blue Eyes Crying in the Rain'),
  t('Dolly Parton — Coat of Many Colors',                                'Coat of Many Colors'),
  t('Chris Stapleton — Traveller',                                       'Tennessee Whiskey'),
  t('Kacey Musgraves — Golden Hour',                                     'Rainbow'),
  t('Kacey Musgraves — Golden Hour',                                     'Butterflies'),
  t('Tyler Childers — Live on Red Barn Radio I & II',                    'Whitehouse Road'),
  // ── JAZZ ──────────────────────────────────────────────────────────────
  t('Miles Davis — Kind of Blue',                                        'So What'),
  t('Miles Davis — Kind of Blue',                                        'Blue in Green'),
  t('Miles Davis — Kind of Blue',                                        'All Blues'),
  // ── CLASSIC / TIMELESS ────────────────────────────────────────────────
  t('George Harrison — All Things Must Pass',                            'My Sweet Lord'),
  t('George Harrison — All Things Must Pass',                            'What Is Life'),
  t('John Lennon — Lennon Legend  The Very Best of John Lennon',         'Imagine'),
  t('Amy Winehouse — Back to Black',                                     'Rehab'),
  t('Amy Winehouse — Back to Black',                                     'Back to Black'),
  t('Amy Winehouse — Back to Black',                                     'Love Is a Losing Game'),
  t('Jack Johnson — In Between Dreams',                                  'Better Together'),
  t('Jack Johnson — In Between Dreams',                                  'Banana Pancakes'),
  t("Jimmy Buffett — Songs You Know by Heart  Jimmy Buffett’s Greatest Hit(s)", 'Margaritaville'),
  // ── MODERN ────────────────────────────────────────────────────────────
  t("Taylor Swift — Red (Taylor’s version)",                        'All Too Well'),
  t("Harry Styles — Harry’s House",                                 'As It Was'),
  t('Harry Styles — Fine Line',                                          'Watermelon Sugar'),
  t('Ed Sheeran — ×',                                               'Thinking Out Loud'),
  t('Ed Sheeran — ÷',                                               'Shape of You'),
  t('Sublime — Sublime',                                                 'What I Got'),
  t('Sublime — Greatest Hits',                                           'Santeria'),
  t('John Denver — The John Denver Collection',                          'Take Me Home, Country Roads'),
  t('Fleetwood Mac — Rumours',                                           'Gold Dust Woman'),
].filter(Boolean);

writeM3U('100 Amazing Songs', amazingSongs);

console.log('\n✅ All done! Playlists saved to: ' + PLAYLISTS_DIR);
console.log('   Push them to your HiBy using the Playlists page in HiBy Hub.\n');
