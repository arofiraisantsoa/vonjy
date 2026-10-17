'use strict';
const fs = require('node:fs');
const Database = require('better-sqlite3');
const source = process.env.DB_PATH || './data/vonjy.db';
const destination = process.argv[2];
if (!destination) throw new Error('Usage: node scripts/backup.js /chemin/sauvegarde.db');
if (fs.existsSync(destination)) throw new Error('Destination déjà existante');
const db = new Database(source, { readonly: true, fileMustExist: true });
(async () => {
  try { await db.backup(destination); console.log('Sauvegarde SQLite terminée.'); }
  finally { db.close(); }
})().catch((err) => { console.error(err.message); process.exitCode = 1; });
