'use strict';

/**
 * Status information for the dashboard, the security page and the recovery page.
 * Every query tolerates failures: if PostgreSQL or the Key Vault do not respond,
 * whatever could be collected is returned along with the corresponding error.
 */

const fs = require('node:fs');
const path = require('node:path');
const cfg = require('../config');
const { db, Database } = require('../db');
const vault = require('../vaultClient');
const { openFields, dekContext } = require('../crypto/envelope');
const { SENSITIVE_KEYS } = require('../fields');

async function safe(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err.code || 'ERROR', message: err.message };
  }
}

async function counts() {
  const { rows } = await db.query(`SELECT
      (SELECT count(*) FROM users)::int AS users,
      (SELECT count(*) FROM users WHERE role = 'customer')::int AS customer_users,
      (SELECT count(*) FROM customers)::int AS customers,
      (SELECT count(*) FROM reservations)::int AS reservations,
      (SELECT count(*) FROM reservations WHERE status IN ('confirmed', 'pending'))::int AS upcoming,
      (SELECT count(*) FROM customer_sensitive_data)::int AS encrypted_profiles,
      (SELECT count(*) FROM customer_keys)::int AS wrapped_deks,
      (SELECT value FROM lab_metadata WHERE key = 'seed_completed_at') AS seeded_at`);
  return rows[0];
}

async function dashboard() {
  const [c, recent, vaultHealth] = await Promise.all([
    safe(counts),
    safe(async () => (await db.query(
      `SELECT occurred_at, actor_username, action, target_type, target_id, outcome, details FROM audit_events ORDER BY occurred_at DESC LIMIT 8`,
    )).rows),
    vault.health(),
  ]);
  return { counts: c, recent, vault: vaultHealth, db: dbSnapshot() };
}

function dbSnapshot() {
  return { target: db.target, ...db.health, incidents: db.incidents.slice(0, 5) };
}

async function security() {
  const [kekUsage, schema, vaultStatus, sample] = await Promise.all([
    safe(async () => (await db.query('SELECT kek_id, count(*)::int AS customers FROM customer_keys GROUP BY kek_id ORDER BY kek_id')).rows),
    safe(async () => (await db.query(`SELECT
        (SELECT count(*) FROM customers)::int AS customers,
        (SELECT count(*) FROM customer_sensitive_data)::int AS encrypted_profiles,
        (SELECT count(*) FROM customer_keys)::int AS wrapped_deks,
        (SELECT count(DISTINCT dek_ref)::int FROM customer_keys) AS distinct_deks,
        (SELECT count(*) FROM customer_sensitive_data WHERE (SELECT count(*) FROM jsonb_object_keys(encrypted_fields)) = 20)::int AS complete_profiles,
        (SELECT count(*) FROM customers c WHERE NOT EXISTS (SELECT 1 FROM customer_keys k WHERE k.customer_id = c.id))::int AS customers_without_key,
        (SELECT pg_size_pretty(sum(pg_column_size(encrypted_fields))) FROM customer_sensitive_data) AS encrypted_size,
        (SELECT round(avg(pg_column_size(encrypted_fields)))::int FROM customer_sensitive_data) AS avg_encrypted_bytes,
        (SELECT round(avg(pg_column_size(c.*)))::int FROM customers c) AS avg_operational_row_bytes`)).rows[0]),
    safe(() => vault.status()),
    safe(async () => (await db.query(
      `SELECT c.id, c.customer_code, c.full_name, k.kek_id, k.dek_ref, LEFT(k.wrapped_dek, 28) AS wrapped_preview,
              LEFT(s.encrypted_fields -> 'phone_number' ->> 'ciphertext', 28) AS phone_ct
       FROM customers c JOIN customer_keys k ON k.customer_id = c.id JOIN customer_sensitive_data s ON s.customer_id = c.id
       ORDER BY c.id LIMIT 5`,
    )).rows),
  ]);
  return { kekUsage, schema, vaultStatus, sample, vaultHealth: await vault.health() };
}

function readJsonFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        } catch {
          return { name: f, error: 'unreadable' };
        }
      });
  } catch {
    return null;
  }
}

function walArchiveFiles() {
  try {
    const files = fs.readdirSync(cfg.paths.walArchive).filter((f) => /^[0-9A-F]{24}(\.partial|\.history|\.[0-9A-F]{8}\.backup)?$/.test(f));
    files.sort();
    const segments = files.filter((f) => /^[0-9A-F]{24}$/.test(f));
    let latestMtime = null;
    if (files.length) {
      const st = fs.statSync(path.join(cfg.paths.walArchive, files[files.length - 1]));
      latestMtime = st.mtime.toISOString();
    }
    return { available: true, count: files.length, segments: segments.length, latest: files[files.length - 1] || null, latestMtime, history: files.filter((f) => f.endsWith('.history')) };
  } catch (err) {
    return { available: false, error: err.code || err.message };
  }
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function controlFiles() {
  const restorePoints = readLines(path.join(cfg.paths.control, 'restore-points.log'))
    .map((l) => {
      const [at, name, lsn] = l.split('|');
      return { at, name, lsn };
    })
    .reverse();
  const targets = readLines(path.join(cfg.paths.control, 'db-target.log'))
    .map((l) => {
      const [at, from, to, actor, reason] = l.split('|');
      return { at, from, to, actor, reason };
    })
    .reverse()
    .slice(0, 10);
  const failovers = readLines(path.join(cfg.paths.control, 'failover.log'))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
  let lastRestore = null;
  try {
    lastRestore = JSON.parse(fs.readFileSync(path.join(cfg.paths.control, 'last-restore.json'), 'utf8'));
  } catch {
    /* no restores yet */
  }
  const fenced = fs.existsSync(path.join(cfg.paths.control, 'primary.fenced'));
  return { restorePoints, targets, failovers, lastRestore, fenced };
}

async function disasterRecovery() {
  const [candidates, archiver, c, verification] = await Promise.all([
    Promise.all(cfg.db.candidates.map((h) => Database.probeHost(h))),
    safe(async () => (await db.query(`SELECT current_setting('archive_mode') AS archive_mode, archived_count, last_archived_wal,
        last_archived_time, failed_count, last_failed_wal, last_failed_time, stats_reset FROM pg_stat_archiver`)).rows[0]),
    safe(counts),
    safe(async () => (await db.query('SELECT * FROM recovery_verifications ORDER BY verified_at DESC LIMIT 5')).rows),
  ]);
  const writable = candidates.filter((x) => x.reachable && !x.in_recovery);
  return {
    db: dbSnapshot(),
    candidates,
    splitBrainRisk: writable.length > 1,
    archiver,
    counts: c,
    verification,
    backups: readJsonFiles(path.join(cfg.paths.backups, 'catalog')),
    wal: walArchiveFiles(),
    control: controlFiles(),
    vault: await vault.health(),
  };
}

/** Verifies the state after a recovery: counts + decryption of a sample. */
async function verifyRecovery(sampleSize = 10) {
  const c = await counts();
  const { rows } = await db.query(
    `SELECT c.id, s.encrypted_fields, k.dek_ref, k.wrapped_dek, k.dek_wrap_nonce, k.dek_wrap_tag, k.kek_id
     FROM customers c JOIN customer_sensitive_data s ON s.customer_id = c.id JOIN customer_keys k ON k.customer_id = c.id
     ORDER BY random() LIMIT $1`,
    [sampleSize],
  );
  let ok = 0;
  const errors = {};
  for (const r of rows) {
    try {
      const v = await openFields(Number(r.id), r, r.encrypted_fields, SENSITIVE_KEYS);
      if (Object.keys(v).length === SENSITIVE_KEYS.length) ok += 1;
    } catch (err) {
      errors[err.code || 'ERROR'] = (errors[err.code || 'ERROR'] || 0) + 1;
    }
  }
  const outcome = rows.length && ok === rows.length ? 'success' : ok > 0 ? 'partial' : 'failed';
  const server = db.health.server ? db.health.server.cluster_name : db.target;
  const details = { target: db.target, errors, kek_ids: [...new Set(rows.map((r) => r.kek_id))] };
  await db.query(
    `INSERT INTO recovery_verifications (db_server, customers_count, reservations_count, sampled_customers, decrypted_ok, outcome, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [server, c.customers, c.reservations, rows.length, ok, outcome, JSON.stringify(details)],
  );
  return { outcome, customers: c.customers, reservations: c.reservations, sampled: rows.length, ok, errors, server };
}

/** Re-wraps the DEKs that do not use the active KEK (the DEK never leaves the Key Vault). */
async function rewrapAll() {
  const vs = await vault.status();
  const { rows } = await db.query(
    'SELECT customer_id, dek_ref, wrapped_dek, dek_wrap_nonce, dek_wrap_tag, kek_id FROM customer_keys WHERE kek_id <> $1 ORDER BY customer_id',
    [vs.active_kek_id],
  );
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const res = await vault.rewrap(
      batch.map((r) => ({ id: r.customer_id, kek_id: r.kek_id, wrapped_dek: r.wrapped_dek, nonce: r.dek_wrap_nonce, tag: r.dek_wrap_tag, context: dekContext(r.customer_id, r.dek_ref) })),
    );
    for (const item of res.results) {
      if (!item.ok) {
        failed += 1;
        continue;
      }
      await db.query(
        'UPDATE customer_keys SET wrapped_dek = $1, dek_wrap_nonce = $2, dek_wrap_tag = $3, kek_id = $4, rewrapped_at = now() WHERE customer_id = $5',
        [item.wrapped_dek, item.nonce, item.tag, item.kek_id, item.id],
      );
      ok += 1;
    }
  }
  return { activeKek: vs.active_kek_id, candidates: rows.length, ok, failed };
}

module.exports = { dashboard, security, disasterRecovery, verifyRecovery, rewrapAll, counts, dbSnapshot };
