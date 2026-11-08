require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const db = require('./api/database');
const siteAdmin = require('./api/site-admin-store');

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;

function getRedirectUri() {
  if (process.env.DISCORD_REDIRECT_URI) return process.env.DISCORD_REDIRECT_URI;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}/auth/callback`;
  return `http://localhost:${PORT}/auth/callback`;
}
const REDIRECT_URI = getRedirectUri();
const isProd = !!(process.env.VERCEL || process.env.NODE_ENV === 'production');
if (isProd && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET muss für den Produktionsbetrieb als Umgebungsvariable gesetzt sein.');
}
if (isProd && !siteAdmin.pool) {
  throw new Error('DATABASE_URL muss für die Postgres-Datenbank in Vercel gesetzt sein.');
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  ...(siteAdmin.pool ? { store: new PgSession({ pool: siteAdmin.pool, tableName: 'user_sessions', createTableIfMissing: true }) } : {}),
  secret: process.env.SESSION_SECRET || 'nytro-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax'
  },
  proxy: isProd
}));

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/auth/login.html');
  getAccessStatus(req.session.user.id).then(status => {
    if (!status.allowed) return res.status(403).json({ error: 'access_denied', access: status });
    next();
  }).catch(error => {
    console.error('Zugriffsprüfung fehlgeschlagen:', error.message);
    res.status(503).json({ error: 'access_check_unavailable' });
  });
}

function isSiteAdmin(userId) {
  const allowedIds = (process.env.ADMIN_DISCORD_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
  return !!userId && allowedIds.includes(String(userId));
}

async function getPolicyConfig() {
  if (!siteAdmin.pool) return siteAdmin.DEFAULT_CONFIG;
  return siteAdmin.getConfig();
}

async function getMemberRoles(userId) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.SITE_DISCORD_GUILD_ID;
  if (!token || !guildId) return { error: 'role_check_not_configured', roles: [] };
  const response = await fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bot ${token}` }
  });
  if (response.status === 404) return { roles: [] };
  if (!response.ok) return { error: 'role_check_failed', roles: [] };
  const member = await response.json();
  return { roles: Array.isArray(member.roles) ? member.roles : [] };
}

async function getAccessStatus(userId) {
  if (isSiteAdmin(userId)) return { allowed: true, state: 'admin' };
  const config = await getPolicyConfig();
  if (config.emergencyStop) return { allowed: false, state: 'emergency', title: 'Zugang vorübergehend gesperrt', message: 'Der Website-Zugang wurde vom Admin-Team vorübergehend pausiert.' };

  const gates = [
    ['blacklistEnabled', 'blacklistRoleId'],
    ['waitlistEnabled', 'waitlistRoleId'],
    ['maintenanceEnabled', 'maintenanceRoleId']
  ].filter(([enabledKey]) => config[enabledKey]);
  if (!gates.length) return { allowed: true, state: 'allowed' };

  if (gates.some(([, roleKey]) => !/^\d{17,20}$/.test(String(config[roleKey] || '')))) {
    return { allowed: false, state: 'configuration_error', title: 'Zugang vorübergehend nicht verfügbar', message: 'Eine aktivierte Rollenregel ist noch nicht vollständig eingerichtet.' };
  }
  const member = await getMemberRoles(userId);
  if (member.error) return { allowed: false, state: 'configuration_error', title: 'Zugang vorübergehend nicht verfügbar', message: 'Die Rollenprüfung ist derzeit nicht verfügbar. Bitte versuche es später erneut.' };
  const roles = new Set(member.roles);

  if (config.blacklistEnabled && roles.has(config.blacklistRoleId)) {
    return { allowed: false, state: 'blacklist', title: config.blacklistTitle, message: config.blacklistMessage, supportTicketUrl: config.supportTicketUrl };
  }
  if (config.waitlistEnabled && roles.has(config.waitlistRoleId)) {
    return { allowed: false, state: 'waitlist', title: config.waitlistTitle, message: config.waitlistMessage, supportTicketUrl: config.supportTicketUrl };
  }
  if (config.maintenanceEnabled && !roles.has(config.maintenanceRoleId)) {
    return { allowed: false, state: 'maintenance', title: config.maintenanceTitle, message: config.maintenanceMessage };
  }
  return { allowed: true, state: 'allowed' };
}

function requireSiteAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'not_authenticated' });
  if (!isSiteAdmin(req.session.user.id)) return res.status(403).json({ error: 'site_admin_required' });
  next();
}

function requireAdminPage(req, res, next) {
  if (!req.session.user) return res.redirect('/auth/login.html');
  if (!isSiteAdmin(req.session.user.id)) return res.status(403).send('Dieser Bereich ist nur für Website-Admins.');
  next();
}

function requireAccessPage(req, res, next) {
  if (!req.session.user) return res.redirect('/auth/login.html');
  getAccessStatus(req.session.user.id).then(status => {
    if (!status.allowed) return res.redirect('/access.html');
    next();
  }).catch(error => {
    console.error('Seiten-Zugriffsprüfung fehlgeschlagen:', error.message);
    res.status(503).send('Der Website-Zugang kann gerade nicht geprüft werden. Bitte versuche es später erneut.');
  });
}

function requireAdminCsrf(req, res, next) {
  const origin = req.get('origin');
  const host = req.get('x-forwarded-host') || req.get('host');
  let sameOrigin = false;
  try { sameOrigin = !!origin && new URL(origin).host.toLowerCase() === String(host || '').toLowerCase(); } catch {}
  const token = req.get('x-csrf-token') || '';
  const expected = req.session.adminCsrf || '';
  const validToken = token.length === expected.length && token.length > 0 && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (!sameOrigin || !validToken) return res.status(403).json({ error: 'invalid_request_token' });
  next();
}

function userHasAdmin(req, guildId) {
  const ug = (req.session.guilds || []).find(g => g.id === guildId);
  if (!ug) return false;
  if (ug.owner) return true;
  return (BigInt(ug.permissions || 0) & 8n) === 8n;
}

// Init DB on first request / startup
db.init().catch(console.error);

// ========== AUTH ==========
app.get('/auth/discord', (req, res) => {
  if (!CLIENT_ID) return res.status(500).send('DISCORD_CLIENT_ID fehlt');
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds'
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/auth/login.html?error=no_code');
  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.redirect('/auth/login.html?error=token');

    const user = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    }).then(r => r.json());

    const guilds = await fetch('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    }).then(r => r.json());

    req.session.user = {
      id: user.id,
      username: user.username,
      discriminator: user.discriminator,
      avatar: user.avatar
    };
    req.session.guilds = guilds;
    const access = await getAccessStatus(user.id);
    if (!access.allowed) return res.redirect('/access.html');
    res.redirect('/dashboard.html');
  } catch (e) {
    console.error(e);
    res.redirect('/auth/login.html?error=oauth');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/index.html'));
});

// ========== API ==========
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json(req.session.user);
});

app.get('/api/access-status', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_authenticated' });
  try { res.json(await getAccessStatus(req.session.user.id)); }
  catch (error) {
    console.error('Zugriffsstatus konnte nicht geladen werden:', error.message);
    res.status(503).json({ error: 'access_check_unavailable' });
  }
});

app.get('/admin.html', requireAdminPage, (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/dashboard.html', requireAccessPage, (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/guild.html', requireAccessPage, (req, res) => res.sendFile(path.join(__dirname, 'guild.html')));

app.get('/api/admin/access', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not_authenticated' });
  res.json({ isAdmin: isSiteAdmin(req.session.user.id) });
});

app.get('/api/admin/config', requireSiteAdmin, async (req, res) => {
  if (!siteAdmin.pool) return res.status(503).json({ error: 'database_not_configured' });
  try {
    await siteAdmin.ensureSchema();
    if (!req.session.adminCsrf) req.session.adminCsrf = crypto.randomBytes(32).toString('hex');
    const [config, audit] = await Promise.all([siteAdmin.getConfig(), siteAdmin.getAudit(30)]);
    res.json({ config, audit, csrfToken: req.session.adminCsrf });
  } catch (error) {
    console.error('Admin-Konfiguration konnte nicht geladen werden:', error.message);
    res.status(503).json({ error: 'admin_storage_unavailable' });
  }
});

app.put('/api/admin/config', requireSiteAdmin, requireAdminCsrf, async (req, res) => {
  if (!siteAdmin.pool) return res.status(503).json({ error: 'database_not_configured' });
  const booleanKeys = ['blacklistEnabled', 'waitlistEnabled', 'maintenanceEnabled', 'emergencyStop'];
  const idKeys = ['blacklistRoleId', 'waitlistRoleId', 'maintenanceRoleId'];
  const textLimits = {
    blacklistTitle: 100, blacklistMessage: 2000,
    waitlistTitle: 100, waitlistMessage: 2000,
    maintenanceTitle: 100, maintenanceMessage: 2000,
    supportTicketUrl: 300
  };
  const allowed = new Set([...booleanKeys, ...idKeys, ...Object.keys(textLimits)]);
  const input = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (Object.keys(input).some(key => !allowed.has(key))) return res.status(400).json({ error: 'unknown_config_field' });

  const clean = {};
  for (const key of booleanKeys) {
    if (key in input && typeof input[key] !== 'boolean') return res.status(400).json({ error: `invalid_${key}` });
    if (key in input) clean[key] = input[key];
  }
  for (const key of idKeys) {
    if (!(key in input)) continue;
    const value = String(input[key] || '').trim();
    if (value && !/^\d{17,20}$/.test(value)) return res.status(400).json({ error: `invalid_${key}` });
    clean[key] = value;
  }
  for (const [key, limit] of Object.entries(textLimits)) {
    if (!(key in input)) continue;
    if (typeof input[key] !== 'string' || input[key].length > limit) return res.status(400).json({ error: `invalid_${key}` });
    clean[key] = input[key].trim();
  }
  if (clean.supportTicketUrl) {
    let url;
    try { url = new URL(clean.supportTicketUrl); } catch { return res.status(400).json({ error: 'invalid_supportTicketUrl' }); }
    if (url.protocol !== 'https:' || !['discord.gg', 'discord.com', 'www.discord.com'].includes(url.hostname.toLowerCase())) {
      return res.status(400).json({ error: 'invalid_supportTicketUrl' });
    }
  }

  try {
    const config = await siteAdmin.saveConfig(clean, {
      id: req.session.user.id,
      name: req.session.user.username || 'Website-Admin'
    });
    res.json({ ok: true, config, audit: await siteAdmin.getAudit(30) });
  } catch (error) {
    console.error('Admin-Konfiguration konnte nicht gespeichert werden:', error.message);
    res.status(503).json({ error: 'admin_storage_unavailable' });
  }
});

app.post('/api/admin/access-check', requireSiteAdmin, requireAdminCsrf, async (req, res) => {
  const userId = String(req.body?.userId || '').trim();
  if (!/^\d{17,20}$/.test(userId)) return res.status(400).json({ error: 'invalid_discord_user_id' });
  try {
    const status = await getAccessStatus(userId);
    res.json({ userId, ...status });
  } catch (error) {
    console.error('Rollen-Vorschau fehlgeschlagen:', error.message);
    res.status(503).json({ error: 'access_check_unavailable' });
  }
});

app.get('/api/guilds', requireAuth, async (req, res) => {
  try {
    await db.init();
    const ADMIN = 8n;
    const result = [];
    for (const ug of req.session.guilds || []) {
      const perms = BigInt(ug.permissions || 0);
      if ((perms & ADMIN) !== ADMIN && !ug.owner) continue;
      await db.ensureGuild(ug.id);
      const modules = await db.getModules(ug.id);
      result.push({
        id: ug.id,
        name: ug.name,
        icon: ug.icon,
        owner: ug.owner,
        memberCount: null,
        botPresent: true,
        modules: modules.map(m => ({ name: m.module, enabled: !!m.enabled }))
      });
    }
    res.json({ guilds: result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'DB error' });
  }
});

app.get('/api/guilds/:id', requireAuth, async (req, res) => {
  try {
    if (!userHasAdmin(req, req.params.id)) return res.status(403).json({ error: 'Keine Admin-Rechte' });
    const guildId = req.params.id;
    await db.ensureGuild(guildId);
    const ug = (req.session.guilds || []).find(g => g.id === guildId);
    const logs = await db.getLogs(guildId, 30);
    res.json({
      id: guildId,
      name: ug?.name || 'Server',
      memberCount: 0,
      botPresent: true,
      settings: await db.getGuild(guildId),
      modules: (await db.getModules(guildId)).map(m => ({
        name: m.module,
        enabled: !!m.enabled,
        config: {}
      })),
      automod: await db.getAutomod(guildId),
      openTickets: await db.getOpenTickets(guildId),
      logs: logs.map(l => {
        try { return { ...l, data: JSON.parse(l.data || '{}') }; }
        catch { return { ...l, data: {} }; }
      }),
      leaderboard: await db.getLeaderboard(guildId, 10),
      levelRoles: await db.getLevelRoles(guildId),
      channels: [],
      roles: []
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'DB error' });
  }
});

app.post('/api/guilds/:id/settings', requireAuth, async (req, res) => {
  try {
    if (!userHasAdmin(req, req.params.id)) return res.status(403).json({ error: 'Keine Admin-Rechte' });
    const allowed = ['prefix', 'mod_log_channel', 'ticket_category', 'ticket_log_channel', 'welcome_channel', 'welcome_message', 'auto_role'];
    const data = {};
    for (const k of allowed) if (req.body[k] !== undefined) data[k] = req.body[k] || null;
    await db.updateGuild(req.params.id, data);
    res.json({ ok: true, settings: await db.getGuild(req.params.id) });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.post('/api/guilds/:id/modules/:module', requireAuth, async (req, res) => {
  try {
    if (!userHasAdmin(req, req.params.id)) return res.status(403).json({ error: 'Keine Admin-Rechte' });
    await db.setModule(req.params.id, req.params.module, !!req.body.enabled);
    res.json({ ok: true, module: req.params.module, enabled: !!req.body.enabled });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.post('/api/guilds/:id/automod', requireAuth, async (req, res) => {
  try {
    if (!userHasAdmin(req, req.params.id)) return res.status(403).json({ error: 'Keine Admin-Rechte' });
    await db.updateAutomod(req.params.id, req.body);
    res.json({ ok: true, automod: await db.getAutomod(req.params.id) });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.get('/api/invite', (req, res) => {
  if (!CLIENT_ID) return res.status(500).send('CLIENT_ID fehlt');
  res.redirect(
    `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&permissions=8&scope=bot%20applications.commands`
  );
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.static(__dirname));

console.log('🔗 Redirect URI:', REDIRECT_URI);
if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`🌐 http://localhost:${PORT}`));
}
module.exports = app;
