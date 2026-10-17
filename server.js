require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const session = require('express-session');
const path = require('path');
const fetch = require('node-fetch');
const db = require('./lib/database');

const app = express();
const PORT = process.env.PORT || 3000;

// Hinter Vercel/Proxy korrekte HTTPS-URLs & Cookies
app.set("trust proxy", 1);

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const BOT_TOKEN = process.env.DISCORD_TOKEN;

// Produktion: DISCORD_REDIRECT_URI oder VERCEL_URL, sonst localhost
function getRedirectUri() {
  if (process.env.DISCORD_REDIRECT_URI) return process.env.DISCORD_REDIRECT_URI;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}/callback`;
  if (process.env.BASE_URL) return `${process.env.BASE_URL.replace(/\/$/, '')}/callback`;
  return `http://localhost:${PORT}/callback`;
}
const REDIRECT_URI = getRedirectUri();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const isProd = !!(process.env.VERCEL || process.env.NODE_ENV === 'production');
app.use(session({
  secret: process.env.SESSION_SECRET || 'nytro-dev-secret-change-me',
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

// Get bot client (lazy – may not be ready yet)
function getBotClient() {
  // Separates Dashboard: kein Bot-Prozess im selben Service
  // Channel/Rollen-Listen sind dann leer, bis Bot + gemeinsame DB laufen
  return null;
}

// ==================== AUTH MIDDLEWARE ====================

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

// ==================== OAUTH ====================

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/auth/discord', (req, res) => {
  if (!CLIENT_ID) {
    return res.status(500).send('DISCORD_CLIENT_ID nicht konfiguriert. Siehe .env');
  }
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds'
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/login?error=no_code');

  try {
    // Exchange code for token
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
    if (!tokenData.access_token) {
      console.error('Token error:', tokenData);
      return res.redirect('/login?error=token');
    }

    // Get user
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const user = await userRes.json();

    // Get user guilds
    const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const userGuilds = await guildsRes.json();

    req.session.user = {
      id: user.id,
      username: user.username,
      discriminator: user.discriminator,
      avatar: user.avatar,
      accessToken: tokenData.access_token
    };
    req.session.guilds = userGuilds; // raw list from Discord

    res.redirect('/dashboard');
  } catch (err) {
    console.error('OAuth error:', err);
    res.redirect('/login?error=oauth');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// ==================== API: USER ====================

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  const { accessToken, ...safe } = req.session.user;
  res.json(safe);
});

// ==================== API: GUILDS (nur Admin-Rechte) ====================

app.get('/api/guilds', requireAuth, async (req, res) => {
  const userGuilds = req.session.guilds || [];
  const bot = getBotClient();

  // Discord permission bit for ADMINISTRATOR = 0x8
  const ADMIN = 0x8;

  const result = [];

  for (const ug of userGuilds) {
    // User must have Administrator on that guild
    const perms = BigInt(ug.permissions || 0);
    if ((perms & BigInt(ADMIN)) !== BigInt(ADMIN) && !ug.owner) continue;

    // Bot must be on the guild
    const botGuild = bot?.guilds?.cache?.get(ug.id);
    if (!botGuild) {
      // Bot not on this guild – still show with invite option
      result.push({
        id: ug.id,
        name: ug.name,
        icon: ug.icon,
        owner: ug.owner,
        memberCount: null,
        botPresent: false,
        modules: []
      });
      continue;
    }

    db.ensureGuild(ug.id);
    const modules = db.getModules(ug.id);

    result.push({
      id: ug.id,
      name: botGuild.name,
      icon: ug.icon || botGuild.icon,
      owner: ug.owner,
      memberCount: botGuild.memberCount,
      botPresent: true,
      modules: modules.map(m => ({ name: m.module, enabled: !!m.enabled }))
    });
  }

  res.json({ guilds: result });
});

// ==================== API: GUILD DETAILS ====================

app.get('/api/guilds/:id', requireAuth, async (req, res) => {
  const guildId = req.params.id;
  if (!userHasAdmin(req, guildId)) return res.status(403).json({ error: 'Keine Admin-Rechte' });

  const bot = getBotClient();
  const botGuild = bot?.guilds?.cache?.get(guildId);

  db.ensureGuild(guildId);
  const settings = db.getGuild(guildId);
  const modules = db.getModules(guildId);
  const automod = db.getAutomod(guildId);
  const openTickets = db.getOpenTickets(guildId);
  const logs = db.getLogs(guildId, 30);
  const leaderboard = db.getLeaderboard(guildId, 10);
  const levelRoles = db.getLevelRoles(guildId);

  // Channels & roles for dropdowns
  let channels = [];
  let roles = [];
  if (botGuild) {
    channels = botGuild.channels.cache
      .filter(c => c.type === 0) // text
      .map(c => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    roles = botGuild.roles.cache
      .filter(r => r.id !== guildId && !r.managed)
      .map(r => ({ id: r.id, name: r.name, color: r.hexColor }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  res.json({
    id: guildId,
    name: botGuild?.name || 'Unknown',
    memberCount: botGuild?.memberCount || 0,
    botPresent: !!botGuild,
    settings,
    modules: modules.map(m => ({ name: m.module, enabled: !!m.enabled, config: JSON.parse(m.config || '{}') })),
    automod,
    openTickets,
    logs: logs.map(l => ({ ...l, data: JSON.parse(l.data || '{}') })),
    leaderboard,
    levelRoles,
    channels,
    roles
  });
});

// ==================== API: UPDATE SETTINGS ====================

app.post('/api/guilds/:id/settings', requireAuth, (req, res) => {
  const guildId = req.params.id;
  if (!userHasAdmin(req, guildId)) return res.status(403).json({ error: 'Keine Admin-Rechte' });

  const allowed = ['prefix', 'mod_log_channel', 'ticket_category', 'ticket_log_channel', 'welcome_channel', 'welcome_message', 'auto_role'];
  const data = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) data[key] = req.body[key] || null;
  }
  db.updateGuild(guildId, data);
  res.json({ ok: true, settings: db.getGuild(guildId) });
});

app.post('/api/guilds/:id/modules/:module', requireAuth, (req, res) => {
  const { id: guildId, module } = req.params;
  if (!userHasAdmin(req, guildId)) return res.status(403).json({ error: 'Keine Admin-Rechte' });

  const enabled = !!req.body.enabled;
  db.setModule(guildId, module, enabled, req.body.config || null);
  res.json({ ok: true, module, enabled });
});

app.post('/api/guilds/:id/automod', requireAuth, (req, res) => {
  const guildId = req.params.id;
  if (!userHasAdmin(req, guildId)) return res.status(403).json({ error: 'Keine Admin-Rechte' });

  db.updateAutomod(guildId, req.body);
  res.json({ ok: true, automod: db.getAutomod(guildId) });
});

app.post('/api/guilds/:id/levelrole', requireAuth, (req, res) => {
  const guildId = req.params.id;
  if (!userHasAdmin(req, guildId)) return res.status(403).json({ error: 'Keine Admin-Rechte' });

  const { level, role_id } = req.body;
  if (!level || !role_id) return res.status(400).json({ error: 'level und role_id nötig' });
  db.setLevelRole(guildId, parseInt(level), role_id);
  res.json({ ok: true, levelRoles: db.getLevelRoles(guildId) });
});

// ==================== HELPERS ====================

function userHasAdmin(req, guildId) {
  const guilds = req.session.guilds || [];
  const ug = guilds.find(g => g.id === guildId);
  if (!ug) return false;
  if (ug.owner) return true;
  const perms = BigInt(ug.permissions || 0);
  return (perms & BigInt(0x8)) === BigInt(0x8);
}

// ==================== PAGES ====================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/dashboard/:guildId', requireAuth, (req, res) => {
  if (!userHasAdmin(req, req.params.guildId)) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'guild.html'));
});

app.get('/features', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'features.html'));
});

app.get('/docs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'docs.html'));
});

// Invite bot link
app.get('/invite', (req, res) => {
  if (!CLIENT_ID) return res.status(500).send('CLIENT_ID fehlt');
  const url = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&permissions=8&scope=bot%20applications.commands`;
  res.redirect(url);
});

// ==================== START ====================

console.log('🔗 OAuth Redirect URI:', REDIRECT_URI);

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🌐 Dashboard: http://localhost:${PORT}`);
    console.log(`🔗 Callback:  ${REDIRECT_URI}`);
    if (!CLIENT_ID || !CLIENT_SECRET) {
      console.warn('⚠️  DISCORD_CLIENT_ID / CLIENT_SECRET fehlen – OAuth funktioniert nicht.');
    }
  });
}

module.exports = app;
