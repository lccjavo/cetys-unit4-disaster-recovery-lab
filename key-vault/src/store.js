'use strict';

/**
 * Key store of the educational Key Vault.
 *
 * - keystore.json : KEK material (outside PostgreSQL, in the vault-keys volume).
 * - state.json    : counters, rotation history, disaster simulation flags.
 * - /vault/backups: independent keystore backups, encrypted with a passphrase.
 *
 * This is a SIMULATED KMS for class. It is not an HSM or a cloud KMS.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ALGORITHM = 'aes-256-gcm';
const WRAP_ALGORITHM_LABEL = 'AES-256-GCM';
const MAX_EVENTS = 300;

class VaultError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function stamp() {
  return nowIso().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function fingerprint(material) {
  // Public KEK fingerprint (truncated SHA-256); it cannot be used to rebuild the key.
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function defaultState() {
  return {
    format: 1,
    initialized_at: null,
    access_disabled: false,
    simulated_outage: false,
    counters: { wrap: 0, unwrap: 0, rewrap: 0, denied: 0, errors: 0 },
    usage: {},
    rotation_history: [],
    last_backup: null,
    events: [],
  };
}

class VaultStore {
  constructor(cfg) {
    this.cfg = cfg;
    this.keystoreFile = path.join(cfg.dataDir, 'keystore.json');
    this.stateFile = path.join(cfg.dataDir, 'state.json');
    this.auditFile = path.join(cfg.dataDir, 'audit.log');
    this.quarantineDir = path.join(cfg.dataDir, 'quarantine');
    this.keystore = null;
    this.state = defaultState();
    this.saveTimer = null;
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(cfg.backupDir, { recursive: true, mode: 0o700 });
    this.load();
  }

  load() {
    if (fs.existsSync(this.stateFile)) {
      this.state = { ...defaultState(), ...JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) };
    }
    this.keystore = fs.existsSync(this.keystoreFile)
      ? JSON.parse(fs.readFileSync(this.keystoreFile, 'utf8'))
      : null;
  }

  // ----------------------------------------------------------------- status

  status() {
    if (this.keystore && this.keystore.keks && this.keystore.keks.length > 0) return 'READY';
    if (this.state.initialized_at) return 'KEYSTORE_MISSING';
    return 'UNINITIALIZED';
  }

  activeKek() {
    if (!this.keystore) return null;
    return this.keystore.keks.find((k) => k.kek_id === this.keystore.active_kek_id) || null;
  }

  getKek(kekId) {
    if (!this.keystore) return null;
    return this.keystore.keks.find((k) => k.kek_id === kekId) || null;
  }

  publicKeks() {
    if (!this.keystore) return [];
    return this.keystore.keks.map((k) => ({
      kek_id: k.kek_id,
      version: k.version,
      algorithm: k.algorithm,
      status: k.kek_id === this.keystore.active_kek_id ? 'active' : 'retired',
      created_at: k.created_at,
      retired_at: k.retired_at || null,
      fingerprint: k.fingerprint,
      usage: this.state.usage[k.kek_id] || { wrap: 0, unwrap: 0 },
    }));
  }

  summary() {
    const active = this.activeKek();
    return {
      vault_status: this.status(),
      active_kek_id: active ? active.kek_id : null,
      kek_count: this.keystore ? this.keystore.keks.length : 0,
      access_disabled: this.state.access_disabled,
      simulated_outage: this.state.simulated_outage,
      counters: this.state.counters,
      last_backup: this.state.last_backup,
      initialized_at: this.state.initialized_at,
      rotation_history: this.state.rotation_history.slice(-20).reverse(),
      keks: this.publicKeks(),
    };
  }

  // ------------------------------------------------------------ persistence

  saveKeystore() {
    writeJsonAtomic(this.keystoreFile, this.keystore);
  }

  saveStateNow() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    writeJsonAtomic(this.stateFile, this.state);
  }

  saveStateSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        writeJsonAtomic(this.stateFile, this.state);
      } catch (err) {
        console.error('[vault] could not save state.json:', err.message);
      }
    }, 500);
  }

  event(action, actor, outcome, details = {}) {
    const entry = { at: nowIso(), action, actor: actor || 'system', outcome, details };
    this.state.events.push(entry);
    if (this.state.events.length > MAX_EVENTS) this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
    try {
      fs.appendFileSync(this.auditFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (err) {
      console.error('[vault] could not write audit.log:', err.message);
    }
    this.saveStateSoon();
  }

  // --------------------------------------------------------- KEK lifecycle

  newKek(version) {
    const material = crypto.randomBytes(32);
    return {
      kek_id: `kek-v${version}`,
      version,
      algorithm: WRAP_ALGORITHM_LABEL,
      key_material_b64: material.toString('base64'),
      fingerprint: fingerprint(material),
      created_at: nowIso(),
    };
  }

  initialize(actor) {
    const st = this.status();
    if (st === 'READY') {
      throw new VaultError('ALREADY_INITIALIZED', 'The Key Vault already has KEKs; no new keys are generated.', 409);
    }
    if (st === 'KEYSTORE_MISSING') {
      throw new VaultError(
        'KEYSTORE_MISSING',
        'The Key Vault was initialized before but its KEK storage is missing. ' +
          'No incompatible replacement keys are generated: restore from a KEK backup.',
        409,
      );
    }
    const kek = this.newKek(1);
    this.keystore = { format: 1, active_kek_id: kek.kek_id, keks: [kek] };
    this.saveKeystore();
    this.state.initialized_at = nowIso();
    this.state.rotation_history.push({ at: nowIso(), action: 'initialize', kek_id: kek.kek_id, actor });
    this.saveStateNow();
    this.event('initialize', actor, 'success', { kek_id: kek.kek_id });
    const backup = this.createBackup('auto-initialize', 'system');
    return { kek_id: kek.kek_id, backup: backup.file };
  }

  rotate(actor) {
    this.requireReady();
    const current = this.activeKek();
    const nextVersion = Math.max(...this.keystore.keks.map((k) => k.version)) + 1;
    const kek = this.newKek(nextVersion);
    if (current) current.retired_at = nowIso();
    this.keystore.keks.push(kek);
    this.keystore.active_kek_id = kek.kek_id;
    this.saveKeystore();
    this.state.rotation_history.push({
      at: nowIso(),
      action: 'rotate',
      from: current ? current.kek_id : null,
      kek_id: kek.kek_id,
      actor,
    });
    this.saveStateNow();
    this.event('rotate', actor, 'success', { from: current && current.kek_id, to: kek.kek_id });
    // Good practice: back up immediately after rotating.
    const backup = this.createBackup(`auto-rotate-${kek.kek_id}`, 'system');
    return { kek_id: kek.kek_id, previous: current && current.kek_id, backup: backup.file };
  }

  requireReady() {
    const st = this.status();
    if (st === 'KEYSTORE_MISSING') {
      throw new VaultError('KEK_NOT_FOUND', 'KEK storage unavailable (keystore missing).', 404);
    }
    if (st === 'UNINITIALIZED') {
      throw new VaultError('NOT_INITIALIZED', 'The Key Vault has not been initialized.', 409);
    }
  }

  requireAccess(actor) {
    if (this.state.access_disabled) {
      this.state.counters.denied += 1;
      this.saveStateSoon();
      throw new VaultError('KEY_ACCESS_DISABLED', 'Key access is temporarily disabled.', 403);
    }
    this.requireReady();
    return actor;
  }

  // ------------------------------------------------------- wrap / unwrap

  static aad(kekId, context) {
    return Buffer.from(`cetys-vault|dek-wrap|v1|${kekId}|${context}`, 'utf8');
  }

  static validateContext(context) {
    if (typeof context !== 'string' || context.length < 3 || context.length > 256) {
      throw new VaultError('BAD_REQUEST', 'invalid context', 400);
    }
  }

  wrapWith(kek, dek, context) {
    const key = Buffer.from(kek.key_material_b64, 'base64');
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, key, nonce, { authTagLength: 16 });
    cipher.setAAD(VaultStore.aad(kek.kek_id, context));
    const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
    const tag = cipher.getAuthTag();
    key.fill(0);
    return {
      kek_id: kek.kek_id,
      algorithm: WRAP_ALGORITHM_LABEL,
      wrapped_dek: wrapped.toString('base64'),
      nonce: nonce.toString('base64'),
      tag: tag.toString('base64'),
    };
  }

  unwrapWith(kek, item) {
    const key = Buffer.from(kek.key_material_b64, 'base64');
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(item.nonce, 'base64'), {
        authTagLength: 16,
      });
      decipher.setAAD(VaultStore.aad(kek.kek_id, item.context));
      decipher.setAuthTag(Buffer.from(item.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(item.wrapped_dek, 'base64')), decipher.final()]);
    } catch {
      throw new VaultError(
        'UNWRAP_FAILED',
        'GCM authentication of the wrapped DEK failed (wrong KEK, different context or tampered data).',
        422,
      );
    } finally {
      key.fill(0);
    }
  }

  bumpUsage(kekId, field) {
    if (!this.state.usage[kekId]) this.state.usage[kekId] = { wrap: 0, unwrap: 0 };
    this.state.usage[kekId][field] += 1;
  }

  wrap(dekB64, context, actor) {
    this.requireAccess(actor);
    VaultStore.validateContext(context);
    const dek = Buffer.from(String(dekB64 || ''), 'base64');
    if (dek.length !== 32) throw new VaultError('BAD_REQUEST', 'The DEK must be 256 bits', 400);
    const kek = this.activeKek();
    const result = this.wrapWith(kek, dek, context);
    dek.fill(0);
    this.state.counters.wrap += 1;
    this.bumpUsage(kek.kek_id, 'wrap');
    this.saveStateSoon();
    return result;
  }

  unwrap(item, actor) {
    this.requireAccess(actor);
    VaultStore.validateContext(item.context);
    const kek = this.getKek(item.kek_id);
    if (!kek) {
      this.state.counters.errors += 1;
      this.saveStateSoon();
      throw new VaultError('KEK_NOT_FOUND', `KEK '${item.kek_id}' does not exist in this Key Vault.`, 404);
    }
    const dek = this.unwrapWith(kek, item);
    this.state.counters.unwrap += 1;
    this.bumpUsage(kek.kek_id, 'unwrap');
    this.saveStateSoon();
    const out = dek.toString('base64');
    dek.fill(0);
    return { dek_b64: out, kek_id: kek.kek_id };
  }

  rewrap(items, actor) {
    this.requireAccess(actor);
    const active = this.activeKek();
    const results = [];
    for (const item of items) {
      try {
        VaultStore.validateContext(item.context);
        const kek = this.getKek(item.kek_id);
        if (!kek) throw new VaultError('KEK_NOT_FOUND', `KEK '${item.kek_id}' does not exist.`, 404);
        const dek = this.unwrapWith(kek, item);
        const wrapped = this.wrapWith(active, dek, item.context);
        dek.fill(0);
        this.state.counters.rewrap += 1;
        this.bumpUsage(active.kek_id, 'wrap');
        results.push({ id: item.id, ok: true, ...wrapped });
      } catch (err) {
        results.push({ id: item.id, ok: false, error: err.code || 'ERROR', message: err.message });
      }
    }
    this.saveStateSoon();
    this.event('rewrap', actor, 'success', {
      to: active.kek_id,
      total: items.length,
      ok: results.filter((r) => r.ok).length,
    });
    return { active_kek_id: active.kek_id, results };
  }

  // ---------------------------------------------------------------- backups

  backupKey(salt) {
    return crypto.scryptSync(this.cfg.backupPassphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  }

  createBackup(reason, actor) {
    this.requireReady();
    const safeReason = String(reason || 'manual').replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40);
    const payload = Buffer.from(JSON.stringify(this.keystore), 'utf8');
    const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
    const salt = crypto.randomBytes(16);
    const nonce = crypto.randomBytes(12);
    const key = this.backupKey(salt);
    const cipher = crypto.createCipheriv(ALGORITHM, key, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.from('cetys-vault|kek-backup|v1'));
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    key.fill(0);
    const file = `kek-backup-${stamp()}-${safeReason}.json`;
    const doc = {
      format: 1,
      created_at: nowIso(),
      reason: safeReason,
      kek_ids: this.keystore.keks.map((k) => k.kek_id),
      active_kek_id: this.keystore.active_kek_id,
      keystore_sha256: sha256,
      encryption: { algorithm: 'AES-256-GCM', kdf: 'scrypt', N: 2 ** 15, r: 8, p: 1, salt: salt.toString('base64') },
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    writeJsonAtomic(path.join(this.cfg.backupDir, file), doc);
    this.state.last_backup = { file, at: doc.created_at, kek_ids: doc.kek_ids, sha256, actor };
    this.saveStateNow();
    this.event('backup', actor, 'success', { file, kek_ids: doc.kek_ids });
    return { file, created_at: doc.created_at, kek_ids: doc.kek_ids, sha256 };
  }

  listBackups() {
    let files = [];
    try {
      files = fs.readdirSync(this.cfg.backupDir).filter((f) => /^kek-backup-.*\.json$/.test(f));
    } catch {
      return [];
    }
    return files
      .sort()
      .reverse()
      .map((file) => {
        try {
          const doc = JSON.parse(fs.readFileSync(path.join(this.cfg.backupDir, file), 'utf8'));
          const size = fs.statSync(path.join(this.cfg.backupDir, file)).size;
          return { file, created_at: doc.created_at, reason: doc.reason, kek_ids: doc.kek_ids, active_kek_id: doc.active_kek_id, sha256: doc.keystore_sha256, size };
        } catch {
          return { file, error: 'Unreadable file' };
        }
      });
  }

  readBackup(file) {
    if (!/^kek-backup-[A-Za-z0-9TZ-]+\.json$/.test(file)) {
      throw new VaultError('BAD_REQUEST', 'Invalid backup name', 400);
    }
    const full = path.join(this.cfg.backupDir, file);
    if (!fs.existsSync(full)) throw new VaultError('NOT_FOUND', 'The backup does not exist', 404);
    const doc = JSON.parse(fs.readFileSync(full, 'utf8'));
    let payload;
    try {
      const key = this.backupKey(Buffer.from(doc.encryption.salt, 'base64'));
      const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(doc.nonce, 'base64'), { authTagLength: 16 });
      decipher.setAAD(Buffer.from('cetys-vault|kek-backup|v1'));
      decipher.setAuthTag(Buffer.from(doc.tag, 'base64'));
      payload = Buffer.concat([decipher.update(Buffer.from(doc.ciphertext, 'base64')), decipher.final()]);
      key.fill(0);
    } catch {
      throw new VaultError(
        'BACKUP_DECRYPT_FAILED',
        'The backup could not be decrypted (different VAULT_BACKUP_PASSPHRASE or tampered file).',
        422,
      );
    }
    const sha = crypto.createHash('sha256').update(payload).digest('hex');
    if (sha !== doc.keystore_sha256) throw new VaultError('BACKUP_CORRUPT', 'The backup SHA-256 checksum does not match', 422);
    return JSON.parse(payload.toString('utf8'));
  }

  restoreFromBackup(file, actor) {
    const restored = this.readBackup(file);
    const added = [];
    const unchanged = [];
    if (!this.keystore) {
      this.keystore = restored;
      added.push(...restored.keks.map((k) => k.kek_id));
    } else {
      for (const k of restored.keks) {
        const existing = this.getKek(k.kek_id);
        if (existing) {
          if (existing.key_material_b64 !== k.key_material_b64) {
            throw new VaultError(
              'KEK_CONFLICT',
              `KEK ${k.kek_id} in the backup differs from the current KEK with the same identifier. It is not replaced.`,
              409,
            );
          }
          unchanged.push(k.kek_id);
        } else {
          this.keystore.keks.push(k);
          added.push(k.kek_id);
        }
      }
      this.keystore.keks.sort((a, b) => a.version - b.version);
      if (!this.activeKek()) this.keystore.active_kek_id = restored.active_kek_id;
    }
    this.saveKeystore();
    if (!this.state.initialized_at) this.state.initialized_at = nowIso();
    this.state.rotation_history.push({ at: nowIso(), action: 'restore', from_backup: file, added, actor });
    this.saveStateNow();
    this.event('restore', actor, 'success', { file, added, unchanged });
    return { file, added, unchanged, active_kek_id: this.keystore.active_kek_id };
  }

  // ---------------------------------------------------- disaster simulation

  setAccessDisabled(disabled, actor) {
    this.state.access_disabled = Boolean(disabled);
    this.saveStateNow();
    this.event(disabled ? 'disable-access' : 'enable-access', actor, 'success');
  }

  setSimulatedOutage(enabled, actor) {
    this.state.simulated_outage = Boolean(enabled);
    this.saveStateNow();
    this.event(enabled ? 'simulate-outage' : 'end-outage', actor, 'success');
  }

  simulateStorageLoss(actor) {
    this.requireReady();
    fs.mkdirSync(this.quarantineDir, { recursive: true, mode: 0o700 });
    const dest = path.join(this.quarantineDir, `keystore-${stamp()}.json`);
    // Not destroyed: moved to quarantine inside the same volume as a safety net.
    fs.renameSync(this.keystoreFile, dest);
    this.keystore = null;
    this.event('simulate-storage-loss', actor, 'success', { quarantined_as: path.basename(dest) });
    return { quarantined_as: path.basename(dest) };
  }
}

module.exports = { VaultStore, VaultError };
