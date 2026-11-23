'use strict';

/**
 * Inicializacion de llaves y datos ficticios (idempotente).
 *
 * - Se ejecuta UNA sola vez por base de datos: al terminar escribe lab_metadata.seed_completed_at.
 * - Nunca se ejecuta sobre una base que ya tenga clientes o la marca de seed
 *   (por ejemplo, una base restaurada con PITR).
 * - Solo pide al Key Vault crear el primer KEK si el Key Vault nunca fue inicializado.
 *   Si el Key Vault perdio sus KEKs, se detiene y lo reporta (no genera llaves incompatibles).
 * - Los campos sensibles se cifran en la aplicacion ANTES del INSERT.
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
  { username: 'admin@hotel-lab.test', role: 'admin', display_name: 'Administradora del Laboratorio', pw: 'adminPassword' },
  { username: 'recepcion@hotel-lab.test', role: 'staff', display_name: 'Recepcion Turno Matutino', pw: 'staffPassword' },
  { username: 'concierge@hotel-lab.test', role: 'staff', display_name: 'Concierge Turno Vespertino', pw: 'staffPassword' },
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
  if (!health.available) throw new Error(`Key Vault no disponible (${health.error}). Inicie el servicio key-vault.`);
  if (health.vault_status === 'READY') {
    log(`[seed] Key Vault listo. Se conservan los KEK existentes; KEK activo: ${health.active_kek_id}`);
    return health.active_kek_id;
  }
  if (health.vault_status === 'KEYSTORE_MISSING') {
    throw new Error(
      'El Key Vault fue inicializado antes pero no tiene KEKs (keystore ausente). ' +
        'No se generan llaves de reemplazo. Restaure los KEK con ./scripts/restore.sh keys',
    );
  }
  const init = await vault.initialize();
  log(`[seed] Primer KEK creado en el Key Vault: ${init.kek_id} (respaldo automatico: ${init.backup})`);
  return init.kek_id;
}

async function insertCustomer(client, { userId, code, profile, isSeed }) {
  const { rows } = await client.query("SELECT nextval(pg_get_serial_sequence('customers', 'id')) AS id");
  const customerId = Number(rows[0].id);
  // 1) Cifrado en la aplicacion (DEK nuevo + 20 campos) y envoltura del DEK en el Key Vault.
  const sealed = await sealProfile(customerId, profile.sensitive);
  // 2) Solo entonces se escribe en PostgreSQL.
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
      else failures.push({ id: r.id, error: 'campos incompletos' });
    } catch (err) {
      failures.push({ id: r.id, error: err.code || err.message });
    }
  }
  if (log) log(`[seed] Verificacion de descifrado: ${ok}/${rows.length} clientes con sus 20 campos legibles`);
  return { total: rows.length, ok, failures };
}

async function runSeed({ log = console.log } = {}) {
  // El candado de sesion vive en una conexion dedicada durante todo el seed.
  const lockClient = await db.pool.connect();
  const lock = await lockClient.query('SELECT pg_try_advisory_lock(424202) AS ok');
  if (!lock.rows[0].ok) {
    lockClient.release();
    throw new Error('Otro proceso esta ejecutando el seed en este momento. Intente de nuevo en unos segundos.');
  }
  try {
    const before = await seedState();
    if (before.seededAt) {
      log(`[seed] La base ya fue inicializada el ${before.seededAt}. No se regenera nada.`);
      log(`[seed] Estado actual: ${before.users} usuarios, ${before.customers} clientes, ${before.reservations} reservaciones.`);
      return { skipped: true, ...before };
    }
    if (before.customers > 0 || before.users > 0) {
      throw new Error(
        `La base contiene datos (${before.users} usuarios, ${before.customers} clientes) pero no tiene la marca de seed. ` +
          'Por seguridad no se agregan datos ficticios encima. Revise la base o use ./scripts/reset-lab.sh all.',
      );
    }

    const activeKek = await ensureKek(log);
    const started = Date.now();
    const data = generateSeedData({ count: cfg.seed.customerCount, seed: cfg.seed.prngSeed, referenceDate: cfg.seed.referenceDate });

    log('[seed] Calculando hashes Argon2id de las contrasenas de demostracion...');
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
        if ((i + 1) % 25 === 0) log(`[seed] ${i + 1}/${data.length} clientes cifrados e insertados`);
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
      throw new Error(`Se esperaban ${cfg.seed.customerCount} clientes y hay ${after.customers}`);
    }
    const verification = await verifyDecryption(log);
    if (verification.ok !== verification.total) {
      throw new Error(`Fallo la verificacion de descifrado en ${verification.total - verification.ok} clientes`);
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    log('[seed] ------------------------------------------------------------');
    log(`[seed] Inicializacion completa en ${seconds} s`);
    log(`[seed] Usuarios: ${after.users} (3 de personal + ${after.customers} clientes)`);
    log(`[seed] Clientes con 20 campos cifrados: ${after.customers}`);
    log(`[seed] DEKs envueltos: ${after.keys} (KEK: ${result.kekIds.join(', ') || activeKek})`);
    log(`[seed] Reservaciones: ${after.reservations}`);
    log('[seed] ------------------------------------------------------------');
    return { skipped: false, ...after, kekIds: result.kekIds, verification };
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock(424202)').catch(() => {});
    lockClient.release();
  }
}

module.exports = { runSeed, seedState, verifyDecryption, insertCustomer, hashPassword, STAFF_ACCOUNTS };
