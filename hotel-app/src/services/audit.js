'use strict';

const { db } = require('../db');

/**
 * Records an audit event. It never receives plaintext sensitive values:
 * only field names, identifiers and outcomes.
 * If the database is unavailable, the event is logged to the console and the request continues.
 */
async function audit(req, action, { targetType = null, targetId = null, outcome = 'success', details = {} } = {}) {
  const user = req && req.session ? req.session.user : null;
  try {
    await db.query(
      `INSERT INTO audit_events (actor_user_id, actor_username, action, target_type, target_id, outcome, details, source_ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [user ? user.id : null, user ? user.username : details.username || 'anonymous', action, targetType, targetId === null ? null : String(targetId), outcome, JSON.stringify(details), req ? req.ip : null],
    );
  } catch (err) {
    console.warn(`[audit] not recorded (${action}/${outcome}): ${err.code || err.message}`);
  }
}

async function recent(limit = 10) {
  const { rows } = await db.query(
    `SELECT occurred_at, actor_username, action, target_type, target_id, outcome, details
     FROM audit_events ORDER BY occurred_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

module.exports = { audit, recent };
