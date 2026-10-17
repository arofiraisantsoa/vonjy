'use strict';

const crypto = require('node:crypto');

// 034 12 345 67 → +261341234567 ; +261... et 261... restent identiques.
function normalizePhone(raw, countryCode = '261') {
  if (!raw) return '';
  let d = String(raw).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return '+' + d.slice(1).replace(/\D/g, '');
  if (d.startsWith('00')) return '+' + d.slice(2);
  if (d.startsWith(countryCode) && d.length > 10) return '+' + d;
  if (d.startsWith('0')) return '+' + countryCode + d.slice(1);
  return '+' + countryCode + d;
}

// Client de l'application « SMS Gateway for Android » : POST /3rdparty/v1/messages en Basic Auth.
function createSmsClient(cfg, db, logger = console) {
  const insert = db.prepare(`INSERT INTO outbox (at, phone, text, alert_id, status, error)
                             VALUES (?, ?, ?, ?, ?, ?)`);

  async function send(phone, text, { alertId = null, now = new Date() } = {}) {
    const at = now.toISOString();
    if (cfg.smsDryRun) {
      insert.run(at, phone, text, alertId, 'dry_run', null);
      logger.info?.(`[SMS simulé] → ${phone} : ${text}`);
      return { ok: true, dryRun: true };
    }
    try {
      const auth = Buffer.from(`${cfg.gatewayUser}:${cfg.gatewayPass}`).toString('base64');
      const res = await fetch(`${cfg.gatewayUrl}/3rdparty/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
        body: JSON.stringify({ phoneNumbers: [phone], textMessage: { text } }),
      });
      if (!res.ok) throw new Error(`passerelle HTTP ${res.status}`);
      insert.run(at, phone, text, alertId, 'sent', null);
      return { ok: true };
    } catch (err) {
      insert.run(at, phone, text, alertId, 'failed', String(err.message || err));
      logger.error?.(`Échec d'envoi SMS vers ${phone} : ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  return { send };
}

// Signature des webhooks : HMAC-SHA256(corps brut + X-Timestamp), hexadécimal, fenêtre ±5 min.
function verifyWebhookSignature({ key, rawBody, signature, timestamp, nowSec = Math.floor(Date.now() / 1000) }) {
  if (!key) return { ok: true, skipped: true };
  if (!signature || !timestamp) return { ok: false, reason: 'en-têtes de signature absents' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 300) return { ok: false, reason: 'horodatage hors fenêtre' };
  const expected = crypto.createHmac('sha256', key).update(rawBody + String(timestamp)).digest('hex');
  const a = Buffer.from(expected, 'hex');
  let b;
  try { b = Buffer.from(String(signature), 'hex'); } catch { return { ok: false, reason: 'signature illisible' }; }
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature invalide' };
  return { ok: true };
}

module.exports = { normalizePhone, createSmsClient, verifyWebhookSignature };
