'use strict';

const { db } = require('../db');
const { ROOM_TYPES, ROOM_RATES, RESERVATION_STATUSES } = require('../fields');

async function list({ customerId = null, status = '', q = '', page = 1, pageSize = 15 }) {
  const where = [];
  const params = [];
  if (customerId) {
    params.push(customerId);
    where.push(`r.customer_id = $${params.length}`);
  }
  if (status && RESERVATION_STATUSES.includes(status)) {
    params.push(status);
    where.push(`r.status = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(r.reservation_code ILIKE $${params.length} OR c.customer_code ILIKE $${params.length} OR unaccent(c.full_name) ILIKE unaccent($${params.length}))`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((await db.query(`SELECT count(*) FROM reservations r JOIN customers c ON c.id = r.customer_id ${whereSql}`, params)).rows[0].count);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  const { rows } = await db.query(
    `SELECT r.*, to_char(r.check_in, 'YYYY-MM-DD') AS check_in_s, to_char(r.check_out, 'YYYY-MM-DD') AS check_out_s,
            (r.check_out - r.check_in) AS nights, c.customer_code, c.full_name, c.user_id
     FROM reservations r JOIN customers c ON c.id = r.customer_id
     ${whereSql} ORDER BY r.check_in DESC, r.id DESC LIMIT ${pageSize} OFFSET ${(current - 1) * pageSize}`,
    params,
  );
  return { rows, total, page: current, pages };
}

async function getById(id) {
  const n = Number.parseInt(id, 10);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  const { rows } = await db.query('SELECT r.*, c.user_id FROM reservations r JOIN customers c ON c.id = r.customer_id WHERE r.id = $1', [n]);
  return rows[0] || null;
}

function validate(body) {
  const errors = [];
  const roomType = String(body.room_type || '');
  const checkIn = String(body.check_in || '');
  const checkOut = String(body.check_out || '');
  const guests = Number.parseInt(body.guests_count, 10);
  if (!ROOM_TYPES.includes(roomType)) errors.push('Select a valid room type.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || Number.isNaN(Date.parse(checkIn))) errors.push('Invalid check-in date.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkOut) || Number.isNaN(Date.parse(checkOut))) errors.push('Invalid check-out date.');
  if (!errors.length && checkOut <= checkIn) errors.push('Check-out must be after check-in.');
  if (!(guests >= 1 && guests <= 8)) errors.push('The number of guests must be between 1 and 8.');
  const nights = errors.length ? 0 : Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86400000);
  if (nights > 60) errors.push('The maximum stay is 60 nights.');
  return { errors, value: { roomType, checkIn, checkOut, guests, nights, total: nights * (ROOM_RATES[roomType] || 0) } };
}

async function create(customerId, value, actorUserId) {
  return db.transaction(async (client) => {
    const seq = await client.query("SELECT coalesce(max(substring(reservation_code from 5)::int), 0) + 1 AS n FROM reservations WHERE reservation_code ~ '^RES-[0-9]+$'");
    const code = `RES-${String(seq.rows[0].n).padStart(5, '0')}`;
    const { rows } = await client.query(
      `INSERT INTO reservations (reservation_code, customer_id, room_type, room_number, check_in, check_out, guests_count, status, total_amount, created_by_user_id)
       VALUES ($1, $2, $3, NULL, $4, $5, $6, 'confirmed', $7, $8) RETURNING id, reservation_code`,
      [code, customerId, value.roomType, value.checkIn, value.checkOut, value.guests, value.total, actorUserId],
    );
    return rows[0];
  });
}

async function cancel(id) {
  const { rowCount } = await db.query("UPDATE reservations SET status = 'cancelled' WHERE id = $1 AND status IN ('pending', 'confirmed')", [id]);
  return rowCount > 0;
}

module.exports = { list, getById, validate, create, cancel };
