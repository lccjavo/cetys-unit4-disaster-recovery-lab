'use strict';

// Usage: node src/cli/seed.js   (called by ./scripts/seed.sh)
const { db } = require('../db');
const { runSeed } = require('../seed');

(async () => {
  const info = await db.probe();
  if (!info) throw new Error(`PostgreSQL is not responding at ${db.target}: ${db.health.lastError}`);
  console.log(`[seed] PostgreSQL OK: ${db.target} (${info.cluster_name}, PostgreSQL ${info.pg_version})`);
  const r = await runSeed();
  if (r.skipped) console.log('[seed] OK: no data needed to be generated (idempotent operation).');
  else console.log('[seed] OK: fictional data and keys initialized.');
  process.exit(0);
})().catch((err) => {
  console.error(`[seed] ERROR: ${err.message}`);
  process.exit(1);
});
