'use strict';

/**
 * Key and fictional data initialization (idempotent).
 *
 * - Runs ONCE per database: when it finishes it writes lab_metadata.seed_completed_at.
 * - It never runs on a database that already has customers or the seed marker
 *   (for example, a database restored with PITR).
 * - It only asks the Key Vault to create the first KEK if the Key Vault was never initialized.
 *   If the Key Vault lost its KEKs, it stops and reports it (it never generates incompatible keys).
 * - Sensitive fields are encrypted in the application BEFORE the INSERT.
 */

const argon2 = require('argon2');
const cfg = require('./config');
const { db } = require('./db');
const vault = require('./vaultClient');
const { sealProfile, openFields } = require('./crypto/envelope');
const { SENSITIVE_KEYS, OPERATIONAL_KEYS } = require('./fields');
const { generateSeedData } = require('./data/generator');

const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

const STAFF_ACCOUNTS = [
  { username: 'admin@hotel-lab.test', role: 'admin', display_name: 'Lab Administrator', pw: 'adminPassword' },
  { username: 'frontdesk@hotel-lab.test', role: 'staff', display_name: 'Front Desk (Morning Shift)', pw: 'staffPassword' },
  { username: 'concierge@hotel-lab.test', role: 'staff', display_name: 'Concierge (Evening Shift)', pw: 'staffPassword' },
];

function hashPassword(password) {
  return argon2.hash(password, ARGON2_OPTIONS);
}

async function seedState() {
  const marker = await db.query("SELECT value FROM lab_metadata WHERE key = 'seed_completed_at'");
  const counts = await db.query(`SELECT
      (SELECT count(*) FROM users)::int AS users,
      (SELECT count(*) FROM customers)::int AS customers,
      (SELECT count(*) FROM customer_keys)::int AS keys,
      (SELECT count(*) FROM reservations)::int AS reservations`);
  return { seededAt: marker.rows[0] ? marker.rows[0].value : null, ...counts.rows[0] };
}

async function ensureKek(log) {
  const health = await vault.health({ fresh: true });
  if (!health.available) throw new Error(`Key Vault unavailable (${health.error}). Start the key-vault service.`);
  if (health.vault_status === 'READY') {
    log(`[seed] Key Vault ready. Existing KEKs are preserved; active KEK: ${health.active_kek_id}`);
    return health.active_kek_id;
  }
  if (health.vault_status === 'KEYSTORE_MISSING') {
    throw new Error(
      'The Key Vault was initialized before but has no KEKs (keystore missing). ' +
        'No replacement keys are generated. Restore the KEKs with ./scripts/restore.sh keys',
    );
  }
  const init = await vault.initialize();
  log(`[seed] First KEK created in the Key Vault: ${init.kek_id} (automatic backup: ${init.backup})`);
  return init.kek_id;
}

async function insertCustomer(client, { userId, code, profile, isSeed }) {
  const { rows } = await client.query("SELECT nextval(pg_get_serial_sequence('customers', 'id')) AS id");
  const customerId = Number(rows[0].id);
  // 1) Encryption in the application (new DEK + 20 fields) and DEK wrapping in the Key Vault.
  const sealed = await sealProfile(customerId, profile.sensitive);
  // 2) Only then is anything written to PostgreSQL.
  const cols = ['id', 'user_id', 'customer_code', 'full_name', 'status', ...OPERATIONAL_KEYS, 'is_seed'];
  const vals = [customerId, userId, code, profile.fullName, profile.status, ...OPERATIONAL_KEYS.map((k) => profile.operational[k]), isSeed];
  await client.query(
    `INSERT INTO customers (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    vals,
  );
  await client.query(
    'INSERT INTO customer_sensitive_data (customer_id, encrypted_fields, encryption_algorithm, encryption_schema_version) VALUES ($1, $2, $3, $4)',
    [customerId, JSON.stringify(sealed.encryptedFields), 'AES-256-GCM', sealed.key.encryption_schema_version],
  );
  const k = sealed.key;
  await client.query(
    `INSERT INTO customer_keys (customer_id, dek_ref, wrapped_dek, dek_wrap_nonce, dek_wrap_tag, kek_id, wrap_algorithm, encryption_schema_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [customerId, k.dek_ref, k.wrapped_dek, k.dek_wrap_nonce, k.dek_wrap_tag, k.kek_id, k.wrap_algorithm, k.encryption_schema_version],
  );
  return { customerId, kekId: k.kek_id };
}

async function verifyDecryption(log) {
  const { rows } = await db.query(
    `SELECT c.id, s.encrypted_fields, k.dek_ref, k.wrapped_dek, k.dek_wrap_nonce, k.dek_wrap_tag, k.kek_id
     FROM customers c JOIN customer_sensitive_data s ON s.customer_id = c.id JOIN customer_keys k ON k.customer_id = c.id
     ORDER BY c.id`,
  );
  let ok = 0;
  const failures = [];
  for (const r of rows) {
    try {
      const values = await openFields(Number(r.id), r, r.encrypted_fields, SENSITIVE_KEYS);
      if (Object.keys(values).length === SENSITIVE_KEYS.length) ok += 1;
      else failures.push({ id: r.id, error: 'incomplete fields' });
    } catch (err) {
      failures.push({ id: r.id, error: err.code || err.message });
    }
  }
  if (log) log(`[seed] Decryption check: ${ok}/${rows.length} customers with all 20 fields readable`);
  return { total: rows.length, ok, failures };
}

async function runSeed({ log = console.log } = {}) {
  // The session-level lock lives on one dedicated connection for the whole seed.
  const lockClient = await db.pool.connect();
  const lock = await lockClient.query('SELECT pg_try_advisory_lock(424202) AS ok');
  if (!lock.rows[0].ok) {
    lockClient.release();
    throw new Error('Another process is running the seed right now. Try again in a few seconds.');
  }
  try {
    const before = await seedState();
    if (before.seededAt) {
      log(`[seed] The database was already initialized on ${before.seededAt}. Nothing is regenerated.`);
      log(`[seed] Current state: ${before.users} users, ${before.customers} customers, ${before.reservations} reservations.`);
      return { skipped: true, ...before };
    }
    if (before.customers > 0 || before.users > 0) {
      throw new Error(
        `The database contains data (${before.users} users, ${before.customers} customers) but has no seed marker. ` +
          'For safety, no fictional data is added on top. Check the database or use ./scripts/reset-lab.sh all.',
      );
    }

    const activeKek = await ensureKek(log);
    const started = Date.now();
    const data = generateSeedData({ count: cfg.seed.customerCount, seed: cfg.seed.prngSeed, referenceDate: cfg.seed.referenceDate });

    log('[seed] Computing Argon2id hashes for the demo passwords...');
    const staffHashes = await Promise.all(STAFF_ACCOUNTS.map((a) => hashPassword(cfg.demo[a.pw])));
    const customerHashes = [];
    for (let i = 0; i < data.length; i += 10) {
      const batch = data.slice(i, i + 10).map(() => hashPassword(cfg.demo.customerPassword));
      customerHashes.push(...(await Promise.all(batch)));
    }

    const result = await db.transaction(async (client) => {
      for (let i = 0; i < STAFF_ACCOUNTS.length; i += 1) {
        const a = STAFF_ACCOUNTS[i];
        await client.query('INSERT INTO users (username, password_hash, role, display_name) VALUES ($1, $2, $3, $4)', [a.username, staffHashes[i], a.role, a.display_name]);
      }
      let reservationSeq = 0;
      const kekIds = new Set();
      for (let i = 0; i < data.length; i += 1) {
        const p = data[i];
        const u = await client.query(
          "INSERT INTO users (username, password_hash, role, display_name) VALUES ($1, $2, 'customer', $3) RETURNING id",
          [p.username, customerHashes[i], p.fullName],
        );
        const { customerId, kekId } = await insertCustomer(client, { userId: u.rows[0].id, code: p.customerCode, profile: p, isSeed: true });
        kekIds.add(kekId);
        for (const r of p.reservations) {
          reservationSeq += 1;
          await client.query(
            `INSERT INTO reservations (reservation_code, customer_id, room_type, room_number, check_in, check_out, guests_count, status, total_amount)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [`RES-${String(reservationSeq).padStart(5, '0')}`, customerId, r.room_type, r.room_number, r.check_in, r.check_out, r.guests_count, r.status, r.total_amount],
          );
        }
        if ((i + 1) % 25 === 0) log(`[seed] ${i + 1}/${data.length} customers encrypted and inserted`);
      }
      await client.query(
        `INSERT INTO lab_metadata (key, value) VALUES ('seed_completed_at', now()::text), ('seed_version', '1'), ('seed_customer_count', $1)
         ON CONFLICT (key) DO NOTHING`,
        [String(data.length)],
      );
      await client.query(
        "INSERT INTO audit_events (actor_username, action, target_type, outcome, details) VALUES ('system', 'seed', 'database', 'success', $1)",
        [JSON.stringify({ customers: data.length, reservations: reservationSeq, kek_ids: [...kekIds] })],
      );
      return { reservations: reservationSeq, kekIds: [...kekIds] };
    });

    const after = await seedState();
    if (after.customers !== cfg.seed.customerCount) {
      throw new Error(`Expected ${cfg.seed.customerCount} customers but found ${after.customers}`);
    }
    const verification = await verifyDecryption(log);
    if (verification.ok !== verification.total) {
      throw new Error(`Decryption check failed for ${verification.total - verification.ok} customers`);
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    log('[seed] ------------------------------------------------------------');
    log(`[seed] Initialization completed in ${seconds} s`);
    log(`[seed] Users: ${after.users} (3 staff + ${after.customers} customers)`);
    log(`[seed] Customers with 20 encrypted fields: ${after.customers}`);
    log(`[seed] Wrapped DEKs: ${after.keys} (KEK: ${result.kekIds.join(', ') || activeKek})`);
    log(`[seed] Reservations: ${after.reservations}`);
    log('[seed] ------------------------------------------------------------');
    return { skipped: false, ...after, kekIds: result.kekIds, verification };
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock(424202)').catch(() => {});
    lockClient.release();
  }
}

module.exports = { runSeed, seedState, verifyDecryption, insertCustomer, hashPassword, STAFF_ACCOUNTS };
