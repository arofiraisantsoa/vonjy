'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fokontany (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

-- Habitants inscrits : l'adresse remplace la position GPS pour les téléphones basiques.
CREATE TABLE IF NOT EXISTS residents (
  id INTEGER PRIMARY KEY,
  fokontany_id INTEGER NOT NULL REFERENCES fokontany(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  address TEXT NOT NULL,
  sector TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Proches choisis par l'habitant, prévenus à chaque alerte.
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  resident_id INTEGER NOT NULL REFERENCES residents(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL
);

-- Membres du comité et chef fokontany. family sert à ne jamais mettre deux proches en binôme.
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  fokontany_id INTEGER NOT NULL REFERENCES fokontany(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('patrol','chef')),
  family TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  validated_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Planning : un binôme par secteur et une réserve par nuit.
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY,
  fokontany_id INTEGER NOT NULL REFERENCES fokontany(id),
  night TEXT NOT NULL,              -- AAAA-MM-JJ, nuit qui commence ce jour-là
  sector TEXT NOT NULL,             -- nom du secteur, ou 'RESERVE'
  member_id INTEGER NOT NULL REFERENCES members(id),
  UNIQUE (fokontany_id, night, member_id)
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  fokontany_id INTEGER REFERENCES fokontany(id),
  resident_id INTEGER REFERENCES residents(id),
  sender_phone TEXT NOT NULL,
  sector TEXT,
  status TEXT NOT NULL CHECK (status IN ('open','escalated','acked','closed','cancelled')),
  created_at TEXT NOT NULL,
  acked_by INTEGER REFERENCES members(id),
  acked_at TEXT,
  escalated_at TEXT,
  esc_level INTEGER NOT NULL DEFAULT 0,
  closed_at TEXT,
  outcome TEXT
);

-- Qui a été prévenu pour quelle alerte (sert à attribuer les « OK »).
CREATE TABLE IF NOT EXISTS alert_recipients (
  alert_id INTEGER NOT NULL REFERENCES alerts(id),
  phone TEXT NOT NULL,
  member_id INTEGER REFERENCES members(id),
  kind TEXT NOT NULL,               -- patrol, reserve, chef, contact
  notified_at TEXT NOT NULL,
  PRIMARY KEY (alert_id, phone)
);

-- Journal d'audit chaîné : chaque ligne contient l'empreinte de la précédente.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  alert_id INTEGER,
  actor TEXT,
  detail TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

-- Remises aux forces de l'ordre : jamais modifiables.
CREATE TABLE IF NOT EXISTS handovers (
  id INTEGER PRIMARY KEY,
  alert_id INTEGER REFERENCES alerts(id),
  at TEXT NOT NULL,
  unit TEXT NOT NULL,
  agent TEXT NOT NULL,
  witness1 TEXT NOT NULL,
  witness2 TEXT NOT NULL,
  notes TEXT
);

-- Suite donnée après la remise (poursuite, libération...) : ajout seulement.
CREATE TABLE IF NOT EXISTS handover_followups (
  id INTEGER PRIMARY KEY,
  handover_id INTEGER NOT NULL REFERENCES handovers(id),
  at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('poursuivi','libere','inconnu','revu_dans_le_quartier')),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  phone TEXT NOT NULL,
  text TEXT NOT NULL,
  alert_id INTEGER,
  status TEXT NOT NULL,             -- sent, dry_run, failed
  error TEXT
);

CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY,
  gateway_message_id TEXT UNIQUE,
  at TEXT NOT NULL,
  sender TEXT NOT NULL,
  text TEXT NOT NULL
);

-- Ajout seulement : toute modification ou suppression est refusée par la base elle-même.
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log est en ajout seulement'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log est en ajout seulement'); END;
CREATE TRIGGER IF NOT EXISTS handovers_no_update BEFORE UPDATE ON handovers
BEGIN SELECT RAISE(ABORT, 'handovers est en ajout seulement'); END;
CREATE TRIGGER IF NOT EXISTS handovers_no_delete BEFORE DELETE ON handovers
BEGIN SELECT RAISE(ABORT, 'handovers est en ajout seulement'); END;
CREATE TRIGGER IF NOT EXISTS followups_no_update BEFORE UPDATE ON handover_followups
BEGIN SELECT RAISE(ABORT, 'handover_followups est en ajout seulement'); END;
CREATE TRIGGER IF NOT EXISTS followups_no_delete BEFORE DELETE ON handover_followups
BEGIN SELECT RAISE(ABORT, 'handover_followups est en ajout seulement'); END;
`;

const GENESIS = '0'.repeat(64);

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

function hashEntry(prevHash, e) {
  const canon = JSON.stringify([e.at, e.type, e.alert_id ?? null, e.actor ?? null, e.detail]);
  return crypto.createHash('sha256').update(prevHash + canon).digest('hex');
}

function appendAudit(db, { at, type, alertId = null, actor = null, detail = {} }) {
  const last = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get();
  const prev = last ? last.hash : GENESIS;
  const entry = { at, type, alert_id: alertId, actor, detail: JSON.stringify(detail) };
  const hash = hashEntry(prev, entry);
  db.prepare(`INSERT INTO audit_log (at, type, alert_id, actor, detail, prev_hash, hash)
              VALUES (@at, @type, @alert_id, @actor, @detail, @prev, @hash)`)
    .run({ ...entry, prev, hash });
  return hash;
}

// Recalcule toute la chaîne : une ligne modifiée hors de l'application casse la vérification.
function verifyAudit(db) {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id').all();
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev) return { ok: false, brokenAt: r.id, reason: 'prev_hash' };
    const h = hashEntry(prev, r);
    if (h !== r.hash) return { ok: false, brokenAt: r.id, reason: 'hash' };
    prev = r.hash;
  }
  return { ok: true, entries: rows.length, head: prev };
}

module.exports = { openDb, appendAudit, verifyAudit, GENESIS };
