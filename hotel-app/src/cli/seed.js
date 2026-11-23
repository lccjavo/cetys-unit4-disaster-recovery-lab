'use strict';

// Uso: node src/cli/seed.js   (lo invoca ./scripts/seed.sh)
const { db } = require('../db');
const { runSeed } = require('../seed');

(async () => {
  const info = await db.probe();
  if (!info) throw new Error(`PostgreSQL no responde en ${db.target}: ${db.health.lastError}`);
  console.log(`[seed] PostgreSQL OK: ${db.target} (${info.cluster_name}, PostgreSQL ${info.pg_version})`);
  const r = await runSeed();
  if (r.skipped) console.log('[seed] OK: no fue necesario generar datos (operacion idempotente).');
  else console.log('[seed] OK: datos ficticios y llaves inicializados.');
  process.exit(0);
})().catch((err) => {
  console.error(`[seed] ERROR: ${err.message}`);
  process.exit(1);
});
