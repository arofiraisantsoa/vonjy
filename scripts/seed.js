'use strict';

// Données fictives pour la démonstration. Usage : node --env-file=.env scripts/seed.js
const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { createService } = require('../src/service');
const { normalizePhone } = require('../src/sms');

function seed(db, cfg, { now = new Date() } = {}) {
  const p = (n) => normalizePhone(n, cfg.countryCode);
  const fk = db.prepare('INSERT INTO fokontany (name) VALUES (?)');
  const tanambao = Number(fk.run('Tanambao').lastInsertRowid);
  const ankilibe = Number(fk.run('Ankilibe').lastInsertRowid);

  const m = db.prepare('INSERT INTO members (fokontany_id, name, phone, role, family, validated_by) VALUES (?, ?, ?, ?, ?, ?)');
  m.run(tanambao, 'Voahangy (chef fokontany)', p('0340000100'), 'chef', null, 'commune');
  const patrols = [
    ['Rado', '0340000101', 'A'], ['Hery', '0340000102', 'B'], ['Fidy', '0340000103', 'C'],
    ['Tiana', '0340000104', 'D'], ['Njaka', '0340000105', 'D'], ['Mamy', '0340000106', 'E'],
    ['Lova', '0340000107', 'F'],
  ];
  for (const [name, phone, fam] of patrols) m.run(tanambao, name, p(phone), 'patrol', fam, 'Voahangy');
  m.run(ankilibe, 'Rakoto (chef fokontany)', p('0340000200'), 'chef', null, 'commune');

  const r = db.prepare('INSERT INTO residents (fokontany_id, name, phone, address, sector) VALUES (?, ?, ?, ?, ?)');
  const c = db.prepare('INSERT INTO contacts (resident_id, name, phone) VALUES (?, ?, ?)');
  const hanta = r.run(tanambao, 'Hanta R.', p('0340000001'), 'Lot 12, Tanambao Avaratra', 'Nord').lastInsertRowid;
  c.run(hanta, 'Soa (soeur)', p('0340000011'));
  c.run(hanta, 'Andry (voisin)', p('0340000012'));
  const naivo = r.run(tanambao, 'Naivo T.', p('0340000002'), 'Lot 40, Tanambao Atsimo', 'Sud').lastInsertRowid;
  c.run(naivo, 'Fara (épouse)', p('0340000021'));

  const svc = createService({ db, sms: { send: async () => ({ ok: true }) }, cfg });
  const night = svc.currentNight(now);
  const plan = svc.drawShifts({ fokontanyId: tanambao, night, sectors: ['Nord', 'Sud'], actor: 'seed', now });
  return { tanambao, ankilibe, plan };
}

if (require.main === module) {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  if (db.prepare('SELECT COUNT(*) n FROM fokontany').get().n > 0) {
    console.log('La base contient déjà des données : rien n\'a été ajouté.');
  } else {
    const out = seed(db, cfg);
    console.log('Données de démonstration ajoutées. Planning de cette nuit :');
    for (const pr of out.plan.pairs) console.log(`  ${pr.sector} : ${pr.members.map((x) => x.name).join(' et ')}`);
    console.log(`  Réserve : ${out.plan.reserve.name}`);
  }
  db.close();
}

module.exports = { seed };
