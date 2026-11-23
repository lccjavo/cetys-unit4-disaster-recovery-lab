'use strict';

/**
 * SQL migration runner (idempotent).
 *
 * 1. Creates or updates the hotel_app (application) and lab_reader (read-only, DBeaver) roles.
 * 2. Applies, in order, the migrations/NNN_*.sql files not yet listed in schema_migrations.
 * 3. Re-applies privileges (GRANT) on every run so new tables are covered.
 *
 * It never drops tables or data. It connects with the PostgreSQL administrator account.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const cfg = require('./config');
const { readTargetFile } = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`Invalid identifier: ${s}`);
  return s;
};
const literal = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function ensureRole(client, name, password, { readOnly = false } = {}) {
  const role = ident(name);
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (exists.rowCount === 0) {
    await client.query(`CREATE ROLE ${role} LOGIN PASSWORD ${literal(password)}`);
  } else {
    await client.query(`ALTER ROLE ${role} LOGIN PASSWORD ${literal(password)}`);
  }
  if (readOnly) await client.query(`ALTER ROLE ${role} SET default_transaction_read_only = on`);
  return exists.rowCount === 0 ? 'created' : 'updated';
}

async function applyGrants(client) {
  const dbName = ident(cfg.db.database);
  const app = ident(cfg.db.user);
  const reader = ident(cfg.dbReader.user);
  const statements = [
    `REVOKE ALL ON DATABASE ${dbName} FROM PUBLIC`,
    `GRANT CONNECT, TEMPORARY ON DATABASE ${dbName} TO ${app}`,
    `GRANT CONNECT ON DATABASE ${dbName} TO ${reader}`,
    `GRANT USAGE ON SCHEMA public TO ${app}, ${reader}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${app}`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${app}`,
    `REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM ${app}`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${reader}`,
    `REVOKE ALL ON schema_migrations FROM ${reader}`,
    `GRANT pg_monitor TO ${app}, ${reader}`,
    `GRANT EXECUTE ON FUNCTION pg_control_system() TO ${app}, ${reader}`,
    `GRANT EXECUTE ON FUNCTION pg_control_checkpoint() TO ${app}, ${reader}`,
  ];
  for (const sql of statements) await client.query(sql);
}

async function runMigrations({ host, log = console.log } = {}) {
  const target = host || readTargetFile() || cfg.db.host;
  const client = new Client({
    host: target,
    port: cfg.db.port,
    database: cfg.db.database,
    user: cfg.dbAdmin.user,
    password: cfg.dbAdmin.password,
    connectionTimeoutMillis: 5000,
    application_name: 'hotel-migrate',
  });
  await client.connect();
  try {
    const rec = await client.query('SELECT pg_is_in_recovery() AS r');
    if (rec.rows[0].r) throw new Error(`Server ${target} is in recovery/standby mode; migrations are applied on the primary.`);

    await client.query('SELECT pg_advisory_lock(424201)');
    log(`[migrate] Server: ${target}  Database: ${cfg.db.database}`);

    const appRole = await ensureRole(client, cfg.db.user, cfg.db.password);
    const readerRole = await ensureRole(client, cfg.dbReader.user, cfg.dbReader.password, { readOnly: true });
    log(`[migrate] Role ${cfg.db.user}: ${appRole}; role ${cfg.dbReader.user} (read-only): ${readerRole}`);

    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now())`);

    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    const applied = new Map((await client.query('SELECT filename, checksum FROM schema_migrations')).rows.map((r) => [r.filename, r.checksum]));
    let count = 0;
    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      if (applied.has(file)) {
        if (applied.get(file) !== checksum) log(`[migrate] WARNING: ${file} changed after it was applied; it is not re-applied.`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
      log(`[migrate] Applied ${file}`);
      count += 1;
    }
    await applyGrants(client);
    const tables = await client.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    log(`[migrate] New migrations: ${count}; already applied: ${files.length - count}; tables in public: ${tables.rows[0].n}`);
    await client.query('SELECT pg_advisory_unlock(424201)');
    return { applied: count, total: files.length, tables: tables.rows[0].n };
  } finally {
    await client.end();
  }
}

module.exports = { runMigrations };
