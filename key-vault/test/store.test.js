'use strict';

// Pruebas unitarias del almacen de llaves (usa un directorio temporal).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { VaultStore } = require('../src/store');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  const cfg = { dataDir: path.join(dir, 'keys'), backupDir: path.join(dir, 'backups'), backupPassphrase: 'prueba-unitaria' };
  return { store: new VaultStore(cfg), cfg };
}

test('inicializa kek-v1 una sola vez y crea respaldo automatico', () => {
  const { store } = freshStore();
  assert.equal(store.status(), 'UNINITIALIZED');
  const r = store.initialize('test');
  assert.equal(r.kek_id, 'kek-v1');
  assert.equal(store.listBackups().length, 1);
  assert.throws(() => store.initialize('test'), { code: 'ALREADY_INITIALIZED' });
});

test('wrap/unwrap con AAD de contexto', () => {
  const { store } = freshStore();
  store.initialize('test');
  const dek = crypto.randomBytes(32);
  const w = store.wrap(dek.toString('base64'), 'customer:1|dek_ref:a', 't');
  const u = store.unwrap({ ...w, context: 'customer:1|dek_ref:a' }, 't');
  assert.equal(u.dek_b64, dek.toString('base64'));
  assert.throws(() => store.unwrap({ ...w, context: 'customer:2|dek_ref:a' }, 't'), { code: 'UNWRAP_FAILED' });
});

test('rotacion: KEK historico sigue desenvolviendo; rewrap migra al activo', () => {
  const { store } = freshStore();
  store.initialize('test');
  const dek = crypto.randomBytes(32);
  const w1 = store.wrap(dek.toString('base64'), 'ctx-1', 't');
  store.rotate('test');
  assert.equal(store.activeKek().kek_id, 'kek-v2');
  assert.equal(store.unwrap({ ...w1, context: 'ctx-1' }, 't').dek_b64, dek.toString('base64'));
  const rw = store.rewrap([{ id: 1, ...w1, context: 'ctx-1' }], 't');
  assert.equal(rw.results[0].kek_id, 'kek-v2');
  assert.equal(store.unwrap({ ...rw.results[0], context: 'ctx-1' }, 't').dek_b64, dek.toString('base64'));
});

test('acceso deshabilitado produce un error controlado', () => {
  const { store } = freshStore();
  store.initialize('test');
  const w = store.wrap(crypto.randomBytes(32).toString('base64'), 'ctx', 't');
  store.setAccessDisabled(true, 't');
  assert.throws(() => store.unwrap({ ...w, context: 'ctx' }, 't'), { code: 'KEY_ACCESS_DISABLED' });
  store.setAccessDisabled(false, 't');
  assert.ok(store.unwrap({ ...w, context: 'ctx' }, 't').dek_b64);
});

test('perdida de keystore: no se regeneran llaves; se recupera desde respaldo', () => {
  const { store, cfg } = freshStore();
  store.initialize('test');
  const dek = crypto.randomBytes(32);
  const w = store.wrap(dek.toString('base64'), 'ctx', 't');
  const fpBefore = store.publicKeks()[0].fingerprint;
  store.simulateStorageLoss('t');
  assert.equal(store.status(), 'KEYSTORE_MISSING');
  assert.throws(() => store.unwrap({ ...w, context: 'ctx' }, 't'), { code: 'KEK_NOT_FOUND' });
  assert.throws(() => store.initialize('t'), { code: 'KEYSTORE_MISSING' });
  const reloaded = new VaultStore(cfg);
  assert.equal(reloaded.status(), 'KEYSTORE_MISSING');
  reloaded.restoreFromBackup(reloaded.listBackups()[0].file, 't');
  assert.equal(reloaded.publicKeks()[0].fingerprint, fpBefore);
  assert.equal(reloaded.unwrap({ ...w, context: 'ctx' }, 't').dek_b64, dek.toString('base64'));
});

test('restauracion rechaza un KEK distinto con el mismo kek_id', () => {
  const a = freshStore();
  a.store.initialize('t');
  const b = freshStore();
  b.store.initialize('t');
  const backupFile = a.store.listBackups()[0].file;
  fs.copyFileSync(path.join(a.cfg.backupDir, backupFile), path.join(b.cfg.backupDir, backupFile));
  assert.throws(() => b.store.restoreFromBackup(backupFile, 't'), { code: 'KEK_CONFLICT' });
});

test('respaldo con frase de paso incorrecta no se puede descifrar', () => {
  const a = freshStore();
  a.store.initialize('t');
  const other = new VaultStore({ ...a.cfg, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vault-x-')), backupPassphrase: 'otra' });
  assert.throws(() => other.restoreFromBackup(a.store.listBackups()[0].file, 't'), { code: 'BACKUP_DECRYPT_FAILED' });
});
