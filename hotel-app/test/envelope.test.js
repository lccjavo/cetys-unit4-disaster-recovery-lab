'use strict';

// Pruebas unitarias del cifrado de campos (no requieren PostgreSQL ni Key Vault).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { encryptField, decryptField } = require('../src/crypto/envelope');
const { SENSITIVE_FIELDS, OPERATIONAL_FIELDS } = require('../src/fields');
const { generateSeedData } = require('../src/data/generator');
const policy = require('../src/policy');

test('clasificacion: exactamente 20 campos sensibles y 20 operativos', () => {
  assert.equal(SENSITIVE_FIELDS.length, 20);
  assert.equal(OPERATIONAL_FIELDS.length, 20);
});

test('AES-256-GCM: cifra y descifra; nonce de 96 bits distinto en cada operacion', () => {
  const dek = crypto.randomBytes(32);
  const a = encryptField(dek, 7, 'phone_number', '+52 664 555 0101');
  const b = encryptField(dek, 7, 'phone_number', '+52 664 555 0101');
  assert.equal(Buffer.from(a.nonce, 'base64').length, 12);
  assert.equal(Buffer.from(a.tag, 'base64').length, 16);
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.equal(decryptField(dek, 7, 'phone_number', a), '+52 664 555 0101');
});

test('AAD liga el ciphertext al cliente y al campo', () => {
  const dek = crypto.randomBytes(32);
  const env = encryptField(dek, 7, 'clabe', '999180000000000001');
  assert.throws(() => decryptField(dek, 8, 'clabe', env), { code: 'DECRYPTION_AUTH_FAILED' });
  assert.throws(() => decryptField(dek, 7, 'bank_account_number', env), { code: 'DECRYPTION_AUTH_FAILED' });
});

test('GCM detecta alteraciones del ciphertext y DEK incorrecto', () => {
  const dek = crypto.randomBytes(32);
  const env = encryptField(dek, 1, 'passport_number', 'LAB123456');
  const ct = Buffer.from(env.ciphertext, 'base64');
  ct[0] ^= 0xff;
  assert.throws(() => decryptField(dek, 1, 'passport_number', { ...env, ciphertext: ct.toString('base64') }), { code: 'DECRYPTION_AUTH_FAILED' });
  assert.throws(() => decryptField(crypto.randomBytes(32), 1, 'passport_number', env), { code: 'DECRYPTION_AUTH_FAILED' });
});

test('generador reproducible: misma semilla produce los mismos perfiles', () => {
  const opts = { count: 150, seed: 'CETYS-UNIDAD-4-2026', referenceDate: '2026-11-23' };
  const a = generateSeedData(opts);
  const b = generateSeedData(opts);
  assert.equal(a.length, 150);
  assert.deepEqual(a.map((x) => x.sensitive), b.map((x) => x.sensitive));
  assert.equal(a[0].fullName, 'Ana Lucía Martínez Ruiz');
  for (const p of a) {
    assert.equal(Object.keys(p.sensitive).length, 20);
    assert.equal(Object.keys(p.operational).length, 20);
    assert.match(p.sensitive.personal_email, /\.test$/);
    assert.match(p.sensitive.clabe, /^999\d{15}$/);
  }
});

test('autorizacion a nivel de objeto (BOLA/IDOR)', () => {
  const owner = { id: 10, role: 'customer' };
  const other = { id: 11, role: 'customer' };
  const staff = { id: 2, role: 'staff' };
  const admin = { id: 1, role: 'admin' };
  const customer = { id: 5, user_id: 10 };
  assert.equal(policy.canViewCustomer(owner, customer), true);
  assert.equal(policy.canViewCustomer(other, customer), false);
  assert.deepEqual(policy.revealableFields(other, customer), []);
  assert.equal(policy.revealableFields(owner, customer).length, 20);
  assert.equal(policy.revealableFields(admin, customer).length, 20);
  const staffFields = policy.revealableFields(staff, customer);
  assert.ok(staffFields.includes('phone_number'));
  assert.ok(!staffFields.includes('card_number'));
  assert.equal(policy.canListCustomers(owner), false);
});
