// Write a consistent snapshot of the Hub database (safe while the Hub runs).
//   node deploy/backup-db.js <source.db> <snapshot.db>
'use strict';
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const [src, dst] = process.argv.slice(2);
if (!src || !dst) { console.error('usage: backup-db.js <source.db> <snapshot.db>'); process.exit(2); }
try { fs.unlinkSync(dst); } catch (_) {}
const db = new DatabaseSync(src);
db.exec('PRAGMA busy_timeout = 10000');
db.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`);
db.close();
console.log('snapshot written:', dst, fs.statSync(dst).size, 'bytes');
