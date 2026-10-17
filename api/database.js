const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'nytro.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS guilds (
    guild_id TEXT PRIMARY KEY,
    prefix TEXT DEFAULT 'n!',
    mod_log_channel TEXT,
    ticket_category TEXT,
    ticket_log_channel TEXT,
    welcome_channel TEXT,
    welcome_message TEXT,
    auto_role TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS modules (
    guild_id TEXT NOT NULL,
    module TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    config TEXT DEFAULT '{}',
    PRIMARY KEY (guild_id, module)
  );

  CREATE TABLE IF NOT EXISTS warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    moderator_id TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT UNIQUE,
    user_id TEXT NOT NULL,
    subject TEXT,
    status TEXT DEFAULT 'open',
    claimed_by TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    closed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS xp (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    xp INTEGER DEFAULT 0,
    level INTEGER DEFAULT 0,
    last_message INTEGER DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS automod (
    guild_id TEXT PRIMARY KEY,
    anti_spam INTEGER DEFAULT 1,
    anti_invite INTEGER DEFAULT 1,
    anti_links INTEGER DEFAULT 0,
    max_mentions INTEGER DEFAULT 5,
    blocked_words TEXT DEFAULT '[]',
    mute_role TEXT,
    log_channel TEXT
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS level_roles (
    guild_id TEXT NOT NULL,
    level INTEGER NOT NULL,
    role_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, level)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expired INTEGER
  );
`);

// Default modules for a guild
const DEFAULT_MODULES = ['moderation', 'tickets', 'leveling', 'logging', 'automod', 'welcome'];

function ensureGuild(guildId) {
  const exists = db.prepare('SELECT 1 FROM guilds WHERE guild_id = ?').get(guildId);
  if (!exists) {
    db.prepare('INSERT INTO guilds (guild_id) VALUES (?)').run(guildId);
    const insertMod = db.prepare('INSERT OR IGNORE INTO modules (guild_id, module, enabled) VALUES (?, ?, 1)');
    for (const m of DEFAULT_MODULES) insertMod.run(guildId, m);
    db.prepare('INSERT OR IGNORE INTO automod (guild_id) VALUES (?)').run(guildId);
  }
}

function getGuild(guildId) {
  ensureGuild(guildId);
  return db.prepare('SELECT * FROM guilds WHERE guild_id = ?').get(guildId);
}

function updateGuild(guildId, data) {
  ensureGuild(guildId);
  const keys = Object.keys(data).filter(k => k !== 'guild_id');
  if (!keys.length) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE guilds SET ${sets} WHERE guild_id = ?`).run(...keys.map(k => data[k]), guildId);
}

function getModules(guildId) {
  ensureGuild(guildId);
  return db.prepare('SELECT * FROM modules WHERE guild_id = ?').all(guildId);
}

function isModuleEnabled(guildId, module) {
  const row = db.prepare('SELECT enabled FROM modules WHERE guild_id = ? AND module = ?').get(guildId, module);
  return row ? !!row.enabled : false;
}

function setModule(guildId, module, enabled, config = null) {
  ensureGuild(guildId);
  if (config !== null) {
    db.prepare('INSERT INTO modules (guild_id, module, enabled, config) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, module) DO UPDATE SET enabled = ?, config = ?')
      .run(guildId, module, enabled ? 1 : 0, JSON.stringify(config), enabled ? 1 : 0, JSON.stringify(config));
  } else {
    db.prepare('INSERT INTO modules (guild_id, module, enabled) VALUES (?, ?, ?) ON CONFLICT(guild_id, module) DO UPDATE SET enabled = ?')
      .run(guildId, module, enabled ? 1 : 0, enabled ? 1 : 0);
  }
}

function getModuleConfig(guildId, module) {
  const row = db.prepare('SELECT config FROM modules WHERE guild_id = ? AND module = ?').get(guildId, module);
  try { return row ? JSON.parse(row.config || '{}') : {}; } catch { return {}; }
}

// Warnings
function addWarning(guildId, userId, moderatorId, reason) {
  const r = db.prepare('INSERT INTO warnings (guild_id, user_id, moderator_id, reason) VALUES (?, ?, ?, ?)').run(guildId, userId, moderatorId, reason || 'Kein Grund');
  return r.lastInsertRowid;
}

function getWarnings(guildId, userId) {
  return db.prepare('SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC').all(guildId, userId);
}

function clearWarnings(guildId, userId) {
  return db.prepare('DELETE FROM warnings WHERE guild_id = ? AND user_id = ?').run(guildId, userId).changes;
}

// Tickets
function createTicket(guildId, channelId, userId, subject) {
  const r = db.prepare('INSERT INTO tickets (guild_id, channel_id, user_id, subject) VALUES (?, ?, ?, ?)').run(guildId, channelId, userId, subject || 'Support');
  return r.lastInsertRowid;
}

function getTicketByChannel(channelId) {
  return db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(channelId);
}

function getOpenTickets(guildId) {
  return db.prepare("SELECT * FROM tickets WHERE guild_id = ? AND status = 'open' ORDER BY created_at DESC").all(guildId);
}

function closeTicket(channelId, closerId) {
  db.prepare("UPDATE tickets SET status = 'closed', closed_at = strftime('%s','now'), claimed_by = COALESCE(claimed_by, ?) WHERE channel_id = ?")
    .run(closerId, channelId);
}

function claimTicket(channelId, userId) {
  db.prepare('UPDATE tickets SET claimed_by = ? WHERE channel_id = ? AND status = ?').run(userId, channelId, 'open');
}

// XP / Leveling
function getXP(guildId, userId) {
  return db.prepare('SELECT * FROM xp WHERE guild_id = ? AND user_id = ?').get(guildId, userId) || { xp: 0, level: 0, last_message: 0 };
}

function addXP(guildId, userId, amount) {
  const current = getXP(guildId, userId);
  const now = Math.floor(Date.now() / 1000);
  // Cooldown 60s
  if (now - (current.last_message || 0) < 60) return null;

  let xp = (current.xp || 0) + amount;
  let level = current.level || 0;
  let leveledUp = false;

  // Level formula: 5 * level^2 + 50 * level + 100
  while (xp >= (5 * level * level + 50 * level + 100)) {
    xp -= (5 * level * level + 50 * level + 100);
    level++;
    leveledUp = true;
  }

  db.prepare(`
    INSERT INTO xp (guild_id, user_id, xp, level, last_message) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET xp = ?, level = ?, last_message = ?
  `).run(guildId, userId, xp, level, now, xp, level, now);

  return { xp, level, leveledUp, oldLevel: current.level || 0 };
}

function getLeaderboard(guildId, limit = 10) {
  return db.prepare('SELECT * FROM xp WHERE guild_id = ? ORDER BY level DESC, xp DESC LIMIT ?').all(guildId, limit);
}

function getLevelRoles(guildId) {
  return db.prepare('SELECT * FROM level_roles WHERE guild_id = ? ORDER BY level ASC').all(guildId);
}

function setLevelRole(guildId, level, roleId) {
  db.prepare('INSERT INTO level_roles (guild_id, level, role_id) VALUES (?, ?, ?) ON CONFLICT(guild_id, level) DO UPDATE SET role_id = ?')
    .run(guildId, level, roleId, roleId);
}

// Automod
function getAutomod(guildId) {
  ensureGuild(guildId);
  const row = db.prepare('SELECT * FROM automod WHERE guild_id = ?').get(guildId);
  if (row && row.blocked_words) {
    try { row.blocked_words = JSON.parse(row.blocked_words); } catch { row.blocked_words = []; }
  }
  return row;
}

function updateAutomod(guildId, data) {
  ensureGuild(guildId);
  const allowed = ['anti_spam', 'anti_invite', 'anti_links', 'max_mentions', 'blocked_words', 'mute_role', 'log_channel'];
  const keys = Object.keys(data).filter(k => allowed.includes(k));
  if (!keys.length) return;
  const values = keys.map(k => k === 'blocked_words' ? JSON.stringify(data[k]) : data[k]);
  const sets = keys.map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE automod SET ${sets} WHERE guild_id = ?`).run(...values, guildId);
}

// Logs
function addLog(guildId, type, data) {
  db.prepare('INSERT INTO logs (guild_id, type, data) VALUES (?, ?, ?)').run(guildId, type, JSON.stringify(data));
}

function getLogs(guildId, limit = 50) {
  return db.prepare('SELECT * FROM logs WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?').all(guildId, limit);
}

module.exports = {
  db,
  ensureGuild,
  getGuild,
  updateGuild,
  getModules,
  isModuleEnabled,
  setModule,
  getModuleConfig,
  addWarning,
  getWarnings,
  clearWarnings,
  createTicket,
  getTicketByChannel,
  getOpenTickets,
  closeTicket,
  claimTicket,
  getXP,
  addXP,
  getLeaderboard,
  getLevelRoles,
  setLevelRole,
  getAutomod,
  updateAutomod,
  addLog,
  getLogs,
  DEFAULT_MODULES
};
