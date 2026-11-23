'use strict';

/**
 * HTTP client for the Key Vault internal API.
 * The hotel application is the only component that orchestrates encryption and decryption:
 * PostgreSQL never connects to the Key Vault.
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
  VAULT_UNAVAILABLE: 'Key Vault unavailable: encrypted fields are temporarily unreadable.',
  KEY_ACCESS_DISABLED: 'Key access is disabled in the Key Vault.',
  KEK_NOT_FOUND: 'KEK not found in the Key Vault. The encrypted data is preserved but cannot be decrypted until the KEK is recovered.',
  UNWRAP_FAILED: 'Wrapped DEK authentication failed (wrong KEK or tampered data).',
  UNAUTHORIZED: 'The Key Vault rejected the hotel service token.',
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
    throw new VaultError(code, MESSAGES[code] || json.message || 'Key Vault error', res.status);
  }
  return json;
}

// Cached state so the Key Vault is not queried on every page.
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
  return cache.value || { available: false, error: 'UNKNOWN', message: 'Key Vault status not checked yet' };
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
