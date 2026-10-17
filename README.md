# NYTRO Dashboard + Website

Landing Page, Discord-OAuth-Login, Dashboard mit **nur Admin-Servern**.

## Setup lokal

```bash
cd dashboard
cp .env.example .env
# CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, SESSION_SECRET eintragen
npm install
npm start
```

→ http://localhost:3000

## Vercel

1. Diesen Ordner `dashboard/` als Root des Vercel-Projekts nutzen (oder Repo-Root = dieser Ordner)
2. Environment Variables setzen:

```
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
DISCORD_REDIRECT_URI=https://nytro-bot.vercel.app/callback
SESSION_SECRET=...
```

3. Discord OAuth2 Redirect: `https://nytro-bot.vercel.app/callback`

## Hinweis zu better-sqlite3 auf Vercel

Native Module können auf Vercel problematisch sein.  
OAuth + Server-Liste (Admin-Filter) funktionieren über die Discord-API **ohne** lokale DB.  
Einstellungen/Module brauchen eine DB – idealerweise denselben Speicher wie der Bot (gemeinsamer Host) oder später eine Cloud-DB (z.B. Turso).

## Seiten

| URL | Inhalt |
|-----|--------|
| `/` | Website / Landing |
| `/login` | Discord Login |
| `/callback` | OAuth Callback |
| `/dashboard` | Server-Liste (nur Admin) |
| `/dashboard/:id` | Server-Einstellungen |
| `/features` | Features |
| `/docs` | Dokumentation |
| `/invite` | Bot-Invite-Link |
