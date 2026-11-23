'use strict';

// Usage: node src/cli/migrate.js   (called by ./scripts/migrate.sh)
const { runMigrations } = require('../migrate');

runMigrations()
  .then((r) => {
    console.log(`[migrate] OK: schema ready (${r.tables} tables).`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(`[migrate] ERROR: ${err.message}`);
    process.exit(1);
  });
