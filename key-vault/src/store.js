'use strict';

/**
 * Key store of the educational Key Vault.
 *
 * - keystore.json : KEK material (outside PostgreSQL, in the vault-keys volume).
 *                   Every customer has its OWN key ring: kek-cus-0001-v1, kek-cus-0001-v2, ...
 *                   The owner (customer code) is part of each KEK record and is checked on
 *                   every unwrap, so a DEK can only be opened with its own customer's KEK.
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
const KEYSTORE_FORMAT = 2;
const OWNER_RE = /^[A-Z][A-Z0-9]*-[0-9]{1,8}$/;
const BACKUP_DEBOUNCE_MS = 1500;

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
  // Millisecond resolution: two backups in the same second never share a name.
  return nowIso().replace(/[-:]/g, '').replace(/\.(\d+)Z$/, '$1Z');
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

function kekIdFor(owner, version) {
  return `kek-${owner.toLowerCase()}-v${version}`;
}

/** Upgrades a format-1 keystore (one shared KEK ring) to the per-owner format in memory. */
function normalizeKeystore(ks) {
  if (!ks) return ks;
  if (ks.format === KEYSTORE_FORMAT && ks.active) return ks;
  const keks = (ks.keks || []).map((k) => ({ owner: 'SHARED-1', ...k }));
  return { format: KEYSTORE_FORMAT, keks, active: ks.active_kek_id ? { 'SHARED-1': ks.active_kek_id } : {} };
}

function defaultState() {
  return {
    format: 1,
    initialized_at: null,
    access_disabled: false,
    simulated_outage: false,
    counters: { wrap: 0, unwrap: 0, rewrap: 0, denied: 0, errors: 0 },
    usage: {},
    // Highest KEK version ever issued per owner (survives shredding), so a kek_id is never reused.
    versions: {},
    shredded: [],
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
    this.backupTimer = null;
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(cfg.backupDir, { recursive: true, mode: 0o700 });
    this.load();
  }

  load() {
    if (fs.existsSync(this.stateFile)) {
      this.state = { ...defaultState(), ...JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) };
    }
    this.keystore = fs.existsSync(this.keystoreFile)
      ? normalizeKeystore(JSON.parse(fs.readFileSync(this.keystoreFile, 'utf8')))
      : null;
  }

  // ----------------------------------------------------------------- status

  status() {
    if (this.keystore) return 'READY';
    if (this.state.initialized_at) return 'KEYSTORE_MISSING';
    return 'UNINITIALIZED';
  }

  static validateOwner(owner) {
    if (typeof owner !== 'string' || !OWNER_RE.test(owner)) {
      throw new VaultError('BAD_REQUEST', 'invalid KEK owner (expected a customer code such as CUS-0001)', 400);
    }
    return owner;
  }

  activeKekFor(owner) {
    if (!this.keystore) return null;
    const id = this.keystore.active[owner];
    return id ? this.getKek(id) : null;
  }

  getKek(kekId) {
    if (!this.keystore) return null;
    return this.keystore.keks.find((k) => k.kek_id === kekId) || null;
  }

  isActive(k) {
    return Boolean(this.keystore && this.keystore.active[k.owner] === k.kek_id);
  }

  publicKeks() {
    if (!this.keystore) return [];
    return this.keystore.keks.map((k) => ({
      kek_id: k.kek_id,
      owner: k.owner,
      version: k.version,
      algorithm: k.algorithm,
      status: this.isActive(k) ? 'active' : 'retired',
      created_at: k.created_at,
      retired_at: k.retired_at || null,
      fingerprint: k.fingerprint,
      usage: this.state.usage[k.kek_id] || { wrap: 0, unwrap: 0 },
    }));
  }

  summary() {
    const keks = this.publicKeks();
    const owners = this.keystore ? Object.keys(this.keystore.active).length : 0;
    return {
      vault_status: this.status(),
      kek_count: keks.length,
      owner_count: owners,
      active_kek_count: keks.filter((k) => k.status === 'active').length,
      retired_kek_count: keks.filter((k) => k.status === 'retired').length,
      access_disabled: this.state.access_disabled,
      simulated_outage: this.state.simulated_outage,
      counters: this.state.counters,
      last_backup: this.state.last_backup,
      initialized_at: this.state.initialized_at,
      shredded: this.state.shredded.slice(-20).reverse(),
      rotation_history: this.state.rotation_history.slice(-20).reverse(),
      keks,
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

  nextVersion(owner) {
    const issued = this.state.versions[owner] || 0;
    const present = this.keystore.keks.filter((k) => k.owner === owner).map((k) => k.version);
    return Math.max(issued, ...present, 0) + 1;
  }

  newKek(owner) {
    const version = this.nextVersion(owner);
    const material = crypto.randomBytes(32);
    this.state.versions[owner] = version;
    return {
      kek_id: kekIdFor(owner, version),
      owner,
      version,
      algorithm: WRAP_ALGORITHM_LABEL,
      key_material_b64: material.toString('base64'),
      fingerprint: fingerprint(material),
      created_at: nowIso(),
    };
  }

  /** Creates the (empty) key store. Each customer's KEK is created on its first wrap. */
  initialize(actor) {
    const st = this.status();
    if (st === 'READY') {
      throw new VaultError('ALREADY_INITIALIZED', 'The Key Vault is already initialized; existing KEKs are preserved.', 409);
    }
    if (st === 'KEYSTORE_MISSING') {
      throw new VaultError(
        'KEYSTORE_MISSING',
        'The Key Vault was initialized before but its KEK storage is missing. ' +
          'No incompatible replacement keys are generated: restore from a KEK backup.',
        409,
      );
    }
    this.keystore = { format: KEYSTORE_FORMAT, keks: [], active: {} };
    this.saveKeystore();
    this.state.initialized_at = nowIso();
    this.state.rotation_history.push({ at: nowIso(), action: 'initialize', actor });
    this.saveStateNow();
    this.event('initialize', actor, 'success', { model: 'one KEK per customer' });
    const backup = this.createBackup('auto-initialize', 'system');
    return { initialized_at: this.state.initialized_at, backup: backup.file };
  }

  /** Returns the owner's active KEK, creating the owner's first KEK if it has none. */
  kekForWrap(owner, actor) {
    const existing = this.activeKekFor(owner);
    if (existing) return { kek: existing, created: false };
    const kek = this.newKek(owner);
    this.keystore.keks.push(kek);
    this.keystore.active[owner] = kek.kek_id;
    this.saveKeystore();
    this.event('kek-create', actor, 'success', { owner, kek_id: kek.kek_id });
    this.scheduleBackup('auto-new-kek');
    return { kek, created: true };
  }

  rotateOne(owner) {
    const current = this.activeKekFor(owner);
    if (!current) throw new VaultError('KEK_NOT_FOUND', `Customer ${owner} has no active KEK to rotate.`, 404);
    const kek = this.newKek(owner);
    current.retired_at = nowIso();
    this.keystore.keks.push(kek);
    this.keystore.active[owner] = kek.kek_id;
    return { owner, kek_id: kek.kek_id, previous: current.kek_id };
  }

  /** Rotates one customer's KEK. */
  rotate(owner, actor) {
    this.requireReady();
    VaultStore.validateOwner(owner);
    const r = this.rotateOne(owner);
    this.saveKeystore();
    this.state.rotation_history.push({ at: nowIso(), action: 'rotate', owner, from: r.previous, kek_id: r.kek_id, actor });
    this.saveStateNow();
    this.event('rotate', actor, 'success', { owner, from: r.previous, to: r.kek_id });
    // Good practice: back up immediately after rotating.
    const backup = this.createBackup(`auto-rotate-${r.kek_id}`, 'system');
    return { ...r, backup: backup.file };
  }

  /** Rotates every customer's KEK (one new version per customer) with a single backup. */
  rotateAll(actor) {
    this.requireReady();
    const owners = Object.keys(this.keystore.active).sort();
    if (!owners.length) throw new VaultError('KEK_NOT_FOUND', 'There are no customer KEKs to rotate.', 404);
    const rotated = owners.map((o) => this.rotateOne(o));
    this.saveKeystore();
    this.state.rotation_history.push({ at: nowIso(), action: 'rotate-all', count: rotated.length, actor });
    this.saveStateNow();
    this.event('rotate-all', actor, 'success', { count: rotated.length });
    const backup = this.createBackup('auto-rotate-all', 'system');
    return { count: rotated.length, sample: rotated.slice(0, 3), backup: backup.file };
  }

  /**
   * Crypto-shredding (lab): removes EVERY KEK version of one customer from the key store.
   * That customer's wrapped DEK can no longer be opened; every other customer is unaffected.
   * For the lab the material is moved to quarantine and stays in earlier backups (restorable).
   */
  shred(owner, actor) {
    this.requireReady();
    VaultStore.validateOwner(owner);
    this.flushPendingBackup();
    const keks = this.keystore.keks.filter((k) => k.owner === owner);
    if (!keks.length) throw new VaultError('KEK_NOT_FOUND', `Customer ${owner} has no KEKs in this Key Vault.`, 404);
    fs.mkdirSync(this.quarantineDir, { recursive: true, mode: 0o700 });
    const file = `shredded-${owner.toLowerCase()}-${stamp()}.json`;
    writeJsonAtomic(path.join(this.quarantineDir, file), { owner, at: nowIso(), keks });
    this.keystore.keks = this.keystore.keks.filter((k) => k.owner !== owner);
    delete this.keystore.active[owner];
    this.saveKeystore();
    const kekIds = keks.map((k) => k.kek_id);
    this.state.shredded.push({ at: nowIso(), owner, kek_ids: kekIds, quarantined_as: file, actor });
    this.saveStateNow();
    this.event('shred', actor, 'success', { owner, kek_ids: kekIds });
    return { owner, kek_ids: kekIds, quarantined_as: file };
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

  wrap(dekB64, context, owner, actor) {
    this.requireAccess(actor);
    VaultStore.validateContext(context);
    VaultStore.validateOwner(owner);
    const dek = Buffer.from(String(dekB64 || ''), 'base64');
    if (dek.length !== 32) throw new VaultError('BAD_REQUEST', 'The DEK must be 256 bits', 400);
    const { kek, created } = this.kekForWrap(owner, actor);
    const result = this.wrapWith(kek, dek, context);
    dek.fill(0);
    this.state.counters.wrap += 1;
    this.bumpUsage(kek.kek_id, 'wrap');
    this.saveStateSoon();
    return { ...result, owner, kek_created: created };
  }

  /** Finds the KEK and checks that it belongs to the expected owner (customer). */
  kekForUnwrap(kekId, owner) {
    const kek = this.getKek(kekId);
    if (!kek) {
      this.state.counters.errors += 1;
      this.saveStateSoon();
      throw new VaultError('KEK_NOT_FOUND', `KEK '${kekId}' does not exist in this Key Vault.`, 404);
    }
    if (owner !== undefined && owner !== null && kek.owner !== owner) {
      this.state.counters.denied += 1;
      this.saveStateSoon();
      throw new VaultError(
        'KEK_OWNER_MISMATCH',
        `KEK '${kekId}' belongs to ${kek.owner}, not to ${owner}. A DEK can only be unwrapped with its own customer's KEK.`,
        403,
      );
    }
    return kek;
  }

  unwrap(item, actor) {
    this.requireAccess(actor);
    VaultStore.validateContext(item.context);
    if (item.owner !== undefined && item.owner !== null) VaultStore.validateOwner(item.owner);
    const kek = this.kekForUnwrap(item.kek_id, item.owner);
    const dek = this.unwrapWith(kek, item);
    this.state.counters.unwrap += 1;
    this.bumpUsage(kek.kek_id, 'unwrap');
    this.saveStateSoon();
    const out = dek.toString('base64');
    dek.fill(0);
    return { dek_b64: out, kek_id: kek.kek_id, owner: kek.owner };
  }

  /** Re-wraps each DEK with the ACTIVE KEK of its own customer. */
  rewrap(items, actor) {
    this.requireAccess(actor);
    const results = [];
    for (const item of items) {
      try {
        VaultStore.validateContext(item.context);
        const kek = this.kekForUnwrap(item.kek_id, item.owner);
        const target = this.activeKekFor(kek.owner);
        if (!target) throw new VaultError('KEK_NOT_FOUND', `Customer ${kek.owner} has no active KEK.`, 404);
        const dek = this.unwrapWith(kek, item);
        const wrapped = this.wrapWith(target, dek, item.context);
        dek.fill(0);
        this.state.counters.rewrap += 1;
        this.bumpUsage(target.kek_id, 'wrap');
        results.push({ id: item.id, ok: true, owner: kek.owner, ...wrapped });
      } catch (err) {
        results.push({ id: item.id, ok: false, error: err.code || 'ERROR', message: err.message });
      }
    }
    this.saveStateSoon();
    this.event('rewrap', actor, 'success', { total: items.length, ok: results.filter((r) => r.ok).length });
    return { results };
  }

  // ---------------------------------------------------------------- backups

  backupKey(salt) {
    return crypto.scryptSync(this.cfg.backupPassphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  }

  /** Debounced automatic backup: many new KEKs in a burst (the seed) produce a single backup. */
  scheduleBackup(reason) {
    if (this.backupTimer) clearTimeout(this.backupTimer);
    this.backupTimer = setTimeout(() => {
      this.backupTimer = null;
      try {
        if (this.status() === 'READY') this.createBackup(reason, 'system');
      } catch (err) {
        console.error('[vault] automatic backup failed:', err.message);
      }
    }, BACKUP_DEBOUNCE_MS);
    if (this.backupTimer.unref) this.backupTimer.unref();
  }

  /** Runs a pending automatic backup now (before a destructive lab action). */
  flushPendingBackup() {
    if (this.backupTimer) this.createBackup('auto-new-kek', 'system');
  }

  createBackup(reason, actor) {
    this.requireReady();
    if (this.backupTimer) {
      clearTimeout(this.backupTimer);
      this.backupTimer = null;
    }
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
      kek_count: this.keystore.keks.length,
      owner_count: Object.keys(this.keystore.active).length,
      keystore_sha256: sha256,
      encryption: { algorithm: 'AES-256-GCM', kdf: 'scrypt', N: 2 ** 15, r: 8, p: 1, salt: salt.toString('base64') },
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    writeJsonAtomic(path.join(this.cfg.backupDir, file), doc);
    this.state.last_backup = { file, at: doc.created_at, kek_count: doc.kek_count, owner_count: doc.owner_count, sha256, actor };
    this.saveStateNow();
    this.event('backup', actor, 'success', { file, kek_count: doc.kek_count });
    return { file, created_at: doc.created_at, kek_count: doc.kek_count, owner_count: doc.owner_count, sha256 };
  }

  listBackups() {
    let files = [];
    try {
      files = fs.readdirSync(this.cfg.backupDir).filter((f) => /^kek-backup-.*\.json$/.test(f));
    } catch {
      return [];
    }
    return files
      .map((file) => {
        try {
          const doc = JSON.parse(fs.readFileSync(path.join(this.cfg.backupDir, file), 'utf8'));
          const size = fs.statSync(path.join(this.cfg.backupDir, file)).size;
          const kekCount = doc.kek_count ?? (doc.kek_ids || []).length;
          return { file, created_at: doc.created_at, reason: doc.reason, kek_count: kekCount, owner_count: doc.owner_count ?? null, sha256: doc.keystore_sha256, size };
        } catch {
          return { file, error: 'Unreadable file' };
        }
      })
      // Newest first by creation time (not by file name), so "latest" is always the most recent backup.
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || b.file.localeCompare(a.file));
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
    return normalizeKeystore(JSON.parse(payload.toString('utf8')));
  }

  restoreFromBackup(file, actor) {
    const restored = this.readBackup(file);
    const added = [];
    let unchanged = 0;
    if (!this.keystore) this.keystore = { format: KEYSTORE_FORMAT, keks: [], active: {} };
    // Check every KEK before changing anything (all or nothing).
    for (const k of restored.keks) {
      const existing = this.getKek(k.kek_id);
      if (existing && existing.key_material_b64 !== k.key_material_b64) {
        throw new VaultError(
          'KEK_CONFLICT',
          `KEK ${k.kek_id} in the backup differs from the current KEK with the same identifier. It is not replaced.`,
          409,
        );
      }
    }
    for (const k of restored.keks) {
      if (this.getKek(k.kek_id)) {
        unchanged += 1;
      } else {
        this.keystore.keks.push(k);
        added.push(k.kek_id);
      }
      this.state.versions[k.owner] = Math.max(this.state.versions[k.owner] || 0, k.version);
    }
    for (const [owner, kekId] of Object.entries(restored.active || {})) {
      if (!this.keystore.active[owner] && this.getKek(kekId)) this.keystore.active[owner] = kekId;
    }
    this.keystore.keks.sort((a, b) => a.owner.localeCompare(b.owner) || a.version - b.version);
    this.saveKeystore();
    const restoredOwners = new Set(restored.keks.map((k) => k.owner));
    this.state.shredded = this.state.shredded.filter((x) => !restoredOwners.has(x.owner) || !this.keystore.active[x.owner]);
    if (!this.state.initialized_at) this.state.initialized_at = nowIso();
    this.state.rotation_history.push({ at: nowIso(), action: 'restore', from_backup: file, added_count: added.length, actor });
    this.saveStateNow();
    this.event('restore', actor, 'success', { file, added: added.length, unchanged });
    return { file, added, added_count: added.length, unchanged_count: unchanged, kek_count: this.keystore.keks.length };
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
    this.flushPendingBackup();
    fs.mkdirSync(this.quarantineDir, { recursive: true, mode: 0o700 });
    const dest = path.join(this.quarantineDir, `keystore-${stamp()}.json`);
    // Not destroyed: moved to quarantine inside the same volume as a safety net.
    fs.renameSync(this.keystoreFile, dest);
    this.keystore = null;
    this.event('simulate-storage-loss', actor, 'success', { quarantined_as: path.basename(dest) });
    return { quarantined_as: path.basename(dest) };
  }
}

module.exports = { VaultStore, VaultError, kekIdFor };
