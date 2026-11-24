'use strict';

/**
 * Installation verification (called by ./scripts/verify-setup.sh).
 * Prints PASS/FAIL for every check and exits with code 1 if any check fails.
 */

const cfg = require('../config');
const { db } = require('../db');
const vault = require('../vaultClient');
const { openFields } = require('../crypto/envelope');
const { SENSITIVE_KEYS } = require('../fields');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

(async () => {
  const info = await db.probe();
  check('PostgreSQL connection', Boolean(info), info ? `${db.target} / ${info.cluster_name} / PostgreSQL ${info.pg_version}${info.in_recovery ? ' / standby' : ''}` : db.health.lastError);
  if (!info) return finish();

  const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map((r) => r.table_name);
  const required = ['users', 'customers', 'customer_sensitive_data', 'customer_keys', 'reservations', 'audit_events'];
  const missing = required.filter((t) => !tables.includes(t));
  check('Database schema', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : required.join(', '));
  if (missing.length) return finish();

  const c = (await db.query(`SELECT
      (SELECT count(*) FROM users)::int AS users,
      (SELECT count(*) FROM customers)::int AS customers,
      (SELECT count(*) FROM customers WHERE is_seed)::int AS seed_customers,
      (SELECT count(*) FROM reservations)::int AS reservations,
      (SELECT count(*) FROM customer_keys)::int AS keys,
      (SELECT count(DISTINCT dek_ref)::int FROM customer_keys) AS distinct_deks,
      (SELECT count(*) FROM customer_sensitive_data WHERE (SELECT count(*) FROM jsonb_object_keys(encrypted_fields)) = 20)::int AS full_profiles,
      (SELECT value FROM lab_metadata WHERE key = 'seed_completed_at') AS seeded_at`)).rows[0];
  check('Initial data generated (seed)', Boolean(c.seeded_at), c.seeded_at ? `since ${c.seeded_at}` : 'run ./scripts/seed.sh');
  check(`Fictional seed customers = ${cfg.seed.customerCount}`, c.seed_customers === cfg.seed.customerCount, `seed: ${c.seed_customers}, total customers: ${c.customers}, users: ${c.users}, reservations: ${c.reservations}`);
  check('Every customer has 20 encrypted fields', c.full_profiles === c.customers && c.customers > 0, `${c.full_profiles}/${c.customers}`);
  check('Every customer has a unique wrapped DEK', c.keys === c.customers && c.distinct_deks === c.customers, `${c.keys} wrapped DEKs, ${c.distinct_deks} distinct`);

  const malformed = (await db.query(`SELECT count(*)::int AS n FROM customer_sensitive_data s, jsonb_each(s.encrypted_fields) f
      WHERE NOT (f.value ? 'ciphertext' AND f.value ? 'nonce' AND f.value ? 'tag')
         OR length(decode(f.value->>'nonce', 'base64')) <> 12
         OR length(decode(f.value->>'tag', 'base64')) <> 16`)).rows[0].n;
  check('AES-256-GCM format (96-bit nonce, 128-bit tag)', malformed === 0, `${malformed} fields with an invalid format`);

  const vh = await vault.health({ fresh: true });
  check('Key Vault connection', vh.available, vh.available ? `status ${vh.vault_status}` : `${vh.error}: ${vh.message}`);
  check('Customer KEKs available in the Key Vault', Boolean(vh.available && vh.owner_count > 0), vh.available ? `${vh.owner_count} customers with a KEK, ${vh.kek_count} KEK versions` : 'Key Vault unavailable');

  // Each customer must point to ITS OWN KEK (kek-cus-0001-vN for CUS-0001), never to another customer's.
  const own = (await db.query(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE k.kek_id LIKE 'kek-' || lower(c.customer_code) || '-v%')::int AS own,
        count(DISTINCT k.kek_id)::int AS distinct_keks
      FROM customer_keys k JOIN customers c ON c.id = k.customer_id`)).rows[0];
  check('Every customer has its own KEK (kek_id matches the customer)', own.own === own.total && own.distinct_keks === own.total && own.total > 0, `${own.own}/${own.total} customers on their own KEK, ${own.distinct_keks} distinct kek_id`);

  if (vh.available) {
    const vs = await vault.status().catch(() => null);
    const known = new Set(vs ? vs.keks.map((k) => k.kek_id) : []);
    const used = (await db.query('SELECT DISTINCT kek_id FROM customer_keys ORDER BY kek_id')).rows;
    const unknown = used.filter((u) => !known.has(u.kek_id));
    check('Every kek_id in PostgreSQL exists in the Key Vault', unknown.length === 0, unknown.length ? `missing: ${unknown.slice(0, 5).map((u) => u.kek_id).join(', ')}${unknown.length > 5 ? ', ...' : ''}` : `${used.length} kek_id found`);
  }

  const rows = (await db.query(`SELECT c.id, c.customer_code, s.encrypted_fields, k.dek_ref, k.wrapped_dek, k.dek_wrap_nonce, k.dek_wrap_tag, k.kek_id
      FROM customers c JOIN customer_sensitive_data s ON s.customer_id = c.id JOIN customer_keys k ON k.customer_id = c.id ORDER BY c.id`)).rows;
  let ok = 0;
  let firstError = '';
  for (const r of rows) {
    try {
      const v = await openFields(Number(r.id), r, r.encrypted_fields, SENSITIVE_KEYS);
      if (Object.keys(v).length === 20) ok += 1;
    } catch (err) {
      if (!firstError) firstError = `${err.code}: ${err.message}`;
    }
  }
  check('End-to-end encryption and decryption', ok === rows.length && rows.length > 0, `${ok}/${rows.length} customers decrypted with their own KEK${firstError ? `; first error ${firstError}` : ''}`);
  return finish();
})().catch((err) => {
  check('Internal verification', false, err.message);
  finish();
});

function finish() {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`APP-SUMMARY ${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
