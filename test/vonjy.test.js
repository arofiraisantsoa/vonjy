'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadConfig } = require('../src/config');
const { openDb, verifyAudit } = require('../src/db');
const { buildApp } = require('../src/app');
const { seed } = require('../scripts/seed');

const TOKEN = 'jeton-de-test-0123456789';
const T0 = new Date('2026-10-16T18:41:00Z'); // 21:41 à Madagascar
const at = (s) => new Date(T0.getTime() + s * 1000);
const P = (n) => '+261' + n.slice(1);

function setup(extra = {}) {
  const cfg = loadConfig({ dbPath: ':memory:', adminToken: TOKEN, smsDryRun: true, simulation: true,
    escalationCheckMs: 0, webhookSigningKey: 'cle-signature', ...extra });
  const db = openDb(':memory:');
  const { tanambao } = seed(db, cfg, { now: T0 });
  // Planning connu pour les tests : Rado + Hery au Nord, Tiana + Mamy au Sud, Fidy en réserve.
  const night = '2026-10-16';
  db.prepare('DELETE FROM shifts').run();
  const id = (name) => db.prepare('SELECT id FROM members WHERE name = ?').get(name).id;
  const ins = db.prepare('INSERT INTO shifts (fokontany_id, night, sector, member_id) VALUES (?, ?, ?, ?)');
  for (const [s, n] of [['Nord', 'Rado'], ['Nord', 'Hery'], ['Sud', 'Tiana'], ['Sud', 'Mamy'], ['RESERVE', 'Fidy']]) ins.run(tanambao, night, s, id(n));
  const app = buildApp(cfg, { db, logger: false });
  const outbox = (alertId) => db.prepare('SELECT phone, text FROM outbox WHERE alert_id IS ? ORDER BY id').all(alertId);
  return { app, db, cfg, svc: app.svc, outbox, tanambao, id };
}

test('VONJY prévient en même temps le binôme, le chef et les proches', async () => {
  const { svc, outbox } = setup();
  const r = await svc.onIncomingSms({ sender: '034 00 000 01', text: 'vonjy', now: T0 });
  const phones = outbox(r.alertId).map((o) => o.phone).sort();
  assert.deepEqual(phones, [P('0340000001'), P('0340000011'), P('0340000012'), P('0340000100'), P('0340000101'), P('0340000102')].sort());
  const toRado = outbox(r.alertId).find((o) => o.phone === P('0340000101'));
  assert.match(toRado.text, /Lot 12/);
});

test('Le premier OK prend l\'alerte, le second est informé', async () => {
  const { svc, db, outbox } = setup();
  const { alertId } = await svc.onIncomingSms({ sender: '0340000001', text: 'VONJY', now: T0 });
  const ack = await svc.onIncomingSms({ sender: '0340000101', text: 'ok', now: at(72) });
  assert.equal(ack.seconds, 72);
  assert.equal(db.prepare('SELECT status FROM alerts WHERE id = ?').get(alertId).status, 'acked');
  assert.ok(outbox(alertId).some((o) => o.phone === P('0340000001') && /Rado no ho tonga/.test(o.text)));
  const second = await svc.onIncomingSms({ sender: '0340000102', text: 'OK', now: at(80) });
  assert.ok(second.alreadyTakenBy);
});

test('Sans réponse, l\'alerte monte vers la réserve puis vers toute la patrouille', async () => {
  const { svc, db, outbox } = setup();
  const { alertId } = await svc.onIncomingSms({ sender: '0340000002', text: 'VONJY', now: T0 });
  assert.deepEqual(await svc.runEscalations(at(100)), []);
  const e1 = await svc.runEscalations(at(181));
  assert.deepEqual(e1, [{ alertId, level: 1 }]);
  assert.ok(outbox(alertId).some((o) => o.phone === P('0340000103') && /MAIKA/.test(o.text)));
  const e2 = await svc.runEscalations(at(362));
  assert.deepEqual(e2, [{ alertId, level: 2 }]);
  assert.ok(outbox(alertId).some((o) => o.phone === P('0340000107'))); // Lova, hors planning, prévenu au niveau 2
  const ack = await svc.onIncomingSms({ sender: '0340000103', text: 'OK', now: at(400) });
  assert.equal(ack.alertId, alertId);
  assert.equal(db.prepare('SELECT esc_level, status FROM alerts WHERE id = ?').get(alertId).status, 'acked');
});

test('Une fausse alerte s\'annule seulement dans le délai prévu', async () => {
  const { svc, db } = setup();
  const a = await svc.onIncomingSms({ sender: '0340000001', text: 'VONJY', now: T0 });
  const c = await svc.onIncomingSms({ sender: '0340000001', text: 'Foanana', now: at(60) });
  assert.equal(c.cancelled, true);
  assert.equal(db.prepare('SELECT status FROM alerts WHERE id = ?').get(a.alertId).status, 'cancelled');
  const b = await svc.onIncomingSms({ sender: '0340000002', text: 'VONJY', now: at(300) });
  const late = await svc.onIncomingSms({ sender: '0340000002', text: 'FOANANA', now: at(500) });
  assert.match(late.ignored, /dépassé/);
  assert.equal(db.prepare('SELECT status FROM alerts WHERE id = ?').get(b.alertId).status, 'open');
});

test('Un numéro inconnu alerte quand même le chef fokontany', async () => {
  const { svc, outbox } = setup();
  const r = await svc.onIncomingSms({ sender: '0329999999', text: 'VONJY', now: T0 });
  assert.equal(r.unknown, true);
  assert.ok(outbox(r.alertId).some((o) => o.phone === P('0340000100') && /0329999999|\+261329999999/.test(o.text)));
});

test('Le webhook refuse une signature invalide et accepte la bonne', async () => {
  const { app, db } = setup();
  const body = JSON.stringify({ event: 'sms:received', id: 'w1', payload: { messageId: 'm1', message: 'VONJY', sender: '+261340000001' } });
  const ts = String(Math.floor(Date.now() / 1000));
  const bad = await app.inject({ method: 'POST', url: '/webhooks/sms', headers: { 'content-type': 'application/json', 'x-timestamp': ts, 'x-signature': 'ab'.repeat(32) }, payload: body });
  assert.equal(bad.statusCode, 401);
  const sig = crypto.createHmac('sha256', 'cle-signature').update(body + ts).digest('hex');
  const good = await app.inject({ method: 'POST', url: '/webhooks/sms', headers: { 'content-type': 'application/json', 'x-timestamp': ts, 'x-signature': sig }, payload: body });
  assert.equal(good.statusCode, 200);
  const again = await app.inject({ method: 'POST', url: '/webhooks/sms', headers: { 'content-type': 'application/json', 'x-timestamp': ts, 'x-signature': sig }, payload: body });
  assert.equal(again.json().result.duplicate, true); // le même SMS livré deux fois ne crée qu'une alerte
  assert.equal(db.prepare('SELECT COUNT(*) n FROM alerts').get().n, 1);
});

test('Le journal d\'audit refuse toute modification et détecte une falsification', async () => {
  const { svc, db } = setup();
  await svc.onIncomingSms({ sender: '0340000001', text: 'VONJY', now: T0 });
  assert.equal(verifyAudit(db).ok, true);
  assert.throws(() => db.prepare("UPDATE audit_log SET detail = '{}' WHERE id = 1").run(), /ajout seulement/);
  assert.throws(() => db.prepare('DELETE FROM audit_log').run(), /ajout seulement/);
  db.exec('DROP TRIGGER audit_no_update');               // un administrateur malveillant contourne la base…
  db.prepare("UPDATE audit_log SET actor = 'quelqu-un' WHERE id = 1").run();
  assert.equal(verifyAudit(db).ok, false);                // …mais la chaîne d'empreintes le révèle
});

test('Le tirage ne met jamais deux membres d\'une même famille ensemble', () => {
  const { svc, tanambao, id } = setup();
  const tiana = id('Tiana'), njaka = id('Njaka');
  let seedN = 1;
  const rng = () => { seedN = (seedN * 16807) % 2147483647; return seedN / 2147483647; };
  for (let i = 0; i < 100; i++) {
    const plan = svc.drawShifts({ fokontanyId: tanambao, night: '2026-10-17', sectors: ['Nord', 'Sud'], rng, actor: 'test' });
    for (const pr of plan.pairs) {
      const ids = pr.members.map((m) => m.id).sort();
      assert.notDeepEqual(ids, [tiana, njaka].sort());
    }
  }
});

test('La remise exige deux témoins différents et reste non modifiable', async () => {
  const { svc, db } = setup();
  const { alertId } = await svc.onIncomingSms({ sender: '0340000001', text: 'VONJY', now: T0 });
  assert.throws(() => svc.addHandover({ alertId, unit: 'Brigade', agent: '0472', witness1: 'Rado', witness2: 'rado', actor: 't' }), /Deux témoins/);
  const h = svc.addHandover({ alertId, unit: 'Brigade', agent: '0472', witness1: 'Rado', witness2: 'Hery', actor: 't' });
  assert.throws(() => db.prepare('UPDATE handovers SET agent = ? WHERE id = ?').run('x', h.id), /ajout seulement/);
});

test('Des suspects remis puis revus dans le quartier sont signalés par unité', async () => {
  const { svc } = setup();
  for (let i = 0; i < 2; i++) {
    const h = svc.addHandover({ unit: 'Brigade X', agent: 'A1', witness1: 'Rado', witness2: 'Hery', actor: 't' });
    svc.addFollowup({ handoverId: h.id, status: 'libere', actor: 't' });
    svc.addFollowup({ handoverId: h.id, status: 'revu_dans_le_quartier', actor: 't' });
  }
  assert.deepEqual(svc.anomalies().filter((a) => a.type === 'remis_puis_revus'), [{ type: 'remis_puis_revus', unit: 'Brigade X', cas: 2 }]);
});

test('La vue de la commune ne contient ni nom ni adresse', async () => {
  const { app, svc } = setup();
  await svc.onIncomingSms({ sender: '0340000001', text: 'VONJY', now: T0 });
  const res = await app.inject({ method: 'GET', url: '/api/stats/weekly?from=2026-10-12&to=2026-10-19', headers: { authorization: `Bearer ${TOKEN}` } });
  const txt = res.body;
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(txt, /Hanta|Lot 12|\+261/);
  assert.equal(res.json().rows.find((r) => r.fokontany === 'Tanambao').incidents, 1);
});

test('L\'API refuse les appels sans jeton', async () => {
  const { app } = setup();
  const res = await app.inject({ method: 'GET', url: '/api/alerts' });
  assert.equal(res.statusCode, 401);
});
