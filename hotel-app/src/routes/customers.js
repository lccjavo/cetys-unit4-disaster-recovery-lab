'use strict';

const express = require('express');
const customers = require('../services/customers');
const reservations = require('../services/reservations');
const { audit } = require('../services/audit');
const { randomProfile } = require('../data/generator');
const policy = require('../policy');
const { SENSITIVE_KEYS, SENSITIVE_FIELDS } = require('../fields');
const { flash, requireRole } = require('../web');

const router = express.Router();

async function loadAuthorized(req, res, next) {
  const customer = await customers.getById(req.params.id);
  if (!customer) {
    const err = new Error('The requested customer does not exist.');
    err.status = 404;
    return next(err);
  }
  if (!policy.canViewCustomer(req.session.user, customer)) {
    // BOLA/IDOR attempt: blocked in the backend and audited.
    await audit(req, 'customer.view', { targetType: 'customer', targetId: customer.id, outcome: 'denied' });
    return next(new policy.ForbiddenError('You are not authorized to view another customer\'s profile.'));
  }
  req.customer = customer;
  return next();
}

router.get('/', requireRole('admin', 'staff'), async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const country = String(req.query.country || '');
  const city = String(req.query.city || '');
  const status = String(req.query.status || '');
  const sort = String(req.query.sort || 'code');
  const dir = req.query.dir === 'desc' ? 'desc' : 'asc';
  const page = Number.parseInt(req.query.page, 10) || 1;
  const [result, facets] = await Promise.all([
    customers.list({ q, country, city, status, sort, dir, page }),
    customers.facets(country),
  ]);
  res.render('customers/index', { title: 'Customer directory', result, facets, filters: { q, country, city, status, sort, dir } });
});

router.get('/new', requireRole('admin', 'staff'), (req, res) => {
  res.render('customers/new', { title: 'New customer', errors: [], form: { status: 'active' } });
});

router.get('/generate', requireRole('admin', 'staff'), (req, res) => {
  const p = randomProfile();
  const suffix = Math.floor(Math.random() * 9000 + 1000);
  res.json({
    full_name: p.fullName,
    username: `new.customer${suffix}@hotel-lab.test`,
    status: p.status,
    ...p.operational,
    ...p.sensitive,
  });
});

router.post('/', requireRole('admin', 'staff'), async (req, res) => {
  const { errors, value } = customers.validateNew(req.body);
  if (errors.length) return res.status(422).render('customers/new', { title: 'New customer', errors, form: req.body });
  try {
    const created = await customers.create(value);
    await audit(req, 'customer.create', { targetType: 'customer', targetId: created.customerId, details: { code: created.code, kek_id: created.kekId } });
    flash(req, 'success', `Customer ${created.code} created. Its 20 sensitive fields were encrypted with a new DEK wrapped by ${created.kekId}.`);
    return res.redirect(`/customers/${created.customerId}#tab-encryption`);
  } catch (err) {
    if (['DUPLICATE', 'VAULT_UNAVAILABLE', 'KEY_ACCESS_DISABLED', 'KEK_NOT_FOUND', 'DB_UNAVAILABLE'].includes(err.code) || err.code === '25006') {
      const message = err.code === '25006' ? 'The current server is a read-only standby.' : err.message;
      return res.status(err.status || 503).render('customers/new', { title: 'New customer', errors: [message], form: req.body });
    }
    throw err;
  }
});

router.get('/:id', loadAuthorized, async (req, res) => {
  const c = req.customer;
  const resv = await reservations.list({ customerId: c.id, pageSize: 50 });
  const allowed = policy.revealableFields(req.session.user, c);
  await audit(req, 'customer.view', { targetType: 'customer', targetId: c.id });
  const fieldMeta = c.encrypted_fields
    ? SENSITIVE_FIELDS.map((f) => {
        const env = c.encrypted_fields[f.key] || {};
        return { key: f.key, label: f.label, nonce: env.nonce, tag: env.tag, ct: env.ciphertext, ctBytes: env.ciphertext ? Buffer.from(env.ciphertext, 'base64').length : 0 };
      })
    : [];
  res.render('customers/show', { title: c.full_name, c, reservations: resv.rows, allowed, fieldMeta });
});

router.post('/:id/reveal', loadAuthorized, async (req, res) => {
  const c = req.customer;
  const requested = Array.isArray(req.body.fields) ? req.body.fields.filter((f) => SENSITIVE_KEYS.includes(f)) : [];
  if (!requested.length) return res.status(400).json({ error: 'BAD_REQUEST', message: 'Specify the fields to reveal.' });
  const allowedSet = new Set(policy.revealableFields(req.session.user, c));
  const permitted = requested.filter((f) => allowedSet.has(f));
  const denied = requested.filter((f) => !allowedSet.has(f));
  if (!permitted.length) {
    await audit(req, 'customer.reveal', { targetType: 'customer', targetId: c.id, outcome: 'denied', details: { fields: denied } });
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Your role is not authorized to reveal these fields.', denied });
  }
  const started = Date.now();
  try {
    const values = await customers.reveal(c, permitted);
    await audit(req, 'customer.reveal', { targetType: 'customer', targetId: c.id, details: { fields: permitted, denied, kek_id: c.kek_id } });
    return res.json({ values, denied, kek_id: c.kek_id, elapsed_ms: Date.now() - started });
  } catch (err) {
    await audit(req, 'customer.reveal', { targetType: 'customer', targetId: c.id, outcome: 'error', details: { fields: permitted, error: err.code } });
    return res.status(err.status || 500).json({ error: err.code || 'ERROR', message: err.message, kek_id: c.kek_id });
  }
});

module.exports = { router, loadAuthorized };
