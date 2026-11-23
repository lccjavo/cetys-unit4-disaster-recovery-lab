'use strict';

const env = process.env;

const DEFAULTS = {
  serviceToken: 'lab-default-service-token',
  sessionSecret: 'lab-default-vault-session-secret',
  adminPassword: 'VaultAdmin2026!',
  backupPassphrase: 'lab-default-backup-passphrase',
};

const config = {
  guiPort: Number(env.VAULT_GUI_PORT || 3001),
  apiPort: Number(env.VAULT_API_PORT || 8200),
  dataDir: env.VAULT_DATA_DIR || '/vault/keys',
  backupDir: env.VAULT_BACKUP_DIR || '/vault/backups',
  serviceToken: env.KEY_VAULT_SERVICE_TOKEN || DEFAULTS.serviceToken,
  sessionSecret: env.VAULT_SESSION_SECRET || DEFAULTS.sessionSecret,
  adminUser: env.VAULT_ADMIN_USER || 'vault_admin',
  adminPassword: env.VAULT_ADMIN_PASSWORD || DEFAULTS.adminPassword,
  backupPassphrase: env.VAULT_BACKUP_PASSPHRASE || DEFAULTS.backupPassphrase,
  labMode: env.LAB_MODE !== 'false',
};

config.usingDefaultSecrets = [
  config.serviceToken === DEFAULTS.serviceToken && 'KEY_VAULT_SERVICE_TOKEN',
  config.sessionSecret === DEFAULTS.sessionSecret && 'VAULT_SESSION_SECRET',
  config.backupPassphrase === DEFAULTS.backupPassphrase && 'VAULT_BACKUP_PASSPHRASE',
].filter(Boolean);

module.exports = config;
