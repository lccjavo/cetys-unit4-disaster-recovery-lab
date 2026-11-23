'use strict';

const env = process.env;

const list = (value, fallback) =>
  (value || fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

module.exports = {
  port: Number(env.HOTEL_APP_INTERNAL_PORT || 3000),
  labMode: env.LAB_MODE !== 'false',
  sessionSecret: env.HOTEL_SESSION_SECRET || 'lab-default-hotel-session-secret',
  autoInit: env.AUTO_INIT !== 'false',

  db: {
    host: env.DB_HOST || 'postgres-primary',
    port: Number(env.DB_PORT || 5432),
    database: env.DB_NAME || 'hotel_lab',
    user: env.DB_USER || 'hotel_app',
    password: env.DB_PASSWORD || 'lab_app_default',
    candidates: list(env.DB_CANDIDATE_HOSTS, 'postgres-primary,postgres-standby,postgres-recovery'),
  },
  // Credenciales de administracion: solo las usa el ejecutor de migraciones.
  dbAdmin: {
    user: env.DB_ADMIN_USER || 'hotel_admin',
    password: env.DB_ADMIN_PASSWORD || 'lab_admin_default',
  },
  dbReader: {
    user: env.DB_READER_USER || 'lab_reader',
    password: env.DB_READER_PASSWORD || 'lab_reader_default',
  },

  vault: {
    url: (env.KEY_VAULT_URL || 'http://key-vault:8200').replace(/\/$/, ''),
    token: env.KEY_VAULT_SERVICE_TOKEN || 'lab-default-service-token',
    timeoutMs: Number(env.KEY_VAULT_TIMEOUT_MS || 3000),
  },

  paths: {
    control: env.LAB_CONTROL_DIR || '/lab-control',
    backups: env.PG_BACKUPS_DIR || '/backups',
    walArchive: env.WAL_ARCHIVE_DIR || '/wal-archive',
  },

  demo: {
    adminPassword: env.HOTEL_DEMO_ADMIN_PASSWORD || 'Admin2026!',
    staffPassword: env.HOTEL_DEMO_STAFF_PASSWORD || 'Staff2026!',
    customerPassword: env.HOTEL_DEMO_CUSTOMER_PASSWORD || 'Cliente2026!',
  },

  seed: {
    customerCount: 150,
    // Semilla fija: identidades y perfiles reproducibles. DEKs y nonces siempre son aleatorios.
    prngSeed: 'CETYS-UNIDAD-4-2026',
    referenceDate: '2026-11-23',
  },
};
