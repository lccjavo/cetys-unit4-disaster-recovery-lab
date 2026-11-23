'use strict';

const cfg = require('./config');
const { VaultStore } = require('./store');
const { createApi } = require('./api');
const { createGui } = require('./gui');

const store = new VaultStore(cfg);

if (cfg.usingDefaultSecrets.length) {
  console.warn(`[vault] AVISO: usando secretos por defecto para ${cfg.usingDefaultSecrets.join(', ')}. Ejecute ./scripts/setup-env.sh`);
}

const api = createApi(store, cfg).listen(cfg.apiPort, '0.0.0.0', () => {
  console.log(`[vault] API interna escuchando en :${cfg.apiPort} (no publicada al anfitrion)`);
});
const gui = createGui(store, cfg).listen(cfg.guiPort, '0.0.0.0', () => {
  console.log(`[vault] GUI de administracion escuchando en :${cfg.guiPort}`);
  console.log(`[vault] Estado del almacen: ${store.status()}; KEK activo: ${store.activeKek() ? store.activeKek().kek_id : 'ninguno'}`);
});

function shutdown(signal) {
  console.log(`[vault] ${signal} recibido; guardando estado`);
  try {
    store.saveStateNow();
  } catch (err) {
    console.error('[vault] error guardando estado:', err.message);
  }
  api.close();
  gui.close();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
