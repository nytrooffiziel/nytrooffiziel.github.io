require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const session = require('express-session');
const path = require('path');
const fetch = require('node-fetch');
const db = require('./api/database');

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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname)); // HTML, css/, js/ direkt im Root

app.use(session({
  secret: process.env.SESSION_SECRET || 'nytro-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax' },
  proxy: isProd
}));

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/auth/login.html');
  next();
}
function userHasAdmin(req, guildId) {
  const ug = (req.session.guilds || []).find(g => g.id === guildId);
  if (!ug) return false;
  if (ug.owner) return true;
  return (BigInt(ug.permissions || 0) & 8n) === 8n;
}

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

    req.session.user = { id: user.id, username: user.username, discriminator: user.discriminator, avatar: user.avatar };
    req.session.guilds = guilds;
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

app.get('/api/guilds', requireAuth, (req, res) => {
  const ADMIN = 8n;
  const result = [];
  for (const ug of req.session.guilds || []) {
    const perms = BigInt(ug.permissions || 0);
    if ((perms & ADMIN) !== ADMIN && !ug.owner) continue;
    db.ensureGuild(ug.id);
    const modules = db.getModules(ug.id);
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
});

app.get('/api/guilds/:id', requireAuth, (req, res) => {
  if (!userHasAdmin(req, req.params.id)) return res.status(403).json({ error: 'Keine Admin-Rechte' });
  const guildId = req.params.id;
  db.ensureGuild(guildId);
  const ug = (req.session.guilds || []).find(g => g.id === guildId);
  res.json({
    id: guildId,
    name: ug?.name || 'Server',
    memberCount: 0,
    botPresent: true,
    settings: db.getGuild(guildId),
    modules: db.getModules(guildId).map(m => ({ name: m.module, enabled: !!m.enabled, config: {} })),
    automod: db.getAutomod(guildId),
    openTickets: db.getOpenTickets(guildId),
    logs: db.getLogs(guildId, 30).map(l => ({ ...l, data: JSON.parse(l.data || '{}') })),
    leaderboard: db.getLeaderboard(guildId, 10),
    levelRoles: db.getLevelRoles(guildId),
    channels: [],
    roles: []
  });
});

app.post('/api/guilds/:id/settings', requireAuth, (req, res) => {
  if (!userHasAdmin(req, req.params.id)) return res.status(403).json({ error: 'Keine Admin-Rechte' });
  const allowed = ['prefix', 'mod_log_channel', 'ticket_category', 'ticket_log_channel', 'welcome_channel', 'welcome_message', 'auto_role'];
  const data = {};
  for (const k of allowed) if (req.body[k] !== undefined) data[k] = req.body[k] || null;
  db.updateGuild(req.params.id, data);
  res.json({ ok: true, settings: db.getGuild(req.params.id) });
});

app.post('/api/guilds/:id/modules/:module', requireAuth, (req, res) => {
  if (!userHasAdmin(req, req.params.id)) return res.status(403).json({ error: 'Keine Admin-Rechte' });
  db.setModule(req.params.id, req.params.module, !!req.body.enabled);
  res.json({ ok: true, module: req.params.module, enabled: !!req.body.enabled });
});

app.post('/api/guilds/:id/automod', requireAuth, (req, res) => {
  if (!userHasAdmin(req, req.params.id)) return res.status(403).json({ error: 'Keine Admin-Rechte' });
  db.updateAutomod(req.params.id, req.body);
  res.json({ ok: true, automod: db.getAutomod(req.params.id) });
});

app.get('/api/invite', (req, res) => {
  if (!CLIENT_ID) return res.status(500).send('CLIENT_ID fehlt');
  res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&permissions=8&scope=bot%20applications.commands`);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

console.log('🔗 Redirect URI:', REDIRECT_URI);
if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`🌐 http://localhost:${PORT}`));
}
module.exports = app;
