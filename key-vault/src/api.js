'use strict';

/**
 * Key Vault internal API (port 8200). Only reachable inside the Docker network;
 * docker-compose.yml does NOT publish this port to the host.
 * Every route except /api/v1/health requires the service token.
 */

const crypto = require('node:crypto');
const express = require('express');
const { VaultError } = require('./store');

function tokenMatches(expected, provided) {
  const a = crypto.createHash('sha256').update(String(expected)).digest();
  const b = crypto.createHash('sha256').update(String(provided || '')).digest();
  return crypto.timingSafeEqual(a, b);
}

function createApi(store, cfg) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // "Service unavailable" simulation: everything returns 503, including health.
  // /admin/* routes called from inside the container (CLI) keep working,
  // so the simulation can be ended from ./scripts/... even without the GUI.
  app.use((req, res, next) => {
    const addr = req.socket.remoteAddress || '';
    const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    if (store.state.simulated_outage && !(loopback && req.path.startsWith('/api/v1/admin/'))) {
      return res.status(503).json({ error: 'VAULT_UNAVAILABLE', message: 'Key Vault in simulated outage' });
    }
    return next();
  });

  app.get('/api/v1/health', (req, res) => {
    const s = store.summary();
    res.json({
      status: 'ok',
      vault_status: s.vault_status,
      active_kek_id: s.active_kek_id,
      access_disabled: s.access_disabled,
      kek_count: s.kek_count,
    });
  });

  app.use('/api/v1', (req, res, next) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!tokenMatches(cfg.serviceToken, token)) {
      store.state.counters.denied += 1;
      store.event('api-auth', req.get('x-client-service') || 'unknown', 'denied', { path: req.path });
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid service token' });
    }
    req.actor = `service:${req.get('x-client-service') || 'unknown'}`;
    return next();
  });

  app.get('/api/v1/status', (req, res) => {
    const s = store.summary();
    delete s.rotation_history;
    res.json(s);
  });

  app.post('/api/v1/admin/initialize', (req, res) => {
    res.status(201).json(store.initialize(req.actor));
  });

  app.post('/api/v1/wrap', (req, res) => {
    res.json(store.wrap(req.body.dek_b64, req.body.context, req.actor));
  });

  app.post('/api/v1/unwrap', (req, res) => {
    const { kek_id, wrapped_dek, nonce, tag, context } = req.body || {};
    res.json(store.unwrap({ kek_id, wrapped_dek, nonce, tag, context }, req.actor));
  });

  app.post('/api/v1/rewrap', (req, res) => {
    const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 500) : [];
    res.json(store.rewrap(items, req.actor));
  });

  app.post('/api/v1/admin/backup', (req, res) => {
    res.status(201).json(store.createBackup(req.body.reason || 'cli', req.actor));
  });

  app.get('/api/v1/admin/backups', (req, res) => {
    res.json({ backups: store.listBackups() });
  });

  app.post('/api/v1/admin/restore', (req, res) => {
    res.json(store.restoreFromBackup(String(req.body.file || ''), req.actor));
  });

  app.post('/api/v1/admin/access', (req, res) => {
    store.setAccessDisabled(Boolean(req.body.disabled), req.actor);
    res.json({ access_disabled: store.state.access_disabled });
  });

  app.post('/api/v1/admin/outage', (req, res) => {
    store.setSimulatedOutage(Boolean(req.body.enabled), req.actor);
    res.json({ simulated_outage: store.state.simulated_outage });
  });

  app.post('/api/v1/admin/rotate', (req, res) => {
    res.status(201).json(store.rotate(req.actor));
  });

  app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof VaultError) {
      return res.status(err.status).json({ error: err.code, message: err.message });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'BAD_REQUEST' });
    console.error('[vault-api] internal error:', err.message);
    store.state.counters.errors += 1;
    return res.status(500).json({ error: 'INTERNAL', message: 'Key Vault internal error' });
  });

  return app;
}

module.exports = { createApi };
