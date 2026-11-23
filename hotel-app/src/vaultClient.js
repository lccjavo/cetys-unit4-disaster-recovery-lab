'use strict';

/**
 * Cliente HTTP de la API interna del Key Vault.
 * La aplicacion del hotel es la unica que orquesta cifrado y descifrado:
 * PostgreSQL nunca se conecta al Key Vault.
 */

const cfg = require('./config');

class VaultError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const MESSAGES = {
  VAULT_UNAVAILABLE: 'Key Vault no disponible: los campos cifrados no se pueden leer temporalmente.',
  KEY_ACCESS_DISABLED: 'El acceso a las llaves esta deshabilitado en el Key Vault.',
  KEK_NOT_FOUND: 'KEK no encontrado en el Key Vault. Los datos cifrados se conservan, pero no se pueden descifrar hasta recuperar el KEK.',
  UNWRAP_FAILED: 'Fallo la autenticacion del DEK envuelto (KEK incorrecto o datos alterados).',
  UNAUTHORIZED: 'El Key Vault rechazo el token de servicio del hotel.',
};

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(`${cfg.vault.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${cfg.vault.token}`,
        'content-type': 'application/json',
        'x-client-service': 'hotel-app',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(cfg.vault.timeoutMs),
    });
  } catch {
    throw new VaultError('VAULT_UNAVAILABLE', MESSAGES.VAULT_UNAVAILABLE, 503);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = json.error || (res.status === 503 ? 'VAULT_UNAVAILABLE' : 'VAULT_ERROR');
    throw new VaultError(code, MESSAGES[code] || json.message || 'Error del Key Vault', res.status);
  }
  return json;
}

// Estado en cache para no consultar al Key Vault en cada pagina.
const cache = { at: 0, value: null };

async function health({ fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < 3000) return cache.value;
  let value;
  try {
    const h = await call('GET', '/api/v1/health');
    value = { available: true, ...h };
  } catch (err) {
    value = { available: false, error: err.code, message: err.message };
  }
  cache.at = Date.now();
  cache.value = value;
  return value;
}

function lastHealth() {
  return cache.value || { available: false, error: 'UNKNOWN', message: 'Estado del Key Vault aun no verificado' };
}

module.exports = {
  VaultError,
  health,
  lastHealth,
  status: () => call('GET', '/api/v1/status'),
  initialize: () => call('POST', '/api/v1/admin/initialize'),
  wrapDek: (dek, context) => call('POST', '/api/v1/wrap', { dek_b64: dek.toString('base64'), context }),
  unwrapDek: (meta, context) =>
    call('POST', '/api/v1/unwrap', {
      kek_id: meta.kek_id,
      wrapped_dek: meta.wrapped_dek,
      nonce: meta.dek_wrap_nonce,
      tag: meta.dek_wrap_tag,
      context,
    }),
  rewrap: (items) => call('POST', '/api/v1/rewrap', { items }),
};
