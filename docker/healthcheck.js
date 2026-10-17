'use strict';
const http = require('node:http');
const req = http.get({ host: '127.0.0.1', port: process.env.PORT || 3000, path: '/health', timeout: 3000 }, (res) => {
  let body = '';
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    try { process.exit(res.statusCode === 200 && JSON.parse(body).ok === true ? 0 : 1); }
    catch { process.exit(1); }
  });
});
req.on('timeout', () => req.destroy(new Error('health timeout')));
req.on('error', () => process.exit(1));
