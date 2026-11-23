'use strict';

const cfg = require('./config');
const { VaultStore } = require('./store');
const { createApi } = require('./api');
const { createGui } = require('./gui');

const store = new VaultStore(cfg);

if (cfg.usingDefaultSecrets.length) {
  console.warn(`[vault] WARNING: using default secrets for ${cfg.usingDefaultSecrets.join(', ')}. Run ./scripts/setup-env.sh`);
}

const api = createApi(store, cfg).listen(cfg.apiPort, '0.0.0.0', () => {
  console.log(`[vault] Internal API listening on :${cfg.apiPort} (not published to the host)`);
});
const gui = createGui(store, cfg).listen(cfg.guiPort, '0.0.0.0', () => {
  console.log(`[vault] Administration GUI listening on :${cfg.guiPort}`);
  console.log(`[vault] Key store status: ${store.status()}; active KEK: ${store.activeKek() ? store.activeKek().kek_id : 'none'}`);
});

function shutdown(signal) {
  console.log(`[vault] ${signal} received; saving state`);
  try {
    store.saveStateNow();
  } catch (err) {
    console.error('[vault] error saving state:', err.message);
  }
  api.close();
  gui.close();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
