'use strict';

/**
 * CLI de administracion del Key Vault. Se ejecuta DENTRO del contenedor key-vault
 * y habla con la API interna en 127.0.0.1:8200 usando el token de servicio.
 *
 *   node src/cli/admin.js status
 *   node src/cli/admin.js backup [motivo]
 *   node src/cli/admin.js backups
 *   node src/cli/admin.js restore <archivo|latest>
 *   node src/cli/admin.js access disable|enable
 *   node src/cli/admin.js outage enable|disable
 *   node src/cli/admin.js rotate
 */

const cfg = require('../config');

async function call(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${cfg.apiPort}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.serviceToken}`,
      'content-type': 'application/json',
      'x-client-service': 'vault-cli',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${json.error || res.status}: ${json.message || ''}`);
    err.exitCode = 1;
    throw err;
  }
  return json;
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  let out;
  switch (cmd) {
    case 'status':
      out = await call('GET', '/api/v1/status');
      break;
    case 'backup':
      out = await call('POST', '/api/v1/admin/backup', { reason: arg || 'cli' });
      break;
    case 'backups':
      out = await call('GET', '/api/v1/admin/backups');
      break;
    case 'restore': {
      let file = arg;
      if (!file || file === 'latest') {
        const { backups } = await call('GET', '/api/v1/admin/backups');
        if (!backups.length) throw new Error('No hay respaldos de KEK');
        file = backups[0].file;
      }
      out = await call('POST', '/api/v1/admin/restore', { file });
      break;
    }
    case 'access':
      out = await call('POST', '/api/v1/admin/access', { disabled: arg === 'disable' });
      break;
    case 'outage':
      out = await call('POST', '/api/v1/admin/outage', { enabled: arg === 'enable' });
      break;
    case 'rotate':
      out = await call('POST', '/api/v1/admin/rotate');
      break;
    default:
      console.error('Uso: admin.js status|backup|backups|restore|access|outage|rotate');
      process.exit(2);
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(err.exitCode || 1);
});
