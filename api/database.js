/**
 * NYTRO – SQLite3 Database Layer (async, package: sqlite3)
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.DATABASE_PATH || path.join(dataDir, 'nytro.db');

const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

const DEFAULT_MODULES = ['moderation', 'tickets', 'leveling', 'logging', 'automod', 'welcome'];

let ready = null;

function init() {
  if (ready) return ready;
  ready = (async () => {
    await run('PRAGMA journal_mode = WAL');
    await run('PRAGMA foreign_keys = ON');
    await run(`CREATE TABLE IF NOT EXISTS guilds (
      guild_id TEXT PRIMARY KEY,
      prefix TEXT DEFAULT 'n!',
      mod_log_channel TEXT,
      ticket_category TEXT,
      ticket_log_channel TEXT,
      welcome_channel TEXT,
      welcome_message TEXT,
      auto_role TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`);
    await run(`CREATE TABLE IF NOT EXISTS modules (
      guild_id TEXT NOT NULL,
      module TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      config TEXT DEFAULT '{}',
      PRIMARY KEY (guild_id, module)
    )`);
    await run(`CREATE TABLE IF NOT EXISTS warnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      moderator_id TEXT NOT NULL,
      reason TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`);
    await run(`CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT UNIQUE,
      user_id TEXT NOT NULL,
      subject TEXT,
      status TEXT DEFAULT 'open',
      claimed_by TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      closed_at INTEGER
    )`);
    await run(`CREATE TABLE IF NOT EXISTS xp (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      xp INTEGER DEFAULT 0,
      level INTEGER DEFAULT 0,
      last_message INTEGER DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    )`);
    await run(`CREATE TABLE IF NOT EXISTS automod (
      guild_id TEXT PRIMARY KEY,
      anti_spam INTEGER DEFAULT 1,
      anti_invite INTEGER DEFAULT 1,
      anti_links INTEGER DEFAULT 0,
      max_mentions INTEGER DEFAULT 5,
      blocked_words TEXT DEFAULT '[]',
      mute_role TEXT,
      log_channel TEXT
    )`);
    await run(`CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      type TEXT NOT NULL,
      data TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`);
    await run(`CREATE TABLE IF NOT EXISTS level_roles (
      guild_id TEXT NOT NULL,
      level INTEGER NOT NULL,
      role_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, level)
    )`);
    console.log('📦 SQLite3 bereit:', dbPath);
  })();
  return ready;
}

async function ensureGuild(guildId) {
  await init();
  const exists = await get('SELECT 1 AS ok FROM guilds WHERE guild_id = ?', [guildId]);
  if (!exists) {
    await run('INSERT INTO guilds (guild_id) VALUES (?)', [guildId]);
    for (const m of DEFAULT_MODULES) {
      await run('INSERT OR IGNORE INTO modules (guild_id, module, enabled) VALUES (?, ?, 1)', [guildId, m]);
    }
    await run('INSERT OR IGNORE INTO automod (guild_id) VALUES (?)', [guildId]);
  }
}

async function getGuild(guildId) {
  await ensureGuild(guildId);
  return get('SELECT * FROM guilds WHERE guild_id = ?', [guildId]);
}

async function updateGuild(guildId, data) {
  await ensureGuild(guildId);
  const keys = Object.keys(data).filter(k => k !== 'guild_id');
  if (!keys.length) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  await run(`UPDATE guilds SET ${sets} WHERE guild_id = ?`, [...keys.map(k => data[k]), guildId]);
}

async function getModules(guildId) {
  await ensureGuild(guildId);
  return all('SELECT * FROM modules WHERE guild_id = ?', [guildId]);
}

async function isModuleEnabled(guildId, module) {
  const row = await get('SELECT enabled FROM modules WHERE guild_id = ? AND module = ?', [guildId, module]);
  return row ? !!row.enabled : false;
}

async function setModule(guildId, module, enabled, config = null) {
  await ensureGuild(guildId);
  if (config !== null) {
    await run(
      `INSERT INTO modules (guild_id, module, enabled, config) VALUES (?, ?, ?, ?)
       ON CONFLICT(guild_id, module) DO UPDATE SET enabled = ?, config = ?`,
      [guildId, module, enabled ? 1 : 0, JSON.stringify(config), enabled ? 1 : 0, JSON.stringify(config)]
    );
  } else {
    await run(
      `INSERT INTO modules (guild_id, module, enabled) VALUES (?, ?, ?)
       ON CONFLICT(guild_id, module) DO UPDATE SET enabled = ?`,
      [guildId, module, enabled ? 1 : 0, enabled ? 1 : 0]
    );
  }
}

async function getModuleConfig(guildId, module) {
  const row = await get('SELECT config FROM modules WHERE guild_id = ? AND module = ?', [guildId, module]);
  try { return row ? JSON.parse(row.config || '{}') : {}; } catch { return {}; }
}

async function addWarning(guildId, userId, moderatorId, reason) {
  const r = await run(
    'INSERT INTO warnings (guild_id, user_id, moderator_id, reason) VALUES (?, ?, ?, ?)',
    [guildId, userId, moderatorId, reason || 'Kein Grund']
  );
  return r.lastID;
}

async function getWarnings(guildId, userId) {
  return all(
    'SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC',
    [guildId, userId]
  );
}

async function clearWarnings(guildId, userId) {
  const r = await run('DELETE FROM warnings WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  return r.changes;
}

async function createTicket(guildId, channelId, userId, subject) {
  const r = await run(
    'INSERT INTO tickets (guild_id, channel_id, user_id, subject) VALUES (?, ?, ?, ?)',
    [guildId, channelId, userId, subject || 'Support']
  );
  return r.lastID;
}

async function getTicketByChannel(channelId) {
  return get('SELECT * FROM tickets WHERE channel_id = ?', [channelId]);
}

async function getOpenTickets(guildId) {
  return all(
    "SELECT * FROM tickets WHERE guild_id = ? AND status = 'open' ORDER BY created_at DESC",
    [guildId]
  );
}

async function closeTicket(channelId, closerId) {
  await run(
    "UPDATE tickets SET status = 'closed', closed_at = strftime('%s','now'), claimed_by = COALESCE(claimed_by, ?) WHERE channel_id = ?",
    [closerId, channelId]
  );
}

async function claimTicket(channelId, userId) {
  await run("UPDATE tickets SET claimed_by = ? WHERE channel_id = ? AND status = 'open'", [userId, channelId]);
}

async function getXP(guildId, userId) {
  const row = await get('SELECT * FROM xp WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  return row || { xp: 0, level: 0, last_message: 0 };
}

async function addXP(guildId, userId, amount) {
  const current = await getXP(guildId, userId);
  const now = Math.floor(Date.now() / 1000);
  if (now - (current.last_message || 0) < 60) return null;

  let xp = (current.xp || 0) + amount;
  let level = current.level || 0;
  let leveledUp = false;
  while (xp >= (5 * level * level + 50 * level + 100)) {
    xp -= (5 * level * level + 50 * level + 100);
    level++;
    leveledUp = true;
  }

  await run(
    `INSERT INTO xp (guild_id, user_id, xp, level, last_message) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET xp = ?, level = ?, last_message = ?`,
    [guildId, userId, xp, level, now, xp, level, now]
  );
  return { xp, level, leveledUp, oldLevel: current.level || 0 };
}

async function getLeaderboard(guildId, limit = 10) {
  return all(
    'SELECT * FROM xp WHERE guild_id = ? ORDER BY level DESC, xp DESC LIMIT ?',
    [guildId, limit]
  );
}

async function getLevelRoles(guildId) {
  return all('SELECT * FROM level_roles WHERE guild_id = ? ORDER BY level ASC', [guildId]);
}

async function setLevelRole(guildId, level, roleId) {
  await run(
    `INSERT INTO level_roles (guild_id, level, role_id) VALUES (?, ?, ?)
     ON CONFLICT(guild_id, level) DO UPDATE SET role_id = ?`,
    [guildId, level, roleId, roleId]
  );
}

async function getAutomod(guildId) {
  await ensureGuild(guildId);
  const row = await get('SELECT * FROM automod WHERE guild_id = ?', [guildId]);
  if (row && row.blocked_words) {
    try { row.blocked_words = JSON.parse(row.blocked_words); } catch { row.blocked_words = []; }
  }
  return row;
}

async function updateAutomod(guildId, data) {
  await ensureGuild(guildId);
  const allowed = ['anti_spam', 'anti_invite', 'anti_links', 'max_mentions', 'blocked_words', 'mute_role', 'log_channel'];
  const keys = Object.keys(data).filter(k => allowed.includes(k));
  if (!keys.length) return;
  const values = keys.map(k => (k === 'blocked_words' ? JSON.stringify(data[k]) : data[k]));
  const sets = keys.map(k => `${k} = ?`).join(', ');
  await run(`UPDATE automod SET ${sets} WHERE guild_id = ?`, [...values, guildId]);
}

async function addLog(guildId, type, data) {
  await run('INSERT INTO logs (guild_id, type, data) VALUES (?, ?, ?)', [guildId, type, JSON.stringify(data)]);
}

async function getLogs(guildId, limit = 50) {
  return all('SELECT * FROM logs WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?', [guildId, limit]);
}

module.exports = {
  db, init, ensureGuild, getGuild, updateGuild,
  getModules, isModuleEnabled, setModule, getModuleConfig,
  addWarning, getWarnings, clearWarnings,
  createTicket, getTicketByChannel, getOpenTickets, closeTicket, claimTicket,
  getXP, addXP, getLeaderboard, getLevelRoles, setLevelRole,
  getAutomod, updateAutomod, addLog, getLogs, DEFAULT_MODULES
};
