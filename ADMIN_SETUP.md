# NYTRO Website Admin einrichten

Das Website-Adminpanel liegt unter `/admin.html`. Es ist ausschließlich für Discord-Konten freigeschaltet, deren Nutzer-ID in `ADMIN_DISCORD_IDS` steht. Die Admin-Whitelist wird absichtlich nicht über das Panel selbst geändert.

## Vercel- und Neon-Variablen

Lege die folgenden Variablen in Vercel für Preview und Production an. Verwende für jede Umgebung die passende Neon-Verbindungszeichenfolge und trage keine Geheimnisse in Git ein.

| Variable | Zweck |
| --- | --- |
| `DATABASE_URL` | TLS-geschützte Verbindungszeichenfolge deiner Neon-Postgres-Datenbank |
| `SESSION_SECRET` | Langer, zufälliger Schlüssel zum Signieren der Login-Sitzungen |
| `ADMIN_DISCORD_IDS` | Discord Nutzer-ID(s) der Website-Admins, bei mehreren IDs durch Kommas getrennt |
| `DISCORD_BOT_TOKEN` | Bot-Token für die serverseitige Prüfung von Rollen im Discord-Server |
| `SITE_DISCORD_GUILD_ID` | Discord-Server-ID, in dem Blacklist-, Wartelisten- und Wartungsrollen liegen |
| `DISCORD_CLIENT_ID` | Bestehende OAuth-Anwendungs-ID |
| `DISCORD_CLIENT_SECRET` | Bestehendes OAuth-Anwendungsgeheimnis |
| `DISCORD_REDIRECT_URI` | OAuth-Callback, zum Beispiel `https://deine-domain.example/auth/callback` |

Beim ersten Aufruf erstellt die Anwendung in Postgres `site_admin_config`, `site_admin_audit` und `user_sessions`. Für das bestehende Server-Dashboard bleibt die bisherige SQLite-Datenbank zunächst bestehen.

## Discord vorbereiten

1. Aktiviere im Discord Developer Portal für den Bot **Server Members Intent**.
2. Füge den Bot zum Server hinzu, der in `SITE_DISCORD_GUILD_ID` eingetragen ist.
3. Lege dort die Rollen für Blacklist, Warteliste und Wartung an. Die Rollen-IDs werden im Adminpanel eingetragen.
4. Schalte den Zugriff erst ein, nachdem Rollen-ID, Bot-Token und Server-ID gesetzt sind. Eine unvollständige aktive Rollenregel sperrt den normalen Zugang sicherheitshalber.
5. Setze deine eigene Discord Nutzer-ID in `ADMIN_DISCORD_IDS`, damit du `/admin.html` öffnen kannst.

Blacklist, Warteliste und Wartung, ihre Texte, der Support-Ticket-Link, Rollen-Vorschau und der Notfallschalter lassen sich dann im Adminpanel verwalten. Änderungen erscheinen im Postgres-Änderungsprotokoll.

## Geheimnis im bisherigen Repository

Die bisherige `.env`-Datei war eingecheckt und enthielt einen gesetzten `SESSION_SECRET`. Sie wurde aus diesem Arbeitsstand entfernt und durch `.env.example` ersetzt. **Ersetze den bisherigen `SESSION_SECRET` in Vercel vor dem nächsten Deployment**; der alte Schlüssel gilt als offengelegt und vorhandene Sitzungen sollten danach neu angemeldet werden.
