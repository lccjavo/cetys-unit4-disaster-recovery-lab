'use strict';

/**
 * Envelope Encryption.
 *
 *   KEK (Key Vault) --wraps--> one DEK per customer (256 bits, random)
 *   DEK --AES-256-GCM--> each of the 20 sensitive fields
 *
 * Every field uses a fresh 96-bit nonce and AAD that binds it to:
 *   customer + field name + encryption schema version.
 * If someone copies ciphertext from one customer to another, or from one field to another,
 * GCM verification fails.
 */

const crypto = require('node:crypto');
const vault = require('../vaultClient');
const { SENSITIVE_KEYS } = require('../fields');

const ALGORITHM = 'aes-256-gcm';
const ALGORITHM_LABEL = 'AES-256-GCM';
const SCHEMA_VERSION = 1;

class DecryptionError extends Error {
  constructor(field) {
    super(`GCM authenticity verification failed for field ${field}`);
    this.code = 'DECRYPTION_AUTH_FAILED';
    this.status = 422;
  }
}

function fieldAad(customerId, field, version = SCHEMA_VERSION) {
  return Buffer.from(`hotel-lab|field|v${version}|customer:${customerId}|field:${field}`, 'utf8');
}

function dekContext(customerId, dekRef) {
  return `customer:${customerId}|dek_ref:${dekRef}`;
}

function encryptField(dek, customerId, field, plaintext) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, dek, nonce, { authTagLength: 16 });
  cipher.setAAD(fieldAad(customerId, field));
  const ciphertext = Buffer.concat([cipher.update(String(plaintext ?? ''), 'utf8'), cipher.final()]);
  return {
    alg: ALGORITHM_LABEL,
    v: SCHEMA_VERSION,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptField(dek, customerId, field, envelope) {
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, dek, Buffer.from(envelope.nonce, 'base64'), { authTagLength: 16 });
    decipher.setAAD(fieldAad(customerId, field, envelope.v || SCHEMA_VERSION));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new DecryptionError(field);
  }
}

/**
 * Generates a new DEK, encrypts the 20 fields and asks the Key Vault to wrap the DEK.
 * Returns ONLY encrypted material: nothing in the result can read the fields without the KEK.
 */
async function sealProfile(customerId, sensitive) {
  const missing = SENSITIVE_KEYS.filter((k) => !(k in sensitive));
  if (missing.length) throw new Error(`Missing sensitive fields: ${missing.join(', ')}`);
  const dek = crypto.randomBytes(32);
  const dekRef = crypto.randomUUID();
  try {
    const encryptedFields = {};
    for (const key of SENSITIVE_KEYS) encryptedFields[key] = encryptField(dek, customerId, key, sensitive[key]);
    const wrapped = await vault.wrapDek(dek, dekContext(customerId, dekRef));
    return {
      encryptedFields,
      key: {
        dek_ref: dekRef,
        wrapped_dek: wrapped.wrapped_dek,
        dek_wrap_nonce: wrapped.nonce,
        dek_wrap_tag: wrapped.tag,
        kek_id: wrapped.kek_id,
        wrap_algorithm: wrapped.algorithm,
        encryption_schema_version: SCHEMA_VERSION,
      },
    };
  } finally {
    dek.fill(0);
  }
}

/** Unwraps the DEK through the Key Vault and decrypts the requested fields. */
async function openFields(customerId, keyRow, encryptedFields, fields) {
  const { dek_b64: dekB64 } = await vault.unwrapDek(keyRow, dekContext(customerId, keyRow.dek_ref));
  const dek = Buffer.from(dekB64, 'base64');
  try {
    const values = {};
    for (const f of fields) {
      if (encryptedFields[f]) values[f] = decryptField(dek, customerId, f, encryptedFields[f]);
    }
    return values;
  } finally {
    dek.fill(0);
  }
}

module.exports = {
  ALGORITHM_LABEL,
  SCHEMA_VERSION,
  DecryptionError,
  encryptField,
  decryptField,
  fieldAad,
  dekContext,
  sealProfile,
  openFields,
};
