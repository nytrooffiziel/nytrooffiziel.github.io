const { pool } = require('./site-admin-store');

const DEFAULT_MODULES = ['moderation', 'tickets', 'leveling', 'logging', 'automod', 'welcome'];
const GUILD_FIELDS = new Set([
  'prefix', 'mod_log_channel', 'ticket_category', 'ticket_log_channel',
  'welcome_channel', 'welcome_message', 'auto_role'
]);
const AUTOMOD_FIELDS = new Set([
  'anti_spam', 'anti_invite', 'anti_links', 'max_mentions',
  'blocked_words', 'mute_role', 'log_channel'
]);

let schemaPromise;

function init() {
  if (!pool) return Promise.reject(new Error('DATABASE_URL ist nicht konfiguriert.'));
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS guilds (
        guild_id TEXT PRIMARY KEY,
        prefix TEXT DEFAULT 'n!',
        mod_log_channel TEXT,
        ticket_category TEXT,
        ticket_log_channel TEXT,
        welcome_channel TEXT,
        welcome_message TEXT,
        auto_role TEXT,
        created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS modules (
        guild_id TEXT NOT NULL,
        module TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        config JSONB NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY (guild_id, module)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS automod (
        guild_id TEXT PRIMARY KEY,
        anti_spam BOOLEAN NOT NULL DEFAULT TRUE,
        anti_invite BOOLEAN NOT NULL DEFAULT TRUE,
        anti_links BOOLEAN NOT NULL DEFAULT FALSE,
        max_mentions INTEGER NOT NULL DEFAULT 5,
        blocked_words TEXT NOT NULL DEFAULT '[]',
        mute_role TEXT,
        log_channel TEXT
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS tickets (
        id BIGSERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT UNIQUE,
        user_id TEXT NOT NULL,
        subject TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        claimed_by TEXT,
        created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT),
        closed_at BIGINT
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS xp (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        xp INTEGER NOT NULL DEFAULT 0,
        level INTEGER NOT NULL DEFAULT 0,
        last_message BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS level_roles (
        guild_id TEXT NOT NULL,
        level INTEGER NOT NULL,
        role_id TEXT NOT NULL,
        PRIMARY KEY (guild_id, level)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS logs (
        id BIGSERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT,
        created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS warnings (
        id BIGSERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        moderator_id TEXT NOT NULL,
        reason TEXT,
        created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT)
      )`);
    })().catch(error => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

async function query(text, values = []) {
  await init();
  return pool.query(text, values);
}

async function ensureGuild(guildId) {
  await query('INSERT INTO guilds (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING', [guildId]);
  for (const moduleName of DEFAULT_MODULES) {
    await query(
      'INSERT INTO modules (guild_id, module, enabled) VALUES ($1, $2, TRUE) ON CONFLICT (guild_id, module) DO NOTHING',
      [guildId, moduleName]
    );
  }
  await query('INSERT INTO automod (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING', [guildId]);
}

async function getGuild(guildId) {
  await ensureGuild(guildId);
  const result = await query('SELECT * FROM guilds WHERE guild_id = $1', [guildId]);
  return result.rows[0] || null;
}

async function updateGuild(guildId, data) {
  await ensureGuild(guildId);
  const entries = Object.entries(data).filter(([key]) => GUILD_FIELDS.has(key));
  if (!entries.length) return;
  const values = entries.map(([, value]) => value);
  const sets = entries.map(([key], index) => `${key} = $${index + 1}`).join(', ');
  values.push(guildId);
  await query(`UPDATE guilds SET ${sets} WHERE guild_id = $${values.length}`, values);
}

async function getModules(guildId) {
  await ensureGuild(guildId);
  const result = await query('SELECT * FROM modules WHERE guild_id = $1 ORDER BY module', [guildId]);
  return result.rows;
}

async function isModuleEnabled(guildId, moduleName) {
  const result = await query('SELECT enabled FROM modules WHERE guild_id = $1 AND module = $2', [guildId, moduleName]);
  return result.rows[0] ? result.rows[0].enabled : false;
}

async function setModule(guildId, moduleName, enabled, config = null) {
  await ensureGuild(guildId);
  if (config === null) {
    await query(
      `INSERT INTO modules (guild_id, module, enabled) VALUES ($1, $2, $3)
       ON CONFLICT (guild_id, module) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [guildId, moduleName, !!enabled]
    );
    return;
  }
  await query(
    `INSERT INTO modules (guild_id, module, enabled, config) VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (guild_id, module) DO UPDATE SET enabled = EXCLUDED.enabled, config = EXCLUDED.config`,
    [guildId, moduleName, !!enabled, JSON.stringify(config)]
  );
}

async function getModuleConfig(guildId, moduleName) {
  const result = await query('SELECT config FROM modules WHERE guild_id = $1 AND module = $2', [guildId, moduleName]);
  return result.rows[0]?.config || {};
}

async function getOpenTickets(guildId) {
  const result = await query(
    "SELECT * FROM tickets WHERE guild_id = $1 AND status = 'open' ORDER BY created_at DESC",
    [guildId]
  );
  return result.rows;
}

async function getAutomod(guildId) {
  await ensureGuild(guildId);
  const result = await query('SELECT * FROM automod WHERE guild_id = $1', [guildId]);
  const row = result.rows[0];
  if (!row) return null;
  try { row.blocked_words = JSON.parse(row.blocked_words || '[]'); }
  catch { row.blocked_words = []; }
  return row;
}

async function updateAutomod(guildId, data) {
  await ensureGuild(guildId);
  const entries = Object.entries(data).filter(([key]) => AUTOMOD_FIELDS.has(key));
  if (!entries.length) return;
  const values = entries.map(([key, value]) => key === 'blocked_words' ? JSON.stringify(value) : value);
  const sets = entries.map(([key], index) => `${key} = $${index + 1}`).join(', ');
  values.push(guildId);
  await query(`UPDATE automod SET ${sets} WHERE guild_id = $${values.length}`, values);
}

async function getLogs(guildId, limit = 50) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  const result = await query(
    'SELECT * FROM logs WHERE guild_id = $1 ORDER BY created_at DESC LIMIT $2',
    [guildId, safeLimit]
  );
  return result.rows;
}

async function getLeaderboard(guildId, limit = 10) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 10));
  const result = await query(
    'SELECT * FROM xp WHERE guild_id = $1 ORDER BY level DESC, xp DESC LIMIT $2',
    [guildId, safeLimit]
  );
  return result.rows;
}

async function getLevelRoles(guildId) {
  const result = await query('SELECT * FROM level_roles WHERE guild_id = $1 ORDER BY level ASC', [guildId]);
  return result.rows;
}

async function setLevelRole(guildId, level, roleId) {
  await query(
    `INSERT INTO level_roles (guild_id, level, role_id) VALUES ($1, $2, $3)
     ON CONFLICT (guild_id, level) DO UPDATE SET role_id = EXCLUDED.role_id`,
    [guildId, level, roleId]
  );
}

async function addLog(guildId, type, data) {
  await query('INSERT INTO logs (guild_id, type, data) VALUES ($1, $2, $3)', [guildId, type, JSON.stringify(data)]);
}

module.exports = {
  pool, init, ensureGuild, getGuild, updateGuild, getModules,
  isModuleEnabled, setModule, getModuleConfig, getOpenTickets,
  getAutomod, updateAutomod, getLogs, getLeaderboard,
  getLevelRoles, setLevelRole, addLog
};
