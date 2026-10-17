'use strict';

const { appendAudit } = require('./db');
const { normalizePhone } = require('./sms');

// Textes envoyés par SMS, en malagasy (traduction en commentaire).
const T = {
  // « Alerte reçue. La patrouille et vos proches sont prévenus. Pour annuler une fausse alerte, envoyez FOANANA. »
  ackResident: () => 'Voaray ny fanairanao. Nampandrenesina ny mpiambina sy ny havanao. Raha diso: alefaso FOANANA.',
  // « ALERTE ! <nom>, <adresse>. Répondez OK si vous y allez. »
  alertPatrol: (r) => `FANAIRANA! ${r.name}, ${r.address}. Valio OK raha mandeha ianao.`,
  // « ALERTE de <nom>, <adresse>. La patrouille est prévenue. »
  alertContact: (r) => `FANAIRANA avy amin'i ${r.name}, ${r.address}. Nampandrenesina ny mpiambina.`,
  alertChef: (r, id) => `FANAIRANA #${id}: ${r.name}, ${r.address}, faritra ${r.sector}.`,
  // Numéro inconnu : le chef rappelle.
  alertChefUnknown: (phone, id) => `FANAIRANA #${id} avy amin'ny laharana tsy voasoratra: ${phone}. Antsoy azafady.`,
  unknownSender: () => 'Voaray ny fanairanao. Nampandrenesina ny filohan\'ny fokontany.',
  // « <membre> arrive. Restez à l'intérieur. »
  helpComing: (m) => `${m.name} no ho tonga. Mijanòna ao an-trano.`,
  // « <membre> a pris l'alerte #id en charge. »
  takenBy: (m, id) => `Fanairana #${id}: ${m.name} no mandeha.`,
  alreadyTaken: (m) => `Efa misy mandeha: ${m.name}. Misaotra.`,
  noOpenAlert: () => 'Tsy misy fanairana misokatra ho anao.',
  // Escalade : « Personne n'a répondu. Alerte #id : <nom>, <adresse>. Répondez OK. »
  escalation: (r, id) => `MAIKA! Tsy nisy namaly. Fanairana #${id}: ${r.name}, ${r.address}. Valio OK.`,
  escalationChef: (id, lvl) => `MAIKA! Fanairana #${id} mbola tsy voavaly (dingana ${lvl}).`,
  cancelled: (id) => `Fanairana #${id} foanana (diso).`,
  cancelledResident: () => 'Voafoana ny fanairanao.',
  closedResident: () => 'Vita ny raharaha. Misaotra anao.',
  shift: (sector, partner, night) => partner
    ? `Vonjy: miambina ianao alina ${night}, faritra ${sector}, miaraka amin'i ${partner}.`
    : `Vonjy: mpiambina tahiry (reserve) ianao alina ${night}.`,
  help: () => 'Vonjy: alefaso VONJY raha misy loza. OK raha mpiambina mandeha. FOANANA raha diso.',
};

function keyword(text) {
  const w = String(text || '').trim().split(/\s+/)[0] || '';
  return w.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]/g, '');
}

function createService({ db, sms, cfg, logger = console }) {
  const iso = (d) => d.toISOString();
  const tzMs = 3 * 3600 * 1000; // Madagascar : UTC+3, sans heure d'été

  // La nuit de garde porte la date de la soirée : avant midi, on est encore sur la nuit de la veille.
  function currentNight(now) {
    const local = new Date(now.getTime() + tzMs);
    if (local.getUTCHours() < 12) local.setUTCDate(local.getUTCDate() - 1);
    return local.toISOString().slice(0, 10);
  }

  const q = {
    residentByPhone: db.prepare('SELECT * FROM residents WHERE phone = ? AND active = 1'),
    memberByPhone: db.prepare('SELECT * FROM members WHERE phone = ? AND active = 1'),
    contacts: db.prepare('SELECT * FROM contacts WHERE resident_id = ?'),
    chefs: db.prepare("SELECT * FROM members WHERE fokontany_id = ? AND role = 'chef' AND active = 1"),
    anyChefs: db.prepare("SELECT * FROM members WHERE role = 'chef' AND active = 1"),
    shiftMembers: db.prepare(`SELECT m.* FROM shifts s JOIN members m ON m.id = s.member_id
                              WHERE s.fokontany_id = ? AND s.night = ? AND s.sector = ? AND m.active = 1`),
    allPatrol: db.prepare("SELECT * FROM members WHERE fokontany_id = ? AND role = 'patrol' AND active = 1"),
    alert: db.prepare('SELECT * FROM alerts WHERE id = ?'),
    recentOpenFrom: db.prepare(`SELECT * FROM alerts WHERE sender_phone = ? AND status IN ('open','escalated','acked')
                                ORDER BY id DESC LIMIT 1`),
    recipients: db.prepare('SELECT * FROM alert_recipients WHERE alert_id = ?'),
    addRecipient: db.prepare(`INSERT OR IGNORE INTO alert_recipients (alert_id, phone, member_id, kind, notified_at)
                              VALUES (?, ?, ?, ?, ?)`),
    pendingForPhone: db.prepare(`SELECT a.* FROM alerts a JOIN alert_recipients ar ON ar.alert_id = a.id
                                 WHERE ar.phone = ? AND ar.kind IN ('patrol','reserve')
                                   AND a.status IN ('open','escalated','acked')
                                 ORDER BY a.id DESC LIMIT 1`),
    inboxInsert: db.prepare('INSERT OR IGNORE INTO inbox (gateway_message_id, at, sender, text) VALUES (?, ?, ?, ?)'),
  };

  async function notify(alertId, people, text, kind, now) {
    for (const p of people) {
      const ins = q.addRecipient.run(alertId, p.phone, p.memberId ?? null, kind, iso(now));
      if (ins.changes === 0 && kind !== 'escalation') continue; // déjà prévenu pour cette alerte
      await sms.send(p.phone, text, { alertId, now });
    }
  }

  async function createAlert(sender, now) {
    const resident = q.residentByPhone.get(sender);
    // Évite les doublons : un deuxième VONJY pendant une alerte en cours la relance simplement.
    const existing = q.recentOpenFrom.get(sender);
    if (existing && existing.status !== 'acked') {
      appendAudit(db, { at: iso(now), type: 'alert_repeat', alertId: existing.id, actor: sender, detail: {} });
      await sms.send(sender, T.ackResident(), { alertId: existing.id, now });
      return { alertId: existing.id, repeated: true };
    }
    const night = currentNight(now);
    const info = db.prepare(`INSERT INTO alerts (fokontany_id, resident_id, sender_phone, sector, status, created_at)
                             VALUES (?, ?, ?, ?, 'open', ?)`)
      .run(resident?.fokontany_id ?? null, resident?.id ?? null, sender, resident?.sector ?? null, iso(now));
    const alertId = Number(info.lastInsertRowid);

    if (!resident) {
      appendAudit(db, { at: iso(now), type: 'alert_unknown_sender', alertId, actor: sender, detail: {} });
      const chefs = q.anyChefs.all().map((c) => ({ phone: c.phone, memberId: c.id }));
      await notify(alertId, chefs, T.alertChefUnknown(sender, alertId), 'chef', now);
      await sms.send(sender, T.unknownSender(), { alertId, now });
      return { alertId, unknown: true };
    }

    let patrol = q.shiftMembers.all(resident.fokontany_id, night, resident.sector);
    let patrolKind = 'patrol';
    if (patrol.length === 0) { // personne de garde sur ce secteur : la réserve part tout de suite
      patrol = q.shiftMembers.all(resident.fokontany_id, night, 'RESERVE');
      patrolKind = 'reserve';
    }
    const chefs = q.chefs.all(resident.fokontany_id);
    const contacts = q.contacts.all(resident.id);

    appendAudit(db, {
      at: iso(now), type: 'alert_created', alertId, actor: sender,
      detail: { resident: resident.id, sector: resident.sector, night,
        notified: { patrol: patrol.map((m) => m.id), chefs: chefs.map((m) => m.id), contacts: contacts.length } },
    });

    // Tout le monde est prévenu en même temps : personne n'est l'unique destinataire.
    await notify(alertId, patrol.map((m) => ({ phone: m.phone, memberId: m.id })), T.alertPatrol(resident), patrolKind, now);
    await notify(alertId, chefs.map((m) => ({ phone: m.phone, memberId: m.id })), T.alertChef(resident, alertId), 'chef', now);
    await notify(alertId, contacts.map((c) => ({ phone: c.phone })), T.alertContact(resident), 'contact', now);
    await sms.send(sender, T.ackResident(), { alertId, now });
    return { alertId };
  }

  async function acknowledge(sender, now) {
    const member = q.memberByPhone.get(sender);
    if (!member) return { ignored: 'expéditeur inconnu' };
    const alert = q.pendingForPhone.get(sender);
    if (!alert) { await sms.send(sender, T.noOpenAlert(), { now }); return { ignored: 'aucune alerte' }; }
    if (alert.status === 'acked') {
      const taker = db.prepare('SELECT * FROM members WHERE id = ?').get(alert.acked_by);
      await sms.send(sender, T.alreadyTaken(taker), { alertId: alert.id, now });
      appendAudit(db, { at: iso(now), type: 'ack_extra', alertId: alert.id, actor: sender, detail: { member: member.id } });
      return { alertId: alert.id, alreadyTakenBy: taker.id };
    }
    db.prepare("UPDATE alerts SET status = 'acked', acked_by = ?, acked_at = ? WHERE id = ?").run(member.id, iso(now), alert.id);
    const delay = Math.round((now - new Date(alert.created_at)) / 1000);
    appendAudit(db, { at: iso(now), type: 'alert_acked', alertId: alert.id, actor: sender, detail: { member: member.id, seconds: delay } });

    if (alert.resident_id) await sms.send(alert.sender_phone, T.helpComing(member), { alertId: alert.id, now });
    for (const r of q.recipients.all(alert.id)) {
      if (r.phone === sender || r.kind === 'contact') continue;
      await sms.send(r.phone, T.takenBy(member, alert.id), { alertId: alert.id, now });
    }
    return { alertId: alert.id, ackedBy: member.id, seconds: delay };
  }

  async function cancelBySender(sender, now) {
    const alert = q.recentOpenFrom.get(sender);
    if (!alert) return { ignored: 'aucune alerte' };
    const age = (now - new Date(alert.created_at)) / 1000;
    if (age > cfg.cancelWindowSeconds) {
      appendAudit(db, { at: iso(now), type: 'cancel_refused_late', alertId: alert.id, actor: sender, detail: { seconds: Math.round(age) } });
      return { ignored: 'délai d\'annulation dépassé' };
    }
    db.prepare("UPDATE alerts SET status = 'cancelled', closed_at = ?, outcome = 'fausse_alerte' WHERE id = ?").run(iso(now), alert.id);
    appendAudit(db, { at: iso(now), type: 'alert_cancelled', alertId: alert.id, actor: sender, detail: { seconds: Math.round(age) } });
    for (const r of q.recipients.all(alert.id)) await sms.send(r.phone, T.cancelled(alert.id), { alertId: alert.id, now });
    await sms.send(sender, T.cancelledResident(), { alertId: alert.id, now });
    return { alertId: alert.id, cancelled: true };
  }

  // Point d'entrée de chaque SMS reçu (webhook de la passerelle ou simulation).
  async function onIncomingSms({ sender, text, now = new Date(), gatewayMessageId = null }) {
    const phone = normalizePhone(sender, cfg.countryCode);
    if (gatewayMessageId) {
      const r = q.inboxInsert.run(gatewayMessageId, iso(now), phone, String(text || ''));
      if (r.changes === 0) return { duplicate: true };
    } else {
      q.inboxInsert.run(null, iso(now), phone, String(text || ''));
    }
    const kw = keyword(text);
    if (kw === 'VONJY' || kw === 'SOS') return createAlert(phone, now);
    if (kw === 'OK' || kw === 'ENY') return acknowledge(phone, now);
    if (kw === 'FOANANA' || kw === 'ANNULER') return cancelBySender(phone, now);
    await sms.send(phone, T.help(), { now });
    return { ignored: 'mot-clé inconnu', keyword: kw };
  }

  // À appeler régulièrement : relance les alertes sans accusé de réception.
  async function runEscalations(now = new Date()) {
    const limit = cfg.ackTimeoutSeconds * 1000;
    const pending = db.prepare("SELECT * FROM alerts WHERE status IN ('open','escalated')").all();
    const done = [];
    for (const a of pending) {
      const ref = a.esc_level === 0 ? new Date(a.created_at) : new Date(a.escalated_at);
      if (now - ref < limit || a.esc_level >= 2) continue;
      const level = a.esc_level + 1;
      db.prepare("UPDATE alerts SET status = 'escalated', esc_level = ?, escalated_at = ? WHERE id = ?").run(level, iso(now), a.id);
      const resident = a.resident_id ? db.prepare('SELECT * FROM residents WHERE id = ?').get(a.resident_id) : null;
      let targets = [];
      if (resident) {
        // Niveau 1 : la réserve. Niveau 2 : tous les patrouilleurs actifs du fokontany.
        const pool = level === 1
          ? q.shiftMembers.all(resident.fokontany_id, currentNight(new Date(a.created_at)), 'RESERVE')
          : q.allPatrol.all(resident.fokontany_id);
        targets = pool.map((m) => ({ phone: m.phone, memberId: m.id }));
        for (const t of targets) {
          q.addRecipient.run(a.id, t.phone, t.memberId, 'reserve', iso(now));
          await sms.send(t.phone, T.escalation(resident, a.id), { alertId: a.id, now });
        }
      }
      const chefs = resident ? q.chefs.all(resident.fokontany_id) : q.anyChefs.all();
      for (const c of chefs) await sms.send(c.phone, T.escalationChef(a.id, level), { alertId: a.id, now });
      if (resident) for (const c of q.contacts.all(resident.id)) await sms.send(c.phone, T.alertContact(resident), { alertId: a.id, now });
      appendAudit(db, { at: iso(now), type: 'alert_escalated', alertId: a.id, actor: 'systeme',
        detail: { level, notified: targets.map((t) => t.memberId) } });
      done.push({ alertId: a.id, level });
    }
    return done;
  }

  async function closeAlert(id, { actor, outcome = 'traite', now = new Date() }) {
    const a = q.alert.get(id);
    if (!a) throw Object.assign(new Error('Alerte introuvable'), { statusCode: 404 });
    if (a.status === 'closed' || a.status === 'cancelled') throw Object.assign(new Error('Alerte déjà close'), { statusCode: 409 });
    db.prepare("UPDATE alerts SET status = 'closed', closed_at = ?, outcome = ? WHERE id = ?").run(iso(now), outcome, id);
    appendAudit(db, { at: iso(now), type: 'alert_closed', alertId: id, actor, detail: { outcome } });
    if (a.resident_id) await sms.send(a.sender_phone, T.closedResident(), { alertId: id, now });
    return q.alert.get(id);
  }

  function addHandover({ alertId, unit, agent, witness1, witness2, notes = '', actor, now = new Date() }) {
    for (const [k, v] of Object.entries({ unit, agent, witness1, witness2 })) {
      if (!v || !String(v).trim()) throw Object.assign(new Error(`Champ obligatoire manquant : ${k}`), { statusCode: 400 });
    }
    if (witness1.trim().toLowerCase() === witness2.trim().toLowerCase()) {
      throw Object.assign(new Error('Deux témoins différents sont nécessaires'), { statusCode: 400 });
    }
    const r = db.prepare(`INSERT INTO handovers (alert_id, at, unit, agent, witness1, witness2, notes)
                          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(alertId ?? null, iso(now), unit, agent, witness1, witness2, notes);
    const id = Number(r.lastInsertRowid);
    appendAudit(db, { at: iso(now), type: 'handover', alertId: alertId ?? null, actor, detail: { handover: id, unit, agent, witness1, witness2 } });
    return db.prepare('SELECT * FROM handovers WHERE id = ?').get(id);
  }

  function addFollowup({ handoverId, status, notes = '', actor, now = new Date() }) {
    const h = db.prepare('SELECT * FROM handovers WHERE id = ?').get(handoverId);
    if (!h) throw Object.assign(new Error('Remise introuvable'), { statusCode: 404 });
    db.prepare('INSERT INTO handover_followups (handover_id, at, status, notes) VALUES (?, ?, ?, ?)').run(handoverId, iso(now), status, notes);
    appendAudit(db, { at: iso(now), type: 'handover_followup', alertId: h.alert_id, actor, detail: { handover: handoverId, status } });
    return { ok: true };
  }

  // Tirage du soir : binômes au hasard, jamais deux membres d'une même famille, une réserve.
  function drawShifts({ fokontanyId, night, sectors, rng = Math.random, actor, now = new Date() }) {
    const pool = q.allPatrol.all(fokontanyId);
    const need = sectors.length * 2 + 1;
    if (pool.length < need) throw Object.assign(new Error(`Il faut au moins ${need} patrouilleurs actifs (${pool.length} disponibles)`), { statusCode: 400 });
    for (let attempt = 0; attempt < 200; attempt++) {
      const s = pool.slice();
      for (let i = s.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [s[i], s[j]] = [s[j], s[i]]; }
      const pairs = sectors.map((sec, i) => ({ sector: sec, members: [s[2 * i], s[2 * i + 1]] }));
      const sameFamily = pairs.some((p) => p.members[0].family && p.members[0].family === p.members[1].family);
      if (sameFamily) continue;
      const reserve = s[sectors.length * 2];
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM shifts WHERE fokontany_id = ? AND night = ?').run(fokontanyId, night);
        const ins = db.prepare('INSERT INTO shifts (fokontany_id, night, sector, member_id) VALUES (?, ?, ?, ?)');
        for (const p of pairs) for (const m of p.members) ins.run(fokontanyId, night, p.sector, m.id);
        ins.run(fokontanyId, night, 'RESERVE', reserve.id);
      });
      tx();
      appendAudit(db, { at: iso(now), type: 'shifts_drawn', actor, detail: { fokontanyId, night,
        pairs: pairs.map((p) => ({ sector: p.sector, members: p.members.map((m) => m.id) })), reserve: reserve.id } });
      return { night, pairs: pairs.map((p) => ({ sector: p.sector, members: p.members.map((m) => ({ id: m.id, name: m.name })) })),
        reserve: { id: reserve.id, name: reserve.name } };
    }
    throw Object.assign(new Error('Impossible de former des binômes sans réunir deux membres d\'une même famille'), { statusCode: 400 });
  }

  async function notifyShifts({ fokontanyId, night, now = new Date() }) {
    const rows = db.prepare(`SELECT s.sector, m.id, m.name, m.phone FROM shifts s JOIN members m ON m.id = s.member_id
                             WHERE s.fokontany_id = ? AND s.night = ?`).all(fokontanyId, night);
    for (const r of rows) {
      const partner = rows.find((x) => x.sector === r.sector && x.id !== r.id && r.sector !== 'RESERVE');
      await sms.send(r.phone, T.shift(r.sector, partner?.name, night), { now });
    }
    return { notified: rows.length };
  }

  // Vue de la commune : totaux par fokontany, jamais d'adresse ni de nom.
  function weeklyStats({ from, to }) {
    return db.prepare(`SELECT f.name AS fokontany,
        SUM(CASE WHEN a.status != 'cancelled' THEN 1 ELSE 0 END) AS incidents,
        SUM(CASE WHEN a.status = 'cancelled' THEN 1 ELSE 0 END) AS fausses_alertes,
        SUM(CASE WHEN a.esc_level > 0 THEN 1 ELSE 0 END) AS escalades,
        ROUND(AVG(CASE WHEN a.acked_at IS NOT NULL
          THEN (julianday(a.acked_at) - julianday(a.created_at)) * 86400 END)) AS delai_moyen_s
      FROM fokontany f LEFT JOIN alerts a ON a.fokontany_id = f.id AND a.created_at >= ? AND a.created_at < ?
      GROUP BY f.id ORDER BY f.name`).all(from, to);
  }

  // Signaux à examiner par le chef fokontany ou la commune (jamais transmis à l'unité concernée).
  function anomalies({ since = '1970-01-01' } = {}) {
    const out = [];
    // 1. Patrouilleurs souvent de garde sur le secteur et la nuit d'un incident.
    const rows = db.prepare(`SELECT m.id, m.name, COUNT(*) AS n FROM alerts a
        JOIN shifts s ON s.fokontany_id = a.fokontany_id AND s.sector = a.sector
        JOIN members m ON m.id = s.member_id
        WHERE a.status != 'cancelled' AND a.created_at >= ?
          AND s.night = date(datetime(a.created_at, '+3 hours', '-12 hours'))
        GROUP BY m.id`).all(since);
    if (rows.length) {
      const avg = rows.reduce((s, r) => s + r.n, 0) / rows.length;
      for (const r of rows) if (r.n >= 3 && r.n >= 2 * avg) out.push({ type: 'garde_incidents', memberId: r.id, name: r.name, incidents: r.n, moyenne: Math.round(avg * 10) / 10 });
    }
    // 2. Alertes sans réponse du binôme de garde.
    const miss = db.prepare(`SELECT m.id, m.name, COUNT(*) AS n FROM alert_recipients ar
        JOIN alerts a ON a.id = ar.alert_id JOIN members m ON m.id = ar.member_id
        WHERE ar.kind = 'patrol' AND a.esc_level > 0 AND a.created_at >= ? GROUP BY m.id HAVING n >= 2`).all(since);
    for (const r of miss) out.push({ type: 'alertes_sans_reponse', memberId: r.id, name: r.name, fois: r.n });
    // 3. Suspects remis puis revus dans le quartier, par unité.
    const units = db.prepare(`SELECT h.unit, COUNT(DISTINCT h.id) AS n FROM handovers h
        JOIN handover_followups f ON f.handover_id = h.id
        WHERE f.status = 'revu_dans_le_quartier' AND h.at >= ? GROUP BY h.unit HAVING n >= 2`).all(since);
    for (const u of units) out.push({ type: 'remis_puis_revus', unit: u.unit, cas: u.n });
    return out;
  }

  return { onIncomingSms, runEscalations, closeAlert, addHandover, addFollowup, drawShifts, notifyShifts,
    weeklyStats, anomalies, currentNight, texts: T };
}

module.exports = { createService, keyword };
