'use strict';

// Toute la configuration passe par des variables d'environnement (voir .env.example).
function bool(v, def) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'oui', 'yes'].includes(String(v).toLowerCase());
}

function loadConfig(overrides = {}) {
  const env = process.env;
  const cfg = {
    port: Number(env.PORT || 3000),
    host: env.HOST || '0.0.0.0',
    dbPath: env.DB_PATH || './data/vonjy.db',
    // Jeton d'accès au tableau de bord du chef fokontany (à changer absolument).
    adminToken: env.ADMIN_TOKEN || '',
    // Passerelle SMS : application « SMS Gateway for Android » (sms-gate.app).
    gatewayUrl: (env.SMS_GATEWAY_URL || '').replace(/\/$/, ''),
    gatewayUser: env.SMS_GATEWAY_USER || '',
    gatewayPass: env.SMS_GATEWAY_PASS || '',
    // Clé de signature des webhooks (Settings > Webhooks > Signing Key dans l'application).
    webhookSigningKey: env.WEBHOOK_SIGNING_KEY || '',
    // Sans passerelle configurée, les SMS sortants sont seulement journalisés.
    smsDryRun: bool(env.SMS_DRY_RUN, !env.SMS_GATEWAY_URL),
    // Autorise /api/simulate/sms pour tester sans téléphone.
    simulation: bool(env.SIMULATION, false),
    ackTimeoutSeconds: Number(env.ACK_TIMEOUT_SECONDS || 180),
    cancelWindowSeconds: Number(env.CANCEL_WINDOW_SECONDS || 120),
    escalationCheckMs: Number(env.ESCALATION_CHECK_MS || 15000),
    countryCode: env.COUNTRY_CODE || '261',
    serviceNumber: env.SERVICE_NUMBER || '',
  };
  return Object.assign(cfg, overrides);
}

module.exports = { loadConfig };
