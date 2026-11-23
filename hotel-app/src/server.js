'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cfg = require('./config');
const { db } = require('./db');
const vault = require('./vaultClient');
const { sessionMiddleware, locals, csrfCheck, requireAuth } = require('./web');
const { runMigrations } = require('./migrate');
const { runSeed } = require('./seed');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
    hsts: false,
    crossOriginOpenerPolicy: false,
  }),
);

// Bootstrap e iconos servidos localmente (funcionan sin Internet despues de construir la imagen).
const nm = path.join(__dirname, '..', 'node_modules');
app.use('/vendor/bootstrap', express.static(path.join(nm, 'bootstrap', 'dist'), { maxAge: '1d' }));
app.use('/vendor/bootstrap-icons', express.static(path.join(nm, 'bootstrap-icons', 'font'), { maxAge: '1d' }));
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

// Salud del servidor web: responde 200 aunque PostgreSQL o el Key Vault esten caidos.
app.get('/health', (req, res) => {
  const v = vault.lastHealth();
  res.json({
    status: 'ok',
    web: 'up',
    db: { status: db.health.status, target: db.target, cluster: db.health.server ? db.health.server.cluster_name : null, in_recovery: db.health.server ? db.health.server.in_recovery : null },
    vault: { available: v.available, status: v.vault_status || v.error, active_kek_id: v.active_kek_id || null },
  });
});

app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(express.json({ limit: '100kb' }));
app.use(sessionMiddleware());
app.use(locals);
app.use(csrfCheck);

app.use(require('./routes/auth'));
app.use(requireAuth);
app.use('/customers', require('./routes/customers').router);
app.use(require('./routes/main'));

app.use((req, res) => res.status(404).render('error', { title: 'No encontrado', message: 'La pagina solicitada no existe.', code: 404 }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (!res.locals.F) {
    // El error ocurrio antes del middleware de vistas (por ejemplo, cuerpo JSON invalido).
    Object.assign(res.locals, { user: null, csrf: '', flash: null, path: req.path, dbHealth: { target: db.target, ...db.health }, vaultHealth: vault.lastHealth(), F: require('./fields'), fmtDate: String, money: String, query: {}, qs: () => '?' });
  }
  let status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  let title = 'Error';
  let message = err.message;
  if (err.code === 'DB_UNAVAILABLE') {
    status = 503;
    title = 'Base de datos no disponible';
    message = `No hay conexion con PostgreSQL (${db.target}). La aplicacion sigue en linea y se reconectara automaticamente cuando el servidor vuelva o se promueva el standby.`;
  } else if (err.code === '25006') {
    status = 503;
    title = 'Servidor en modo solo lectura';
    message = `El servidor actual (${db.target}) es un standby de solo lectura. Promuevalo o cambie la conexion en Recuperacion.`;
  } else if (status === 403) {
    title = 'Acceso denegado';
  } else if (status === 404) {
    title = 'No encontrado';
  } else if (status >= 500) {
    console.error('[hotel] error no controlado:', err);
    message = 'Ocurrio un error interno. Revise los registros con: docker compose logs hotel-app';
  }
  if (req.path.startsWith('/api/') || req.is('application/json')) {
    return res.status(status).json({ error: err.code || 'ERROR', message });
  }
  return res.status(status).render('error', { title, message, code: err.code || status });
});

// --------------------------------------------------------- inicializacion

const TRANSIENT = new Set(['DB_UNAVAILABLE', 'VAULT_UNAVAILABLE', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', '57P03']);

async function autoInit() {
  if (!cfg.autoInit) {
    console.log('[init] AUTO_INIT=false: use ./scripts/migrate.sh y ./scripts/seed.sh');
    return;
  }
  for (let attempt = 1; attempt <= 90; attempt += 1) {
    try {
      // Las migraciones van primero: crean/actualizan el rol hotel_app con la contrasena de .env.
      try {
        await runMigrations({ host: db.target, log: (m) => console.log(m) });
      } catch (err) {
        if (/modo recuperacion\/standby/.test(err.message)) {
          console.log(`[init] ${db.target} esta en modo standby/recuperacion; no se ejecutan migraciones ni seed.`);
          return;
        }
        if (err.code === '28P01') {
          console.error('[init] PostgreSQL rechazo la contrasena de administrador. El volumen se creo con otro POSTGRES_PASSWORD; vea "Problemas comunes" en el README.');
          return;
        }
        throw err;
      }
      await db.probe();
      await runSeed({ log: (m) => console.log(m) });
      return;
    } catch (err) {
      const transient = TRANSIENT.has(err.code) || /connect|timeout|no disponible|unavailable|starting up|shutting down/i.test(err.message);
      if (!transient) {
        console.error(`[init] Inicializacion automatica detenida: ${err.message}`);
        return;
      }
      console.log(`[init] Esperando dependencias (intento ${attempt}): ${err.message}`);
      await new Promise((r) => setTimeout(r, Math.min(2000 * attempt, 10000)));
    }
  }
}

const server = app.listen(cfg.port, '0.0.0.0', () => {
  console.log(`[hotel] Hotel Management App escuchando en :${cfg.port}; servidor de base de datos: ${db.target}`);
  db.startMonitor(3000);
  db.watchTargetFile();
  vault.health({ fresh: true });
  setInterval(() => vault.health({ fresh: true }), 3000).unref();
  autoInit();
});

process.on('SIGTERM', () => {
  console.log('[hotel] SIGTERM recibido; cerrando');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
process.on('unhandledRejection', (err) => {
  console.error('[hotel] promesa rechazada sin manejar:', err && err.message);
});
