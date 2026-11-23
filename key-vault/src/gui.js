'use strict';

/**
 * Interfaz web de administracion del Key Vault (puerto 3001, publicado solo en 127.0.0.1).
 * No expone las rutas criptograficas /api/v1/*: esas viven en el puerto interno 8200.
 */

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const helmet = require('helmet');
const { VaultError } = require('./store');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function fmtDate(iso) {
  if (!iso) return 'N/D';
  return new Date(iso).toLocaleString('es-MX', { timeZone: 'America/Tijuana', hour12: false });
}

function createGui(store, cfg) {
  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: null,
        },
      },
      hsts: false,
      crossOriginOpenerPolicy: false,
    }),
  );

  const nm = path.join(__dirname, '..', 'node_modules');
  app.use('/vendor/bootstrap', express.static(path.join(nm, 'bootstrap', 'dist'), { maxAge: '1d' }));
  app.use('/vendor/bootstrap-icons', express.static(path.join(nm, 'bootstrap-icons', 'font'), { maxAge: '1d' }));
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

  app.get('/healthz', (req, res) => {
    res.json({ status: 'ok', vault_status: store.status(), gui: true });
  });

  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(
    session({
      name: 'vault.sid',
      secret: cfg.sessionSecret,
      resave: false,
      saveUninitialized: false,
      store: new MemoryStore({ checkPeriod: 3600 * 1000 }),
      cookie: { httpOnly: true, sameSite: 'strict', secure: false, maxAge: 4 * 3600 * 1000 },
    }),
  );

  // CSRF: token sincronizado por sesion.
  app.use((req, res, next) => {
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
    res.locals.csrf = req.session.csrf;
    res.locals.admin = req.session.admin || null;
    res.locals.flash = req.session.flash || null;
    res.locals.fmtDate = fmtDate;
    res.locals.path = req.path;
    res.locals.defaultSecrets = cfg.usingDefaultSecrets;
    delete req.session.flash;
    if (req.method === 'POST') {
      const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
      if (!safeEqual(sent, req.session.csrf)) {
        return res.status(403).render('error', { title: 'Solicitud rechazada', message: 'Token CSRF invalido. Recargue la pagina.' });
      }
    }
    return next();
  });

  const flash = (req, type, message) => {
    req.session.flash = { type, message };
  };

  const loginAttempts = new Map();

  app.get('/login', (req, res) => {
    if (req.session.admin) return res.redirect('/');
    return res.render('login', { title: 'Acceso al Key Vault', error: null, username: '' });
  });

  app.post('/login', (req, res) => {
    const key = req.ip;
    const rec = loginAttempts.get(key) || { count: 0, first: Date.now() };
    if (Date.now() - rec.first > 5 * 60 * 1000) {
      rec.count = 0;
      rec.first = Date.now();
    }
    if (rec.count >= 10) {
      return res.status(429).render('login', { title: 'Acceso al Key Vault', error: 'Demasiados intentos. Espere 5 minutos.', username: '' });
    }
    const { username = '', password = '' } = req.body;
    const ok = safeEqual(username, cfg.adminUser) && safeEqual(password, cfg.adminPassword);
    if (!ok) {
      rec.count += 1;
      loginAttempts.set(key, rec);
      store.event('gui-login', username.slice(0, 60), 'denied');
      return res.status(401).render('login', { title: 'Acceso al Key Vault', error: 'Usuario o contrasena incorrectos.', username });
    }
    loginAttempts.delete(key);
    return req.session.regenerate((err) => {
      if (err) throw err;
      req.session.admin = { username: cfg.adminUser, since: new Date().toISOString() };
      req.session.csrf = crypto.randomBytes(24).toString('hex');
      store.event('gui-login', cfg.adminUser, 'success');
      res.redirect('/');
    });
  });

  app.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
  });

  app.use((req, res, next) => {
    if (!req.session.admin) return res.redirect('/login');
    return next();
  });

  const actor = (req) => `gui:${req.session.admin.username}`;

  app.get('/', (req, res) => {
    res.render('dashboard', { title: 'Panel del Key Vault', s: store.summary(), events: store.state.events.slice(-8).reverse() });
  });

  app.get('/keys', (req, res) => {
    res.render('keys', { title: 'Gestion de KEK', s: store.summary() });
  });

  app.get('/rotation', (req, res) => {
    res.render('rotation', { title: 'Rotacion de llaves', s: store.summary() });
  });

  app.post('/rotation', (req, res) => {
    const r = store.rotate(actor(req));
    flash(req, 'success', `Nuevo KEK activo: ${r.kek_id}. ${r.previous} queda retirado pero disponible para desenvolver. Respaldo automatico: ${r.backup}`);
    res.redirect('/rotation');
  });

  app.get('/backups', (req, res) => {
    res.render('backups', { title: 'Respaldo y recuperacion de KEK', s: store.summary(), backups: store.listBackups(), backupDir: cfg.backupDir });
  });

  app.post('/backups', (req, res) => {
    const r = store.createBackup('manual', actor(req));
    flash(req, 'success', `Respaldo creado: ${r.file} (KEKs: ${r.kek_ids.join(', ')})`);
    res.redirect('/backups');
  });

  app.post('/backups/restore', (req, res) => {
    const r = store.restoreFromBackup(String(req.body.file || ''), actor(req));
    const added = r.added.length ? `Agregados: ${r.added.join(', ')}.` : 'No faltaba ningun KEK.';
    flash(req, 'success', `Restauracion desde ${r.file} completada. ${added} KEK activo: ${r.active_kek_id}`);
    res.redirect('/backups');
  });

  app.get('/disaster', (req, res) => {
    res.render('disaster', { title: 'Simulacion de desastres', s: store.summary(), backups: store.listBackups() });
  });

  app.post('/disaster/access', (req, res) => {
    const disable = req.body.action === 'disable';
    store.setAccessDisabled(disable, actor(req));
    flash(req, disable ? 'warning' : 'success', disable
      ? 'Acceso a llaves DESHABILITADO. Las operaciones wrap/unwrap seran rechazadas.'
      : 'Acceso a llaves restablecido.');
    res.redirect('/disaster');
  });

  app.post('/disaster/outage', (req, res) => {
    const enable = req.body.action === 'enable';
    store.setSimulatedOutage(enable, actor(req));
    flash(req, enable ? 'warning' : 'success', enable
      ? 'Interrupcion simulada ACTIVA: la API interna responde 503 a todas las solicitudes.'
      : 'Interrupcion simulada finalizada: la API interna vuelve a responder.');
    res.redirect('/disaster');
  });

  app.post('/disaster/storage-loss', (req, res) => {
    if (req.body.confirm !== 'PERDER-KEYSTORE') {
      flash(req, 'danger', 'Confirmacion incorrecta. Escriba PERDER-KEYSTORE para continuar.');
      return res.redirect('/disaster');
    }
    const r = store.simulateStorageLoss(actor(req));
    flash(req, 'danger', `Almacenamiento de KEK "perdido". El archivo se movio a cuarentena (${r.quarantined_as}). Restaure desde un respaldo.`);
    return res.redirect('/disaster');
  });

  app.get('/audit', (req, res) => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const per = 25;
    const all = store.state.events.slice().reverse();
    const pages = Math.max(1, Math.ceil(all.length / per));
    res.render('audit', { title: 'Bitacora de operaciones', events: all.slice((page - 1) * per, page * per), page, pages, total: all.length });
  });

  app.use((req, res) => res.status(404).render('error', { title: 'No encontrado', message: 'La pagina solicitada no existe.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const message = err instanceof VaultError ? `${err.code}: ${err.message}` : 'Error interno del Key Vault.';
    if (!(err instanceof VaultError)) console.error('[vault-gui] error:', err.message);
    if (req.session && req.session.admin && req.method === 'POST') {
      flash(req, 'danger', message);
      return res.redirect(req.get('referer') && new URL(req.get('referer')).pathname || '/');
    }
    return res.status(err.status || 500).render('error', { title: 'Error', message });
  });

  return app;
}

module.exports = { createGui };
