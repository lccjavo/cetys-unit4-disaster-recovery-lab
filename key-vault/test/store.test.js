'use strict';

// Key store unit tests (uses a temporary directory).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { VaultStore } = require('../src/store');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  const cfg = { dataDir: path.join(dir, 'keys'), backupDir: path.join(dir, 'backups'), backupPassphrase: 'unit-test' };
  return { store: new VaultStore(cfg), cfg };
}

const dek = () => crypto.randomBytes(32);
const b64 = (b) => b.toString('base64');

test('initializes the key store only once and creates an automatic backup', () => {
  const { store } = freshStore();
  assert.equal(store.status(), 'UNINITIALIZED');
  store.initialize('test');
  assert.equal(store.status(), 'READY');
  assert.equal(store.listBackups().length, 1);
  assert.throws(() => store.initialize('test'), { code: 'ALREADY_INITIALIZED' });
});

test('every customer gets its own KEK on first wrap', () => {
  const { store } = freshStore();
  store.initialize('test');
  const a = store.wrap(b64(dek()), 'customer:1|dek_ref:a', 'CUS-0001', 't');
  const b = store.wrap(b64(dek()), 'customer:2|dek_ref:b', 'CUS-0002', 't');
  const a2 = store.wrap(b64(dek()), 'customer:1|dek_ref:c', 'CUS-0001', 't');
  assert.equal(a.kek_id, 'kek-cus-0001-v1');
  assert.equal(b.kek_id, 'kek-cus-0002-v1');
  assert.equal(a2.kek_id, 'kek-cus-0001-v1');
  assert.equal(a.kek_created, true);
  assert.equal(a2.kek_created, false);
  assert.equal(store.summary().owner_count, 2);
  assert.notEqual(store.getKek('kek-cus-0001-v1').fingerprint, store.getKek('kek-cus-0002-v1').fingerprint);
});

test('wrap/unwrap with context AAD and owner check', () => {
  const { store } = freshStore();
  store.initialize('test');
  const d = dek();
  const w = store.wrap(b64(d), 'customer:1|dek_ref:a', 'CUS-0001', 't');
  const u = store.unwrap({ ...w, context: 'customer:1|dek_ref:a', owner: 'CUS-0001' }, 't');
  assert.equal(u.dek_b64, b64(d));
  assert.equal(u.owner, 'CUS-0001');
  assert.throws(() => store.unwrap({ ...w, context: 'customer:2|dek_ref:a', owner: 'CUS-0001' }, 't'), { code: 'UNWRAP_FAILED' });
  // The KEK of CUS-0001 cannot be used to open a DEK on behalf of another customer.
  assert.throws(() => store.unwrap({ ...w, context: 'customer:1|dek_ref:a', owner: 'CUS-0002' }, 't'), { code: 'KEK_OWNER_MISMATCH' });
  assert.throws(() => store.wrap(b64(d), 'ctx-x', 'not an owner', 't'), { code: 'BAD_REQUEST' });
});

test('rotating one customer leaves the others untouched; rewrap moves the DEK to its own active KEK', () => {
  const { store } = freshStore();
  store.initialize('test');
  const d = dek();
  const w1 = store.wrap(b64(d), 'ctx-1', 'CUS-0001', 't');
  const w2 = store.wrap(b64(dek()), 'ctx-2', 'CUS-0002', 't');
  const r = store.rotate('CUS-0001', 'test');
  assert.equal(r.kek_id, 'kek-cus-0001-v2');
  assert.equal(store.activeKekFor('CUS-0001').kek_id, 'kek-cus-0001-v2');
  assert.equal(store.activeKekFor('CUS-0002').kek_id, 'kek-cus-0002-v1');
  assert.equal(store.unwrap({ ...w1, context: 'ctx-1', owner: 'CUS-0001' }, 't').dek_b64, b64(d));
  const rw = store.rewrap([{ id: 1, ...w1, context: 'ctx-1', owner: 'CUS-0001' }, { id: 2, ...w2, context: 'ctx-2', owner: 'CUS-0002' }], 't');
  assert.equal(rw.results[0].kek_id, 'kek-cus-0001-v2');
  assert.equal(rw.results[1].kek_id, 'kek-cus-0002-v1');
  assert.equal(store.unwrap({ ...rw.results[0], context: 'ctx-1', owner: 'CUS-0001' }, 't').dek_b64, b64(d));
});

test('rotate all creates one new version per customer and a single backup', () => {
  const { store } = freshStore();
  store.initialize('test');
  for (let i = 1; i <= 5; i += 1) store.wrap(b64(dek()), `ctx-${i}`, `CUS-000${i}`, 't');
  const before = store.listBackups().length;
  const r = store.rotateAll('test');
  assert.equal(r.count, 5);
  assert.equal(store.summary().active_kek_count, 5);
  assert.equal(store.summary().kek_count, 10);
  assert.ok(Object.values(store.keystore.active).every((id) => id.endsWith('-v2')));
  assert.equal(store.listBackups().length, before + 1);
});

test('disabled access produces a controlled error', () => {
  const { store } = freshStore();
  store.initialize('test');
  const w = store.wrap(b64(dek()), 'ctx', 'CUS-0001', 't');
  store.setAccessDisabled(true, 't');
  assert.throws(() => store.unwrap({ ...w, context: 'ctx' }, 't'), { code: 'KEY_ACCESS_DISABLED' });
  store.setAccessDisabled(false, 't');
  assert.ok(store.unwrap({ ...w, context: 'ctx' }, 't').dek_b64);
});

test('keystore loss: keys are not regenerated; recovered from backup', () => {
  const { store, cfg } = freshStore();
  store.initialize('test');
  const d = dek();
  const w = store.wrap(b64(d), 'ctx', 'CUS-0001', 't');
  store.createBackup('test', 't');
  const fpBefore = store.publicKeks()[0].fingerprint;
  store.simulateStorageLoss('t');
  assert.equal(store.status(), 'KEYSTORE_MISSING');
  assert.throws(() => store.unwrap({ ...w, context: 'ctx' }, 't'), { code: 'KEK_NOT_FOUND' });
  assert.throws(() => store.initialize('t'), { code: 'KEYSTORE_MISSING' });
  const reloaded = new VaultStore(cfg);
  assert.equal(reloaded.status(), 'KEYSTORE_MISSING');
  reloaded.restoreFromBackup(reloaded.listBackups()[0].file, 't');
  assert.equal(reloaded.publicKeks()[0].fingerprint, fpBefore);
  assert.equal(reloaded.unwrap({ ...w, context: 'ctx', owner: 'CUS-0001' }, 't').dek_b64, b64(d));
});

test('shredding one customer only affects that customer and is undone from a backup', () => {
  const { store } = freshStore();
  store.initialize('test');
  const d1 = dek();
  const w1 = store.wrap(b64(d1), 'ctx-1', 'CUS-0001', 't');
  const w2 = store.wrap(b64(dek()), 'ctx-2', 'CUS-0002', 't');
  store.rotate('CUS-0001', 't'); // backup includes both customers
  const r = store.shred('CUS-0001', 't');
  assert.deepEqual(r.kek_ids, ['kek-cus-0001-v1', 'kek-cus-0001-v2']);
  assert.throws(() => store.unwrap({ ...w1, context: 'ctx-1', owner: 'CUS-0001' }, 't'), { code: 'KEK_NOT_FOUND' });
  assert.ok(store.unwrap({ ...w2, context: 'ctx-2', owner: 'CUS-0002' }, 't').dek_b64);
  assert.equal(store.summary().shredded.length, 1);
  // A new wrap for the shredded customer never reuses an old kek_id.
  const again = store.wrap(b64(dek()), 'ctx-3', 'CUS-0001', 't');
  assert.equal(again.kek_id, 'kek-cus-0001-v3');
  store.restoreFromBackup(store.listBackups().find((b) => b.reason.startsWith('auto-rotate')).file, 't');
  assert.equal(store.unwrap({ ...w1, context: 'ctx-1', owner: 'CUS-0001' }, 't').dek_b64, b64(d1));
  assert.equal(store.activeKekFor('CUS-0001').kek_id, 'kek-cus-0001-v3');
});

test('restore rejects a different KEK with the same kek_id', () => {
  const a = freshStore();
  a.store.initialize('t');
  a.store.wrap(b64(dek()), 'ctx', 'CUS-0001', 't');
  const fileA = a.store.createBackup('test', 't').file;
  const b = freshStore();
  b.store.initialize('t');
  b.store.wrap(b64(dek()), 'ctx', 'CUS-0001', 't');
  fs.copyFileSync(path.join(a.cfg.backupDir, fileA), path.join(b.cfg.backupDir, fileA));
  assert.throws(() => b.store.restoreFromBackup(fileA, 't'), { code: 'KEK_CONFLICT' });
});

test('the latest backup is the most recent one even within the same second', () => {
  const { store } = freshStore();
  store.initialize('t');
  store.wrap(b64(dek()), 'ctx-1', 'CUS-0001', 't');
  store.rotate('CUS-0001', 't');
  store.rotateAll('t');
  const list = store.listBackups();
  assert.equal(new Set(list.map((b) => b.file)).size, list.length);
  assert.equal(list[0].reason, 'auto-rotate-all');
});

test('a backup with the wrong passphrase cannot be decrypted', () => {
  const a = freshStore();
  a.store.initialize('t');
  const other = new VaultStore({ ...a.cfg, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vault-x-')), backupPassphrase: 'another' });
  assert.throws(() => other.restoreFromBackup(a.store.listBackups()[0].file, 't'), { code: 'BACKUP_DECRYPT_FAILED' });
});
