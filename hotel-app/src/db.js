'use strict';

/**
 * Capa de acceso a PostgreSQL con servidor objetivo intercambiable.
 *
 * El servidor objetivo (postgres-primary, postgres-standby o postgres-recovery) se guarda
 * en /lab-control/db-target, un volumen compartido. Los scripts de failover y PITR lo
 * actualizan, y la aplicacion lo vigila cada 2 segundos para reconectarse sin reiniciar.
 *
 * La aplicacion nunca cae si PostgreSQL no responde: las consultas lanzan DbUnavailableError
 * y las paginas muestran el estado "no disponible".
 */

const fs = require('node:fs');
const path = require('node:path');
const { Pool, Client } = require('pg');
const cfg = require('./config');

const TARGET_FILE = path.join(cfg.paths.control, 'db-target');
const TARGET_LOG = path.join(cfg.paths.control, 'db-target.log');
const INCIDENTS_FILE = path.join(cfg.paths.control, 'hotel-db-incidents.json');

const CONNECTION_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'EPIPE',
  '57P01', '57P02', '57P03', '08000', '08001', '08003', '08004', '08006',
]);

class DbUnavailableError extends Error {
  constructor(host, cause) {
    super(`Base de datos no disponible (${host}): ${cause ? cause.message : 'sin conexion'}`);
    this.code = 'DB_UNAVAILABLE';
    this.host = host;
  }
}

function isConnectionError(err) {
  if (!err) return false;
  if (CONNECTION_CODES.has(err.code)) return true;
  const msg = String(err.message || '');
  return /Connection terminated|timeout exceeded when trying to connect|connect ECONNREFUSED|getaddrinfo|Client has encountered a connection error|the database system is (starting up|shutting down|in recovery mode)/i.test(msg);
}

function readTargetFile() {
  try {
    const value = fs.readFileSync(TARGET_FILE, 'utf8').trim();
    return /^[a-z0-9-]+$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function poolOptions(host, creds = cfg.db) {
  return {
    host,
    port: cfg.db.port,
    database: cfg.db.database,
    user: creds.user,
    password: creds.password,
    max: 10,
    connectionTimeoutMillis: 2500,
    idleTimeoutMillis: 10000,
    statement_timeout: 15000,
    query_timeout: 20000,
    application_name: 'hotel-app',
  };
}

class Database {
  constructor() {
    this.target = readTargetFile() || cfg.db.host;
    this.pool = this.createPool(this.target);
    this.health = {
      status: 'unknown', // up | down | unknown
      checkedAt: null,
      lastError: null,
      server: null,
      downSince: null,
    };
    this.incidents = this.loadIncidents();
    this.listeners = [];
  }

  createPool(host) {
    const pool = new Pool(poolOptions(host));
    pool.on('error', (err) => {
      // Errores de clientes inactivos (por ejemplo, el servidor se detuvo): no deben tumbar el proceso.
      console.warn(`[db] conexion inactiva perdida con ${host}: ${err.code || ''} ${err.message}`);
    });
    return pool;
  }

  onTargetChange(fn) {
    this.listeners.push(fn);
  }

  async query(text, params) {
    const host = this.target;
    try {
      return await this.pool.query(text, params);
    } catch (err) {
      if (isConnectionError(err)) {
        this.markDown(err);
        throw new DbUnavailableError(host, err);
      }
      throw err;
    }
  }

  async transaction(fn) {
    const host = this.target;
    let client;
    try {
      client = await this.pool.connect();
    } catch (err) {
      this.markDown(err);
      throw new DbUnavailableError(host, err);
    }
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* conexion perdida */
      }
      if (isConnectionError(err)) {
        this.markDown(err);
        throw new DbUnavailableError(host, err);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // ----------------------------------------------------------- objetivo

  switchTarget(host, { reason = 'manual', actor = 'system', persist = true } = {}) {
    if (!cfg.db.candidates.includes(host)) throw new Error(`Servidor no permitido: ${host}`);
    const previous = this.target;
    if (persist) {
      fs.writeFileSync(TARGET_FILE, `${host}\n`, { mode: 0o666 });
      fs.appendFileSync(TARGET_LOG, `${new Date().toISOString()}|${previous}|${host}|${actor}|${reason}\n`);
    }
    if (host === previous) return;
    const old = this.pool;
    this.target = host;
    this.pool = this.createPool(host);
    this.health.server = null;
    old.end().catch(() => {});
    console.log(`[db] servidor objetivo cambiado: ${previous} -> ${host} (${reason})`);
    this.listeners.forEach((fn) => fn(previous, host));
    this.probe().catch(() => {});
  }

  watchTargetFile() {
    setInterval(() => {
      const fileTarget = readTargetFile();
      if (fileTarget && fileTarget !== this.target && cfg.db.candidates.includes(fileTarget)) {
        this.switchTarget(fileTarget, { reason: 'archivo /lab-control/db-target', persist: false });
      }
    }, 2000).unref();
  }

  // ------------------------------------------------------------ salud

  markDown(err) {
    const now = new Date().toISOString();
    if (this.health.status !== 'down') {
      this.health.downSince = now;
      this.incidents.unshift({ host: this.target, down_at: now, up_at: null, duration_s: null, error: err && (err.code || err.message) });
      this.incidents = this.incidents.slice(0, 20);
      this.saveIncidents();
    }
    this.health.status = 'down';
    this.health.lastError = err ? `${err.code || ''} ${err.message}`.trim() : 'sin conexion';
    this.health.checkedAt = now;
  }

  markUp(server) {
    const now = new Date().toISOString();
    if (this.health.status === 'down' && this.incidents[0] && !this.incidents[0].up_at) {
      const inc = this.incidents[0];
      inc.up_at = now;
      inc.recovered_on = this.target;
      inc.duration_s = Math.round((Date.parse(now) - Date.parse(inc.down_at)) / 100) / 10;
      this.saveIncidents();
    }
    this.health.status = 'up';
    this.health.lastError = null;
    this.health.downSince = null;
    this.health.checkedAt = now;
    this.health.server = server;
  }

  loadIncidents() {
    try {
      return JSON.parse(fs.readFileSync(INCIDENTS_FILE, 'utf8'));
    } catch {
      return [];
    }
  }

  saveIncidents() {
    try {
      fs.writeFileSync(INCIDENTS_FILE, JSON.stringify(this.incidents, null, 2), { mode: 0o666 });
    } catch {
      /* el volumen de control puede no existir fuera de Docker */
    }
  }

  async probe() {
    try {
      const { rows } = await this.pool.query(SERVER_INFO_SQL);
      this.markUp(rows[0]);
      return rows[0];
    } catch (err) {
      this.markDown(err);
      return null;
    }
  }

  startMonitor(intervalMs = 3000) {
    this.probe();
    setInterval(() => this.probe(), intervalMs).unref();
  }

  // Sonda independiente de un candidato (no usa el pool principal).
  static async probeHost(host, timeoutMs = 1500) {
    const client = new Client({ ...poolOptions(host), connectionTimeoutMillis: timeoutMs });
    client.on('error', () => {});
    const started = Date.now();
    try {
      await client.connect();
      const { rows } = await client.query(SERVER_INFO_SQL);
      const info = rows[0];
      if (info.in_recovery) {
        const r = await client.query(STANDBY_SQL);
        info.standby = r.rows[0];
      } else {
        const r = await client.query(REPLICATION_SQL);
        info.replicas = r.rows;
      }
      info.latency_ms = Date.now() - started;
      return { host, reachable: true, ...info };
    } catch (err) {
      return { host, reachable: false, error: err.code || err.message };
    } finally {
      client.end().catch(() => {});
    }
  }
}

const SERVER_INFO_SQL = `
  SELECT current_setting('cluster_name') AS cluster_name,
         pg_is_in_recovery() AS in_recovery,
         split_part(version(), ' ', 2) AS pg_version,
         current_database() AS database,
         to_char(pg_postmaster_start_time(), 'YYYY-MM-DD"T"HH24:MI:SSOF') AS started_at,
         (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
         (SELECT timeline_id FROM pg_control_checkpoint()) AS timeline,
         now() AS server_time`;

const STANDBY_SQL = `
  SELECT pg_last_wal_receive_lsn()::text AS receive_lsn,
         pg_last_wal_replay_lsn()::text AS replay_lsn,
         EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp())::numeric(12,1) AS replay_delay_s,
         (SELECT status FROM pg_stat_wal_receiver LIMIT 1) AS receiver_status,
         (SELECT sender_host FROM pg_stat_wal_receiver LIMIT 1) AS sender_host`;

const REPLICATION_SQL = `
  SELECT application_name, client_addr::text, state, sync_state,
         pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)::bigint AS lag_bytes,
         EXTRACT(EPOCH FROM replay_lag)::numeric(12,3) AS replay_lag_s
  FROM pg_stat_replication`;

const db = new Database();

module.exports = { db, Database, DbUnavailableError, isConnectionError, poolOptions, readTargetFile };
