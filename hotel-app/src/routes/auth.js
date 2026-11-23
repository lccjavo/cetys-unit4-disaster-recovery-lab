'use strict';

const express = require('express');
const argon2 = require('argon2');
const { db } = require('../db');
const { audit } = require('../services/audit');

const router = express.Router();
const attempts = new Map();
// Hash ficticio para igualar el tiempo de respuesta cuando el usuario no existe.
let dummyHash = null;
argon2.hash('usuario-inexistente', { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }).then((h) => {
  dummyHash = h;
});

function safeNext(next) {
  return typeof next === 'string' && /^\/(?!\/)[\w\-/?=&.%]*$/.test(next) ? next : '/';
}

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  return res.render('login', { title: 'Iniciar sesion', error: null, username: '', next: safeNext(req.query.next) });
});

router.post('/login', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase().slice(0, 120);
  const password = String(req.body.password || '');
  const next = safeNext(req.body.next);
  const key = `${req.ip}|${username}`;
  const rec = attempts.get(key) || { count: 0, first: Date.now() };
  if (Date.now() - rec.first > 5 * 60 * 1000) {
    rec.count = 0;
    rec.first = Date.now();
  }
  const fail = (status, error) => res.status(status).render('login', { title: 'Iniciar sesion', error, username, next });
  if (rec.count >= 8) return fail(429, 'Demasiados intentos fallidos. Espere 5 minutos.');

  let user;
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.username, u.password_hash, u.role, u.display_name, u.is_active, c.id AS customer_id
       FROM users u LEFT JOIN customers c ON c.user_id = u.id WHERE u.username = $1`,
      [username],
    );
    user = rows[0];
  } catch (err) {
    if (err.code === 'DB_UNAVAILABLE') return fail(503, 'La base de datos no esta disponible en este momento. No es posible validar credenciales.');
    throw err;
  }

  let valid = false;
  if (user) valid = await argon2.verify(user.password_hash, password);
  else if (dummyHash) await argon2.verify(dummyHash, password).catch(() => false);
  if (!user || !valid || !user.is_active) {
    rec.count += 1;
    attempts.set(key, rec);
    await audit(req, 'login', { targetType: 'user', outcome: 'denied', details: { username } });
    return fail(401, 'Usuario o contrasena incorrectos.');
  }
  attempts.delete(key);
  return req.session.regenerate(async (err) => {
    if (err) return res.status(500).render('error', { title: 'Error', message: 'No se pudo crear la sesion.' });
    req.session.user = {
      id: Number(user.id),
      username: user.username,
      role: user.role,
      display_name: user.display_name,
      customer_id: user.customer_id ? Number(user.customer_id) : null,
    };
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]).catch(() => {});
    await audit(req, 'login', { targetType: 'user', targetId: user.id });
    return res.redirect(next);
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
