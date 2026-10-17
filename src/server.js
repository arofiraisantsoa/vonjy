'use strict';

const { loadConfig } = require('./config');
const { buildApp } = require('./app');

const cfg = loadConfig();
if (!cfg.adminToken || cfg.adminToken.length < 16) {
  console.error('ADMIN_TOKEN doit être défini (16 caractères minimum). Voir .env.example.');
  process.exit(1);
}
if (!cfg.smsDryRun && !cfg.webhookSigningKey) {
  console.warn('Attention : WEBHOOK_SIGNING_KEY est vide, les webhooks ne sont pas vérifiés.');
}
const app = buildApp(cfg);
app.listen({ port: cfg.port, host: cfg.host }).then(() => {
  app.log.info(`Vonjy écoute sur ${cfg.host}:${cfg.port} (SMS ${cfg.smsDryRun ? 'simulés' : 'réels'})`);
}).catch((e) => { app.log.error(e); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.close().then(() => process.exit(0)));
