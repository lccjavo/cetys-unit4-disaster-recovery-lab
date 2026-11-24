'use strict';

const express = require('express');
const cfg = require('../config');
const { db, Database } = require('../db');
const vault = require('../vaultClient');
const status = require('../services/status');
const customers = require('../services/customers');
const reservations = require('../services/reservations');
const { audit } = require('../services/audit');
const policy = require('../policy');
const { flash, requireRole } = require('../web');

const router = express.Router();

// -------------------------------------------------------------- dashboard

router.get('/', async (req, res) => {
  const user = req.session.user;
  if (user.role === 'customer') {
    let customer = null;
    let resv = { rows: [] };
    let dbError = null;
    try {
      customer = await customers.getById(user.customer_id);
      resv = await reservations.list({ customerId: user.customer_id, pageSize: 5 });
    } catch (err) {
      if (err.code !== 'DB_UNAVAILABLE') throw err;
      dbError = err.message;
    }
    return res.render('my-dashboard', { title: 'My account', customer, reservations: resv.rows, dbError });
  }
  const d = await status.dashboard();
  return res.render('dashboard', { title: 'Dashboard', d });
});

// ------------------------------------------------------------ reservations

router.get('/reservations', async (req, res) => {
  const user = req.session.user;
  const page = Number.parseInt(req.query.page, 10) || 1;
  const st = String(req.query.status || '');
  const q = policy.isStaffOrAdmin(user) ? String(req.query.q || '').slice(0, 60) : '';
  // Object-level: a customer only sees their own reservations, whatever parameters they send.
  const customerId = user.role === 'customer' ? user.customer_id : Number.parseInt(req.query.customer_id, 10) || null;
  const result = await reservations.list({ customerId, status: st, q, page });
  res.render('reservations/index', { title: user.role === 'customer' ? 'My reservations' : 'Reservations', result, filters: { status: st, q, customer_id: customerId } });
});

async function reservationForm(req, res, { errors = [], form = {}, status: code = 200 } = {}) {
  const user = req.session.user;
  let options = [];
  if (policy.isStaffOrAdmin(user)) {
    options = (await db.query('SELECT id, customer_code, full_name FROM customers ORDER BY customer_code')).rows;
  }
  res.status(code).render('reservations/new', { title: 'New reservation', errors, form: { customer_id: req.query.customer_id || '', guests_count: 2, ...form }, options });
}

router.get('/reservations/new', (req, res) => reservationForm(req, res));

router.post('/reservations', async (req, res) => {
  const user = req.session.user;
  const targetId = user.role === 'customer' ? user.customer_id : Number.parseInt(req.body.customer_id, 10);
  const customer = targetId ? await customers.getById(targetId) : null;
  if (!customer) return reservationForm(req, res, { errors: ['Select a valid customer.'], form: req.body, status: 422 });
  if (!policy.canManageReservationFor(user, customer)) {
    await audit(req, 'reservation.create', { targetType: 'customer', targetId: customer.id, outcome: 'denied' });
    throw new policy.ForbiddenError('You cannot create reservations for another customer.');
  }
  const { errors, value } = reservations.validate(req.body);
  if (errors.length) return reservationForm(req, res, { errors, form: req.body, status: 422 });
  try {
    const r = await reservations.create(customer.id, value, user.id);
    await audit(req, 'reservation.create', { targetType: 'reservation', targetId: r.id, details: { code: r.reservation_code, customer: customer.customer_code } });
    flash(req, 'success', `Reservation ${r.reservation_code} created for ${customer.customer_code} (${value.nights} nights). Check it in the reservations table.`);
    return res.redirect(user.role === 'customer' ? '/reservations' : `/customers/${customer.id}#tab-reservations`);
  } catch (err) {
    if (err.code === '25006') return reservationForm(req, res, { errors: ['The current server is a read-only standby; it does not accept writes.'], form: req.body, status: 503 });
    throw err;
  }
});

router.post('/reservations/:id/cancel', async (req, res) => {
  const r = await reservations.getById(req.params.id);
  if (!r) {
    const err = new Error('The reservation does not exist.');
    err.status = 404;
    throw err;
  }
  if (!policy.canManageReservationFor(req.session.user, { user_id: r.user_id })) {
    await audit(req, 'reservation.cancel', { targetType: 'reservation', targetId: r.id, outcome: 'denied' });
    throw new policy.ForbiddenError('You cannot cancel another customer\'s reservations.');
  }
  const ok = await reservations.cancel(r.id);
  await audit(req, 'reservation.cancel', { targetType: 'reservation', targetId: r.id, outcome: ok ? 'success' : 'error' });
  flash(req, ok ? 'success' : 'warning', ok ? `Reservation ${r.reservation_code} cancelled.` : 'Only pending or confirmed reservations can be cancelled.');
  res.redirect('/reservations');
});

// ---------------------------------------------------------------- security

router.get('/security', requireRole('admin'), async (req, res) => {
  res.render('security', { title: 'Security and encryption', s: await status.security() });
});

router.post('/security/rewrap', requireRole('admin'), async (req, res) => {
  try {
    const r = await status.rewrapAll();
    await audit(req, 'keys.rewrap', { targetType: 'customer_keys', details: r });
    flash(req, r.failed ? 'warning' : 'success', r.candidates ? `Re-wrap completed: ${r.ok} of ${r.candidates} DEKs moved to their customer's active KEK. Failed: ${r.failed}.` : 'Every DEK already uses its customer\'s active KEK. Nothing to re-wrap.');
  } catch (err) {
    flash(req, 'danger', `Re-wrap failed: [${err.code || 'ERROR'}] ${err.message}`);
  }
  res.redirect('/security');
});

// --------------------------------------------------- disaster recovery

router.get('/dr', requireRole('admin'), async (req, res) => {
  res.render('dr', { title: 'Disaster recovery', s: await status.disasterRecovery() });
});

router.post('/dr/verify', requireRole('admin'), async (req, res) => {
  try {
    const r = await status.verifyRecovery(10);
    await audit(req, 'dr.verify', { targetType: 'database', targetId: r.server, outcome: r.outcome === 'success' ? 'success' : 'error', details: r });
    const errs = Object.entries(r.errors).map(([k, v]) => `${k}: ${v}`).join(', ');
    flash(req, r.outcome === 'success' ? 'success' : 'warning', `Verification on ${r.server}: ${r.customers} customers, ${r.reservations} reservations; decrypted ${r.ok}/${r.sampled} sample customers${errs ? ` (errors: ${errs})` : ''}.`);
  } catch (err) {
    flash(req, 'danger', `Verification failed: [${err.code || 'ERROR'}] ${err.message}`);
  }
  res.redirect('/dr');
});

router.post('/dr/switch', requireRole('admin'), async (req, res) => {
  const host = String(req.body.host || '');
  if (!cfg.db.candidates.includes(host)) {
    flash(req, 'danger', 'Server not allowed.');
    return res.redirect('/dr');
  }
  const probe = await Database.probeHost(host);
  if (!probe.reachable) {
    flash(req, 'danger', `${host} is not responding (${probe.error}). The connection was not changed.`);
    return res.redirect('/dr');
  }
  if (probe.in_recovery) {
    flash(req, 'warning', `${host} is still in standby/recovery mode (read-only). Promote it first; the application does not write to a standby.`);
    return res.redirect('/dr');
  }
  db.switchTarget(host, { reason: 'GUI /dr', actor: req.session.user.username });
  await audit(req, 'dr.switch', { targetType: 'database', targetId: host });
  flash(req, 'success', `The application now uses ${host} (${probe.cluster_name}, timeline ${probe.timeline}).`);
  return res.redirect('/dr');
});

// ---------------------------------------------------------------- accounts

router.get('/accounts', requireRole('admin'), async (req, res) => {
  const role = ['admin', 'staff', 'customer'].includes(req.query.role) ? req.query.role : '';
  const q = String(req.query.q || '').slice(0, 60);
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const params = [];
  const where = [];
  if (role) {
    params.push(role);
    where.push(`u.role = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(u.username ILIKE $${params.length} OR unaccent(u.display_name) ILIKE unaccent($${params.length}))`);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const per = 20;
  const total = Number((await db.query(`SELECT count(*) FROM users u ${w}`, params)).rows[0].count);
  const pages = Math.max(1, Math.ceil(total / per));
  const rows = (
    await db.query(
      `SELECT u.id, u.username, u.role, u.display_name, u.is_active, u.created_at, u.last_login_at, c.id AS customer_id, c.customer_code,
              LEFT(u.password_hash, 31) AS hash_prefix
       FROM users u LEFT JOIN customers c ON c.user_id = u.id ${w} ORDER BY u.id LIMIT ${per} OFFSET ${(Math.min(page, pages) - 1) * per}`,
      params,
    )
  ).rows;
  const byRole = (await db.query('SELECT role, count(*)::int AS n FROM users GROUP BY role')).rows;
  res.render('accounts', { title: 'User accounts', rows, total, page: Math.min(page, pages), pages, byRole, filters: { role, q } });
});

// ------------------------------------------------------------- API JSON

router.get('/api/status', async (req, res) => {
  const counts = await status.counts().catch((err) => ({ error: err.code }));
  res.json({ db: status.dbSnapshot(), vault: await vault.health(), counts });
});

router.get('/api/customers/:id', async (req, res) => {
  const c = await customers.getById(req.params.id);
  if (!c) return res.status(404).json({ error: 'NOT_FOUND' });
  if (!policy.canViewCustomer(req.session.user, c)) {
    await audit(req, 'customer.view', { targetType: 'customer', targetId: c.id, outcome: 'denied', details: { via: 'api' } });
    return res.status(403).json({ error: 'FORBIDDEN', message: 'You are not authorized for this customer.' });
  }
  const { F } = res.locals;
  const operational = Object.fromEntries(F.OPERATIONAL_KEYS.map((k) => [k, c[k]]));
  return res.json({
    id: Number(c.id),
    customer_code: c.customer_code,
    full_name: c.full_name,
    status: c.status,
    operational,
    encryption: { kek_id: c.kek_id, dek_ref: c.dek_ref, algorithm: c.encryption_algorithm, schema_version: c.encryption_schema_version, encrypted_fields: Object.keys(c.encrypted_fields || {}) },
  });
});

module.exports = router;
