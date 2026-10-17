'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const Fastify = require('fastify');
const { openDb, verifyAudit, appendAudit } = require('./db');
const { createSmsClient, verifyWebhookSignature, normalizePhone } = require('./sms');
const { createService } = require('./service');

function buildApp(cfg, { db: givenDb, logger = true } = {}) {
  const app = Fastify({ logger, bodyLimit: 64 * 1024 });
  const db = givenDb || openDb(cfg.dbPath);
  const sms = createSmsClient(cfg, db, app.log);
  const svc = createService({ db, sms, cfg, logger: app.log });
  app.decorate('db', db);
  app.decorate('svc', svc);

  // Garde le corps brut : la signature des webhooks se calcule dessus.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body;
    if (!body) return done(null, {});
    try { done(null, JSON.parse(body)); } catch (e) { e.statusCode = 400; done(e); }
  });

  app.register(require('@fastify/static'), { root: path.join(__dirname, '..', 'public'), prefix: '/' });

  // Toutes les routes /api exigent le jeton du chef fokontany.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (req.url.startsWith('/api/simulate/') && cfg.simulation && !cfg.adminToken) return;
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    const ok = cfg.adminToken && token.length === cfg.adminToken.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(cfg.adminToken));
    if (!ok) return reply.code(401).send({ error: 'Jeton d\'accès manquant ou invalide' });
  });

  app.setErrorHandler((err, req, reply) => {
    const code = err.statusCode || 500;
    if (code >= 500) req.log.error(err);
    reply.code(code).send({ error: code >= 500 ? 'Erreur interne' : err.message });
  });

  const actor = (req) => `tableau:${req.ip}`;

  // ---- Webhook de la passerelle SMS (événement sms:received) ----
  app.post('/webhooks/sms', async (req, reply) => {
    const v = verifyWebhookSignature({
      key: cfg.webhookSigningKey, rawBody: req.rawBody || '',
      signature: req.headers['x-signature'], timestamp: req.headers['x-timestamp'],
    });
    if (!v.ok) return reply.code(401).send({ error: v.reason });
    const b = req.body || {};
    if (b.event !== 'sms:received' || !b.payload) return { ignored: true };
    const result = await svc.onIncomingSms({
      sender: b.payload.sender, text: b.payload.message,
      gatewayMessageId: b.payload.messageId || b.id || null,
    });
    return { ok: true, result };
  });

  // ---- Simulation sans téléphone (désactivée par défaut) ----
  app.post('/api/simulate/sms', async (req, reply) => {
    if (!cfg.simulation) return reply.code(404).send({ error: 'Simulation désactivée' });
    const { from, text } = req.body || {};
    return svc.onIncomingSms({ sender: from, text });
  });
  app.get('/api/simulate/outbox', async (req, reply) => {
    if (!cfg.simulation) return reply.code(404).send({ error: 'Simulation désactivée' });
    return db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 50').all();
  });

  // ---- Alertes ----
  app.get('/api/alerts', async () => db.prepare(`
    SELECT a.*, r.name AS resident_name, r.address, m.name AS acked_by_name
    FROM alerts a LEFT JOIN residents r ON r.id = a.resident_id LEFT JOIN members m ON m.id = a.acked_by
    ORDER BY a.id DESC LIMIT 100`).all());

  app.get('/api/alerts/:id/events', async (req) =>
    db.prepare('SELECT id, at, type, actor, detail FROM audit_log WHERE alert_id = ? ORDER BY id').all(req.params.id)
      .map((e) => ({ ...e, detail: JSON.parse(e.detail) })));

  app.post('/api/alerts/:id/close', async (req) =>
    svc.closeAlert(Number(req.params.id), { actor: actor(req), outcome: req.body?.outcome || 'traite' }));

  // ---- Remises aux forces de l'ordre ----
  app.post('/api/handovers', async (req) => svc.addHandover({ ...req.body, actor: actor(req) }));
  app.get('/api/handovers', async () => db.prepare(`
    SELECT h.*, (SELECT status FROM handover_followups f WHERE f.handover_id = h.id ORDER BY f.id DESC LIMIT 1) AS suite
    FROM handovers h ORDER BY h.id DESC`).all());
  app.post('/api/handovers/:id/followups', async (req) =>
    svc.addFollowup({ handoverId: Number(req.params.id), status: req.body?.status, notes: req.body?.notes, actor: actor(req) }));

  // ---- Habitants, membres ----
  app.get('/api/fokontany', async () => db.prepare('SELECT * FROM fokontany ORDER BY name').all());
  app.post('/api/fokontany', async (req) => {
    const name = String(req.body?.name || '').trim();
    if (!name) throw Object.assign(new Error('name est obligatoire'), { statusCode: 400 });
    const r = db.prepare('INSERT INTO fokontany (name) VALUES (?)').run(name);
    appendAudit(db, { at: new Date().toISOString(), type: 'fokontany_added', actor: actor(req), detail: { fokontany: Number(r.lastInsertRowid), name } });
    return db.prepare('SELECT * FROM fokontany WHERE id = ?').get(r.lastInsertRowid);
  });
  app.get('/api/residents', async () => db.prepare('SELECT * FROM residents ORDER BY name').all());
  app.post('/api/residents', async (req) => {
    const { fokontanyId, name, phone, address, sector, contacts = [] } = req.body || {};
    if (!fokontanyId || !name || !phone || !address || !sector) {
      throw Object.assign(new Error('fokontanyId, name, phone, address et sector sont obligatoires'), { statusCode: 400 });
    }
    const tx = db.transaction(() => {
      const r = db.prepare('INSERT INTO residents (fokontany_id, name, phone, address, sector) VALUES (?, ?, ?, ?, ?)')
        .run(fokontanyId, name, normalizePhone(phone, cfg.countryCode), address, sector);
      for (const c of contacts.slice(0, 5)) {
        db.prepare('INSERT INTO contacts (resident_id, name, phone) VALUES (?, ?, ?)')
          .run(r.lastInsertRowid, c.name, normalizePhone(c.phone, cfg.countryCode));
      }
      return Number(r.lastInsertRowid);
    });
    const id = tx();
    appendAudit(db, { at: new Date().toISOString(), type: 'resident_added', actor: actor(req), detail: { resident: id } });
    return db.prepare('SELECT * FROM residents WHERE id = ?').get(id);
  });
  app.get('/api/members', async () => db.prepare('SELECT * FROM members ORDER BY role, name').all());
  app.post('/api/members', async (req) => {
    const { fokontanyId, name, phone, role = 'patrol', family = null, validatedBy } = req.body || {};
    if (!fokontanyId || !name || !phone || !validatedBy) {
      throw Object.assign(new Error('fokontanyId, name, phone et validatedBy sont obligatoires'), { statusCode: 400 });
    }
    const r = db.prepare('INSERT INTO members (fokontany_id, name, phone, role, family, validated_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(fokontanyId, name, normalizePhone(phone, cfg.countryCode), role, family, validatedBy);
    appendAudit(db, { at: new Date().toISOString(), type: 'member_added', actor: actor(req), detail: { member: Number(r.lastInsertRowid), validatedBy } });
    return db.prepare('SELECT * FROM members WHERE id = ?').get(r.lastInsertRowid);
  });
  // Révocation immédiate d'un membre exclu ou soupçonné.
  app.post('/api/members/:id/revoke', async (req) => {
    db.prepare('UPDATE members SET active = 0 WHERE id = ?').run(req.params.id);
    appendAudit(db, { at: new Date().toISOString(), type: 'member_revoked', actor: actor(req), detail: { member: Number(req.params.id), reason: req.body?.reason || '' } });
    return { ok: true };
  });

  // ---- Planning ----
  app.get('/api/shifts', async (req) => {
    const night = req.query.night || svc.currentNight(new Date());
    return { night, rows: db.prepare(`SELECT s.*, m.name FROM shifts s JOIN members m ON m.id = s.member_id
                                      WHERE s.night = ? ORDER BY s.fokontany_id, s.sector`).all(night) };
  });
  app.post('/api/shifts/draw', async (req) => {
    const { fokontanyId, sectors, night } = req.body || {};
    return svc.drawShifts({ fokontanyId, sectors, night: night || svc.currentNight(new Date()), actor: actor(req) });
  });
  app.post('/api/shifts/notify', async (req) => {
    const { fokontanyId, night } = req.body || {};
    return svc.notifyShifts({ fokontanyId, night: night || svc.currentNight(new Date()) });
  });

  // ---- Vue de la commune, contrôles ----
  app.get('/api/stats/weekly', async (req) => {
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 7 * 86400000);
    return { from: from.toISOString(), to: to.toISOString(), rows: svc.weeklyStats({ from: from.toISOString(), to: to.toISOString() }) };
  });
  app.get('/api/anomalies', async () => svc.anomalies());
  app.get('/api/audit/verify', async () => verifyAudit(db));

  app.get('/health', async () => ({ ok: true }));

  // Relance automatique des alertes sans accusé de réception.
  let timer = null;
  app.addHook('onReady', async () => {
    if (cfg.escalationCheckMs > 0) {
      timer = setInterval(() => svc.runEscalations().catch((e) => app.log.error(e)), cfg.escalationCheckMs);
      timer.unref();
    }
  });
  app.addHook('onClose', async () => { clearInterval(timer); if (!givenDb) db.close(); });

  return app;
}

module.exports = { buildApp };
