'use strict';

/**
 * Key Vault administration CLI. It runs INSIDE the key-vault container
 * and talks to the internal API on 127.0.0.1:8200 using the service token.
 *
 *   node src/cli/admin.js status
 *   node src/cli/admin.js backup [reason]
 *   node src/cli/admin.js backups
 *   node src/cli/admin.js restore <file|latest>
 *   node src/cli/admin.js access disable|enable
 *   node src/cli/admin.js outage enable|disable
 *   node src/cli/admin.js rotate <CUS-0001|all>
 *   node src/cli/admin.js shred <CUS-0001>      (lab: crypto-shredding of one customer's KEKs)
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
        if (!backups.length) throw new Error('There are no KEK backups');
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
      if (!arg) throw new Error('Usage: admin.js rotate <CUS-0001|all>');
      out = await call('POST', '/api/v1/admin/rotate', arg === 'all' ? { all: true } : { owner: arg.toUpperCase() });
      break;
    case 'shred':
      if (!arg) throw new Error('Usage: admin.js shred <CUS-0001>');
      out = await call('POST', '/api/v1/admin/shred', { owner: arg.toUpperCase() });
      break;
    default:
      console.error('Usage: admin.js status|backup|backups|restore|access|outage|rotate <owner|all>|shred <owner>');
      process.exit(2);
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(err.exitCode || 1);
});
