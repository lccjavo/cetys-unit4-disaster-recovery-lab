'use strict';

/**
 * Ejecutor de migraciones SQL (idempotente).
 *
 * 1. Crea o actualiza los roles hotel_app (aplicacion) y lab_reader (solo lectura, DBeaver).
 * 2. Aplica en orden los archivos migrations/NNN_*.sql que no esten en schema_migrations.
 * 3. Reaplica permisos (GRANT) en cada ejecucion para cubrir tablas nuevas.
 *
 * Nunca borra tablas ni datos. Se conecta con la cuenta administradora de PostgreSQL.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const cfg = require('./config');
const { readTargetFile } = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`Identificador invalido: ${s}`);
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
  return exists.rowCount === 0 ? 'creado' : 'actualizado';
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
    if (rec.rows[0].r) throw new Error(`El servidor ${target} esta en modo recuperacion/standby; las migraciones se aplican en el primario.`);

    await client.query('SELECT pg_advisory_lock(424201)');
    log(`[migrate] Servidor: ${target}  Base: ${cfg.db.database}`);

    const appRole = await ensureRole(client, cfg.db.user, cfg.db.password);
    const readerRole = await ensureRole(client, cfg.dbReader.user, cfg.dbReader.password, { readOnly: true });
    log(`[migrate] Rol ${cfg.db.user}: ${appRole}; rol ${cfg.dbReader.user} (solo lectura): ${readerRole}`);

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
        if (applied.get(file) !== checksum) log(`[migrate] AVISO: ${file} cambio desde que se aplico; no se reaplica.`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Fallo la migracion ${file}: ${err.message}`);
      }
      log(`[migrate] Aplicada ${file}`);
      count += 1;
    }
    await applyGrants(client);
    const tables = await client.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    log(`[migrate] Migraciones nuevas: ${count}; ya aplicadas: ${files.length - count}; tablas en public: ${tables.rows[0].n}`);
    await client.query('SELECT pg_advisory_unlock(424201)');
    return { applied: count, total: files.length, tables: tables.rows[0].n };
  } finally {
    await client.end();
  }
}

module.exports = { runMigrations };
