'use strict';

/**
 * Verificacion de la instalacion (la invoca ./scripts/verify-setup.sh).
 * Imprime PASS/FAIL por cada comprobacion y termina con codigo 1 si alguna falla.
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
  check('Conexion a PostgreSQL', Boolean(info), info ? `${db.target} / ${info.cluster_name} / PostgreSQL ${info.pg_version}${info.in_recovery ? ' / standby' : ''}` : db.health.lastError);
  if (!info) return finish();

  const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map((r) => r.table_name);
  const required = ['users', 'customers', 'customer_sensitive_data', 'customer_keys', 'reservations', 'audit_events'];
  const missing = required.filter((t) => !tables.includes(t));
  check('Esquema de base de datos', missing.length === 0, missing.length ? `faltan: ${missing.join(', ')}` : required.join(', '));
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
  check('Datos iniciales generados (seed)', Boolean(c.seeded_at), c.seeded_at ? `desde ${c.seeded_at}` : 'ejecute ./scripts/seed.sh');
  check(`Clientes ficticios del seed = ${cfg.seed.customerCount}`, c.seed_customers === cfg.seed.customerCount, `seed: ${c.seed_customers}, total clientes: ${c.customers}, usuarios: ${c.users}, reservaciones: ${c.reservations}`);
  check('Cada cliente tiene 20 campos cifrados', c.full_profiles === c.customers && c.customers > 0, `${c.full_profiles}/${c.customers}`);
  check('Cada cliente tiene un DEK envuelto unico', c.keys === c.customers && c.distinct_deks === c.customers, `${c.keys} DEKs envueltos, ${c.distinct_deks} distintos`);

  const malformed = (await db.query(`SELECT count(*)::int AS n FROM customer_sensitive_data s, jsonb_each(s.encrypted_fields) f
      WHERE NOT (f.value ? 'ciphertext' AND f.value ? 'nonce' AND f.value ? 'tag')
         OR length(decode(f.value->>'nonce', 'base64')) <> 12
         OR length(decode(f.value->>'tag', 'base64')) <> 16`)).rows[0].n;
  check('Formato AES-256-GCM (nonce 96 bits, tag 128 bits)', malformed === 0, `${malformed} campos con formato invalido`);

  const vh = await vault.health({ fresh: true });
  check('Conexion al Key Vault', vh.available, vh.available ? `estado ${vh.vault_status}` : `${vh.error}: ${vh.message}`);
  check('KEK activo disponible', Boolean(vh.available && vh.active_kek_id), vh.active_kek_id || 'sin KEK activo');

  if (vh.available) {
    const vs = await vault.status().catch(() => null);
    const known = new Set(vs ? vs.keks.map((k) => k.kek_id) : []);
    const used = (await db.query('SELECT kek_id, count(*)::int AS n FROM customer_keys GROUP BY kek_id ORDER BY kek_id')).rows;
    const unknown = used.filter((u) => !known.has(u.kek_id));
    check('Todos los kek_id de PostgreSQL existen en el Key Vault', unknown.length === 0, used.map((u) => `${u.kek_id}: ${u.n}`).join(', '));
  }

  const rows = (await db.query(`SELECT c.id, s.encrypted_fields, k.dek_ref, k.wrapped_dek, k.dek_wrap_nonce, k.dek_wrap_tag, k.kek_id
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
  check('Cifrado y descifrado de extremo a extremo', ok === rows.length && rows.length > 0, `${ok}/${rows.length} clientes descifrados${firstError ? `; primer error ${firstError}` : ''}`);
  return finish();
})().catch((err) => {
  check('Verificacion interna', false, err.message);
  finish();
});

function finish() {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`RESUMEN-APP ${results.length - failed}/${results.length} comprobaciones correctas`);
  process.exit(failed ? 1 : 0);
}
