'use strict';

/**
 * Key Vault administration web interface (port 3001, published only on 127.0.0.1).
 * It does not expose the /api/v1/* cryptographic routes: those live on internal port 8200.
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
  if (!iso) return 'N/A';
  return new Date(iso).toLocaleString('en-US', { timeZone: 'America/Tijuana', hour12: false });
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

  // CSRF: per-session synchronizer token.
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
        return res.status(403).render('error', { title: 'Request rejected', message: 'Invalid CSRF token. Reload the page.' });
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
    return res.render('login', { title: 'Key Vault sign-in', error: null, username: '' });
  });

  app.post('/login', (req, res) => {
    const key = req.ip;
    const rec = loginAttempts.get(key) || { count: 0, first: Date.now() };
    if (Date.now() - rec.first > 5 * 60 * 1000) {
      rec.count = 0;
      rec.first = Date.now();
    }
    if (rec.count >= 10) {
      return res.status(429).render('login', { title: 'Key Vault sign-in', error: 'Too many attempts. Wait 5 minutes.', username: '' });
    }
    const { username = '', password = '' } = req.body;
    const ok = safeEqual(username, cfg.adminUser) && safeEqual(password, cfg.adminPassword);
    if (!ok) {
      rec.count += 1;
      loginAttempts.set(key, rec);
      store.event('gui-login', username.slice(0, 60), 'denied');
      return res.status(401).render('login', { title: 'Key Vault sign-in', error: 'Incorrect username or password.', username });
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
    res.render('dashboard', { title: 'Key Vault dashboard', s: store.summary(), events: store.state.events.slice(-8).reverse() });
  });

  app.get('/keys', (req, res) => {
    res.render('keys', { title: 'KEK management', s: store.summary() });
  });

  app.get('/rotation', (req, res) => {
    res.render('rotation', { title: 'Key rotation', s: store.summary() });
  });

  app.post('/rotation', (req, res) => {
    const r = store.rotate(actor(req));
    flash(req, 'success', `New active KEK: ${r.kek_id}. ${r.previous} is retired but still available for unwrapping. Automatic backup: ${r.backup}`);
    res.redirect('/rotation');
  });

  app.get('/backups', (req, res) => {
    res.render('backups', { title: 'KEK backup and recovery', s: store.summary(), backups: store.listBackups(), backupDir: cfg.backupDir });
  });

  app.post('/backups', (req, res) => {
    const r = store.createBackup('manual', actor(req));
    flash(req, 'success', `Backup created: ${r.file} (KEKs: ${r.kek_ids.join(', ')})`);
    res.redirect('/backups');
  });

  app.post('/backups/restore', (req, res) => {
    const r = store.restoreFromBackup(String(req.body.file || ''), actor(req));
    const added = r.added.length ? `Added: ${r.added.join(', ')}.` : 'No KEK was missing.';
    flash(req, 'success', `Restore from ${r.file} completed. ${added} Active KEK: ${r.active_kek_id}`);
    res.redirect('/backups');
  });

  app.get('/disaster', (req, res) => {
    res.render('disaster', { title: 'Disaster simulation', s: store.summary(), backups: store.listBackups() });
  });

  app.post('/disaster/access', (req, res) => {
    const disable = req.body.action === 'disable';
    store.setAccessDisabled(disable, actor(req));
    flash(req, disable ? 'warning' : 'success', disable
      ? 'Key access DISABLED. Wrap/unwrap operations will be rejected.'
      : 'Key access restored.');
    res.redirect('/disaster');
  });

  app.post('/disaster/outage', (req, res) => {
    const enable = req.body.action === 'enable';
    store.setSimulatedOutage(enable, actor(req));
    flash(req, enable ? 'warning' : 'success', enable
      ? 'Simulated outage ACTIVE: the internal API returns 503 to every request.'
      : 'Simulated outage ended: the internal API responds again.');
    res.redirect('/disaster');
  });

  app.post('/disaster/storage-loss', (req, res) => {
    if (req.body.confirm !== 'LOSE-KEYSTORE') {
      flash(req, 'danger', 'Incorrect confirmation. Type LOSE-KEYSTORE to continue.');
      return res.redirect('/disaster');
    }
    const r = store.simulateStorageLoss(actor(req));
    flash(req, 'danger', `KEK storage "lost". The file was moved to quarantine (${r.quarantined_as}). Restore from a backup.`);
    return res.redirect('/disaster');
  });

  app.get('/audit', (req, res) => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const per = 25;
    const all = store.state.events.slice().reverse();
    const pages = Math.max(1, Math.ceil(all.length / per));
    res.render('audit', { title: 'Operations log', events: all.slice((page - 1) * per, page * per), page, pages, total: all.length });
  });

  app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'The requested page does not exist.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const message = err instanceof VaultError ? `${err.code}: ${err.message}` : 'Key Vault internal error.';
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
