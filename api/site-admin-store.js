const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: true },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    })
  : null;

const DEFAULT_CONFIG = Object.freeze({
  blacklistEnabled: false,
  blacklistRoleId: '',
  blacklistTitle: 'Zugang gesperrt',
  blacklistMessage: 'Dein Zugang ist derzeit gesperrt. Bitte eröffne ein Support-Ticket.',
  supportTicketUrl: '',
  waitlistEnabled: false,
  waitlistRoleId: '',
  waitlistTitle: 'Du stehst auf der Warteliste',
  waitlistMessage: 'Wir melden uns bei dir, sobald ein Platz frei ist.',
  maintenanceEnabled: false,
  maintenanceRoleId: '',
  maintenanceTitle: 'Wartungsarbeiten',
  maintenanceMessage: 'Die Website wird gerade gewartet. Bitte versuche es später erneut.',
  emergencyStop: false
});

let schemaPromise;
function ensureSchema() {
  if (!pool) throw new Error('DATABASE_URL ist nicht konfiguriert.');
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS site_admin_config (
        singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
        config JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by TEXT
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS site_admin_audit (
        id BIGSERIAL PRIMARY KEY,
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        action TEXT NOT NULL,
        changes JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await pool.query(
        'INSERT INTO site_admin_config (singleton, config) VALUES (TRUE, $1::jsonb) ON CONFLICT (singleton) DO NOTHING',
        [JSON.stringify(DEFAULT_CONFIG)]
      );
    })().catch(error => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

async function getConfig() {
  await ensureSchema();
  const result = await pool.query('SELECT config, updated_at, updated_by FROM site_admin_config WHERE singleton = TRUE');
  return {
    ...DEFAULT_CONFIG,
    ...(result.rows[0]?.config || {}),
    updatedAt: result.rows[0]?.updated_at || null,
    updatedBy: result.rows[0]?.updated_by || null
  };
}

async function saveConfig(config, actor) {
  await ensureSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentResult = await client.query('SELECT config FROM site_admin_config WHERE singleton = TRUE FOR UPDATE');
    const current = { ...DEFAULT_CONFIG, ...(currentResult.rows[0]?.config || {}) };
    const changes = {};
    for (const [key, value] of Object.entries(config)) {
      if (current[key] !== value) changes[key] = { from: current[key], to: value };
    }
    const result = await client.query(
      `UPDATE site_admin_config SET config = $1::jsonb, updated_at = NOW(), updated_by = $2
       WHERE singleton = TRUE RETURNING config, updated_at, updated_by`,
      [JSON.stringify({ ...current, ...config }), actor.id]
    );
    if (Object.keys(changes).length) {
      await client.query(
        'INSERT INTO site_admin_audit (actor_id, actor_name, action, changes) VALUES ($1, $2, $3, $4::jsonb)',
        [actor.id, actor.name, 'site_config_updated', JSON.stringify(changes)]
      );
    }
    await client.query('COMMIT');
    return { ...result.rows[0].config, updatedAt: result.rows[0].updated_at, updatedBy: result.rows[0].updated_by };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getAudit(limit = 50) {
  await ensureSchema();
  const result = await pool.query(
    'SELECT id, actor_id AS "actorId", actor_name AS "actorName", action, changes, created_at AS "createdAt" FROM site_admin_audit ORDER BY id DESC LIMIT $1',
    [Math.min(100, Math.max(1, Number(limit) || 50))]
  );
  return result.rows;
}

async function close() {
  if (pool) await pool.end();
}

module.exports = { pool, ensureSchema, getConfig, saveConfig, getAudit, close, DEFAULT_CONFIG };
