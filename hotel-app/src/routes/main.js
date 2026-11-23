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

// ------------------------------------------------------------------ panel

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
    return res.render('my-dashboard', { title: 'Mi cuenta', customer, reservations: resv.rows, dbError });
  }
  const d = await status.dashboard();
  return res.render('dashboard', { title: 'Panel', d });
});

// ---------------------------------------------------------- reservaciones

router.get('/reservations', async (req, res) => {
  const user = req.session.user;
  const page = Number.parseInt(req.query.page, 10) || 1;
  const st = String(req.query.status || '');
  const q = policy.isStaffOrAdmin(user) ? String(req.query.q || '').slice(0, 60) : '';
  // Object-level: un cliente solo ve sus reservaciones, sin importar los parametros que envie.
  const customerId = user.role === 'customer' ? user.customer_id : Number.parseInt(req.query.customer_id, 10) || null;
  const result = await reservations.list({ customerId, status: st, q, page });
  res.render('reservations/index', { title: user.role === 'customer' ? 'Mis reservaciones' : 'Reservaciones', result, filters: { status: st, q, customer_id: customerId } });
});

async function reservationForm(req, res, { errors = [], form = {}, status: code = 200 } = {}) {
  const user = req.session.user;
  let options = [];
  if (policy.isStaffOrAdmin(user)) {
    options = (await db.query('SELECT id, customer_code, full_name FROM customers ORDER BY customer_code')).rows;
  }
  res.status(code).render('reservations/new', { title: 'Nueva reservacion', errors, form: { customer_id: req.query.customer_id || '', guests_count: 2, ...form }, options });
}

router.get('/reservations/new', (req, res) => reservationForm(req, res));

router.post('/reservations', async (req, res) => {
  const user = req.session.user;
  const targetId = user.role === 'customer' ? user.customer_id : Number.parseInt(req.body.customer_id, 10);
  const customer = targetId ? await customers.getById(targetId) : null;
  if (!customer) return reservationForm(req, res, { errors: ['Seleccione un cliente valido.'], form: req.body, status: 422 });
  if (!policy.canManageReservationFor(user, customer)) {
    await audit(req, 'reservation.create', { targetType: 'customer', targetId: customer.id, outcome: 'denied' });
    throw new policy.ForbiddenError('No puede crear reservaciones para otro cliente.');
  }
  const { errors, value } = reservations.validate(req.body);
  if (errors.length) return reservationForm(req, res, { errors, form: req.body, status: 422 });
  try {
    const r = await reservations.create(customer.id, value, user.id);
    await audit(req, 'reservation.create', { targetType: 'reservation', targetId: r.id, details: { code: r.reservation_code, customer: customer.customer_code } });
    flash(req, 'success', `Reservacion ${r.reservation_code} creada para ${customer.customer_code} (${value.nights} noches). Verifiquela en la tabla reservations.`);
    return res.redirect(user.role === 'customer' ? '/reservations' : `/customers/${customer.id}#tab-reservations`);
  } catch (err) {
    if (err.code === '25006') return reservationForm(req, res, { errors: ['El servidor actual es un standby de solo lectura; no acepta escrituras.'], form: req.body, status: 503 });
    throw err;
  }
});

router.post('/reservations/:id/cancel', async (req, res) => {
  const r = await reservations.getById(req.params.id);
  if (!r) {
    const err = new Error('La reservacion no existe.');
    err.status = 404;
    throw err;
  }
  if (!policy.canManageReservationFor(req.session.user, { user_id: r.user_id })) {
    await audit(req, 'reservation.cancel', { targetType: 'reservation', targetId: r.id, outcome: 'denied' });
    throw new policy.ForbiddenError('No puede cancelar reservaciones de otro cliente.');
  }
  const ok = await reservations.cancel(r.id);
  await audit(req, 'reservation.cancel', { targetType: 'reservation', targetId: r.id, outcome: ok ? 'success' : 'error' });
  flash(req, ok ? 'success' : 'warning', ok ? `Reservacion ${r.reservation_code} cancelada.` : 'Solo se pueden cancelar reservaciones pendientes o confirmadas.');
  res.redirect('/reservations');
});

// ------------------------------------------------------------- seguridad

router.get('/security', requireRole('admin'), async (req, res) => {
  res.render('security', { title: 'Seguridad y cifrado', s: await status.security() });
});

router.post('/security/rewrap', requireRole('admin'), async (req, res) => {
  try {
    const r = await status.rewrapAll();
    await audit(req, 'keys.rewrap', { targetType: 'customer_keys', details: r });
    flash(req, r.failed ? 'warning' : 'success', `Re-envoltura completada: ${r.ok} de ${r.candidates} DEKs migrados a ${r.activeKek}. Fallidos: ${r.failed}.`);
  } catch (err) {
    flash(req, 'danger', `No se pudo re-envolver: [${err.code || 'ERROR'}] ${err.message}`);
  }
  res.redirect('/security');
});

// ------------------------------------------------- recuperacion (DR)

router.get('/dr', requireRole('admin'), async (req, res) => {
  res.render('dr', { title: 'Recuperacion ante desastres', s: await status.disasterRecovery() });
});

router.post('/dr/verify', requireRole('admin'), async (req, res) => {
  try {
    const r = await status.verifyRecovery(10);
    await audit(req, 'dr.verify', { targetType: 'database', targetId: r.server, outcome: r.outcome === 'success' ? 'success' : 'error', details: r });
    const errs = Object.entries(r.errors).map(([k, v]) => `${k}: ${v}`).join(', ');
    flash(req, r.outcome === 'success' ? 'success' : 'warning', `Verificacion en ${r.server}: ${r.customers} clientes, ${r.reservations} reservaciones; descifrado ${r.ok}/${r.sampled} clientes de muestra${errs ? ` (errores: ${errs})` : ''}.`);
  } catch (err) {
    flash(req, 'danger', `No se pudo verificar: [${err.code || 'ERROR'}] ${err.message}`);
  }
  res.redirect('/dr');
});

router.post('/dr/switch', requireRole('admin'), async (req, res) => {
  const host = String(req.body.host || '');
  if (!cfg.db.candidates.includes(host)) {
    flash(req, 'danger', 'Servidor no permitido.');
    return res.redirect('/dr');
  }
  const probe = await Database.probeHost(host);
  if (!probe.reachable) {
    flash(req, 'danger', `${host} no responde (${probe.error}). No se cambia la conexion.`);
    return res.redirect('/dr');
  }
  if (probe.in_recovery) {
    flash(req, 'warning', `${host} sigue en modo standby/recuperacion (solo lectura). Promuevalo primero; la aplicacion no escribe en un standby.`);
    return res.redirect('/dr');
  }
  db.switchTarget(host, { reason: 'GUI /dr', actor: req.session.user.username });
  await audit(req, 'dr.switch', { targetType: 'database', targetId: host });
  flash(req, 'success', `La aplicacion ahora usa ${host} (${probe.cluster_name}, linea de tiempo ${probe.timeline}).`);
  return res.redirect('/dr');
});

// --------------------------------------------------------------- cuentas

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
  res.render('accounts', { title: 'Cuentas de usuario', rows, total, page: Math.min(page, pages), pages, byRole, filters: { role, q } });
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
    return res.status(403).json({ error: 'FORBIDDEN', message: 'No tiene autorizacion para este cliente.' });
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
