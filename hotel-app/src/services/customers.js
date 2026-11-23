'use strict';

const { db } = require('../db');
const vault = require('../vaultClient');
const { openFields } = require('../crypto/envelope');
const { insertCustomer, hashPassword } = require('../seed');
const { SENSITIVE_KEYS, OPERATIONAL_FIELDS, CUSTOMER_STATUSES } = require('../fields');

const SORTS = {
  code: 'c.customer_code',
  name: 'c.full_name',
  city: 'c.city',
  country: 'c.country',
  status: 'c.status',
  tier: 'c.loyalty_tier',
  created: 'c.created_at',
};

async function list({ q = '', country = '', city = '', status = '', sort = 'code', dir = 'asc', page = 1, pageSize = 15 }) {
  const where = [];
  const params = [];
  if (q) {
    params.push(`%${q}%`);
    const p = `$${params.length}`;
    where.push(`(unaccent(c.full_name) ILIKE unaccent(${p}) OR c.customer_code ILIKE ${p} OR unaccent(c.display_nickname) ILIKE unaccent(${p}) OR u.username ILIKE ${p})`);
  }
  if (country) {
    params.push(country);
    where.push(`c.country = $${params.length}`);
  }
  if (city) {
    params.push(city);
    where.push(`c.city = $${params.length}`);
  }
  if (status && CUSTOMER_STATUSES.includes(status)) {
    params.push(status);
    where.push(`c.status = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql = `${SORTS[sort] || SORTS.code} ${dir === 'desc' ? 'DESC' : 'ASC'}, c.id ASC`;
  const total = Number((await db.query(`SELECT count(*) FROM customers c JOIN users u ON u.id = c.user_id ${whereSql}`, params)).rows[0].count);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  const rows = (
    await db.query(
      `SELECT c.id, c.customer_code, c.full_name, c.display_nickname, c.city, c.country, c.status, c.loyalty_tier,
              c.preferred_room_category, c.preferred_language, u.username, k.kek_id,
              (SELECT count(*) FROM reservations r WHERE r.customer_id = c.id)::int AS reservations
       FROM customers c JOIN users u ON u.id = c.user_id LEFT JOIN customer_keys k ON k.customer_id = c.id
       ${whereSql} ORDER BY ${orderSql} LIMIT ${pageSize} OFFSET ${(current - 1) * pageSize}`,
      params,
    )
  ).rows;
  return { rows, total, page: current, pages, pageSize };
}

async function facets(country) {
  const countries = (await db.query('SELECT country, count(*)::int AS n FROM customers GROUP BY country ORDER BY country')).rows;
  const cities = (
    await db.query(
      country ? 'SELECT city, count(*)::int AS n FROM customers WHERE country = $1 GROUP BY city ORDER BY city' : 'SELECT city, count(*)::int AS n FROM customers GROUP BY city ORDER BY city',
      country ? [country] : [],
    )
  ).rows;
  return { countries, cities };
}

async function getById(id) {
  const n = Number.parseInt(id, 10);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  const { rows } = await db.query(
    `SELECT c.*, u.username, u.role AS user_role, u.last_login_at,
            k.dek_ref, k.wrapped_dek, k.dek_wrap_nonce, k.dek_wrap_tag, k.kek_id, k.wrap_algorithm,
            k.encryption_schema_version AS key_schema_version, k.created_at AS key_created_at, k.rewrapped_at,
            s.encrypted_fields, s.encryption_algorithm, s.encryption_schema_version, s.encrypted_at
     FROM customers c
     JOIN users u ON u.id = c.user_id
     LEFT JOIN customer_keys k ON k.customer_id = c.id
     LEFT JOIN customer_sensitive_data s ON s.customer_id = c.id
     WHERE c.id = $1`,
    [n],
  );
  return rows[0] || null;
}

async function getByUserId(userId) {
  const { rows } = await db.query('SELECT id FROM customers WHERE user_id = $1', [userId]);
  return rows[0] ? getById(rows[0].id) : null;
}

/** Descifra solo los campos solicitados y autorizados. */
async function reveal(customer, fields) {
  if (!customer.encrypted_fields || !customer.wrapped_dek) {
    const err = new Error('El cliente no tiene datos cifrados o DEK asociado.');
    err.code = 'NO_ENCRYPTED_DATA';
    err.status = 404;
    throw err;
  }
  return openFields(Number(customer.id), customer, customer.encrypted_fields, fields);
}

function parseOperational(body) {
  const out = {};
  for (const f of OPERATIONAL_FIELDS) {
    if (f.type === 'bool') out[f.key] = body[f.key] === 'on' || body[f.key] === 'true' || body[f.key] === true;
    else out[f.key] = String(body[f.key] || '').trim().slice(0, 120);
  }
  return out;
}

function validateNew(body) {
  const errors = [];
  const fullName = String(body.full_name || '').trim();
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (fullName.length < 3) errors.push('El nombre completo es obligatorio.');
  if (!/^[a-z0-9._-]+@[a-z0-9.-]+\.test$/.test(username)) errors.push('El usuario debe ser un correo ficticio con dominio .test (por ejemplo, nuevo.cliente@hotel-lab.test).');
  if (password.length < 10) errors.push('La contrasena debe tener al menos 10 caracteres.');
  if (!CUSTOMER_STATUSES.includes(body.status)) errors.push('Estado de cliente invalido.');
  const operational = parseOperational(body);
  for (const f of OPERATIONAL_FIELDS) {
    if (f.type !== 'bool' && !operational[f.key]) errors.push(`Falta el campo operativo: ${f.label}.`);
    if (f.options && operational[f.key] && !f.options.includes(operational[f.key])) errors.push(`Valor no permitido para ${f.label}.`);
  }
  const sensitive = {};
  for (const key of SENSITIVE_KEYS) {
    sensitive[key] = String(body[key] || '').trim().slice(0, 300);
    if (!sensitive[key]) errors.push(`Falta el campo sensible: ${key}.`);
  }
  return { errors, value: { fullName, username, password, status: body.status, operational, sensitive } };
}

async function create(value) {
  const exists = await db.query('SELECT 1 FROM users WHERE username = $1', [value.username]);
  if (exists.rowCount) {
    const err = new Error('Ya existe una cuenta con ese usuario.');
    err.status = 409;
    err.code = 'DUPLICATE';
    throw err;
  }
  // Comprobar el Key Vault antes de abrir la transaccion: sin Key Vault no se guarda nada.
  const vh = await vault.health({ fresh: true });
  if (!vh.available || vh.vault_status !== 'READY' || vh.access_disabled) {
    const err = new Error('No se puede crear el cliente: el Key Vault no esta disponible para envolver el DEK. Nunca se guardan datos sensibles sin cifrar.');
    err.status = 503;
    err.code = vh.access_disabled ? 'KEY_ACCESS_DISABLED' : 'VAULT_UNAVAILABLE';
    throw err;
  }
  const passwordHash = await hashPassword(value.password);
  return db.transaction(async (client) => {
    const u = await client.query("INSERT INTO users (username, password_hash, role, display_name) VALUES ($1, $2, 'customer', $3) RETURNING id", [value.username, passwordHash, value.fullName]);
    const seq = await client.query("SELECT coalesce(max(substring(customer_code from 5)::int), 0) + 1 AS n FROM customers WHERE customer_code ~ '^CUS-[0-9]+$'");
    const code = `CUS-${String(seq.rows[0].n).padStart(4, '0')}`;
    const profile = { fullName: value.fullName, status: value.status, operational: value.operational, sensitive: value.sensitive };
    const { customerId, kekId } = await insertCustomer(client, { userId: u.rows[0].id, code, profile, isSeed: false });
    return { customerId, code, kekId };
  });
}

module.exports = { list, facets, getById, getByUserId, reveal, validateNew, create };
