'use strict';

/** Middleware comun: sesiones, CSRF, autenticacion, mensajes flash y utilidades de vistas. */

const crypto = require('node:crypto');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const cfg = require('./config');
const { db } = require('./db');
const vault = require('./vaultClient');
const fields = require('./fields');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sessionMiddleware() {
  // Sesiones en memoria: sobreviven a caidas de PostgreSQL (la GUI sigue informando durante el desastre).
  return session({
    name: 'hotel.sid',
    secret: cfg.sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: new MemoryStore({ checkPeriod: 3600 * 1000 }),
    cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 8 * 3600 * 1000 },
  });
}

function fmtDate(value, withTime = true) {
  if (!value) return 'N/D';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('es-MX', withTime ? { timeZone: 'America/Tijuana', hour12: false } : { timeZone: 'UTC', dateStyle: 'medium' });
}

function money(n) {
  return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
}

function locals(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  res.locals.user = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.path = req.path;
  res.locals.dbHealth = { target: db.target, ...db.health };
  res.locals.vaultHealth = vault.lastHealth();
  res.locals.fmtDate = fmtDate;
  res.locals.money = money;
  res.locals.F = fields;
  res.locals.labMode = cfg.labMode;
  res.locals.query = req.query || {};
  res.locals.qs = (overrides) => {
    const params = new URLSearchParams({ ...(req.query || {}), ...overrides });
    for (const [k, v] of [...params.entries()]) if (v === '' || v === undefined) params.delete(k);
    return `?${params.toString()}`;
  };
  next();
}

function csrfCheck(req, res, next) {
  if (req.method !== 'POST') return next();
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
  if (!safeEqual(sent, req.session.csrf || '')) {
    if (req.is('application/json')) return res.status(403).json({ error: 'CSRF', message: 'Token CSRF invalido. Recargue la pagina.' });
    return res.status(403).render('error', { title: 'Solicitud rechazada', message: 'Token CSRF invalido. Recargue la pagina e intente de nuevo.', code: 'CSRF' });
  }
  return next();
}

function flash(req, type, message) {
  req.session.flash = { type, message };
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    if (req.is('application/json') || req.path.startsWith('/api/')) return res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Inicie sesion.' });
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      const err = new Error('Su rol no tiene acceso a esta seccion.');
      err.status = 403;
      err.code = 'FORBIDDEN';
      return next(err);
    }
    return next();
  };
}

module.exports = { sessionMiddleware, locals, csrfCheck, flash, requireAuth, requireRole, safeEqual };
