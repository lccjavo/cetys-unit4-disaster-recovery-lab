'use strict';

// Uso: node src/cli/migrate.js   (lo invoca ./scripts/migrate.sh)
const { runMigrations } = require('../migrate');

runMigrations()
  .then((r) => {
    console.log(`[migrate] OK: esquema listo (${r.tables} tablas).`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(`[migrate] ERROR: ${err.message}`);
    process.exit(1);
  });
