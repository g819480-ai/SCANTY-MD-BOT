# SCANTY MD BOT

Multi-user WhatsApp automation backend and dashboard API. The production entry point is `server.js`; `npm start` starts that API server, never the legacy standalone bot. User accounts, settings, encrypted Baileys credentials, and bot-access bans are stored in PostgreSQL.

## Local setup

1. Install Node.js 20 or newer and PostgreSQL/Neon.
2. Copy `.env.example` to `.env` and set all required values (see below). Keep `.env` private.
3. Run `npm install`, `npm test`, `npm run check`, then `npm start`.
4. Open `/health` and `/db-health` on the configured service URL.

Required environment variables: `DATABASE_URL`, `JWT_SECRET` (at least 32 characters), `ADMIN_EMAIL`, `ADMIN_PASSWORD` (at least 12 characters, at most 72 UTF-8 bytes), and `SESSION_ENCRYPTION_KEY` (keep the existing production value; at least 64 characters). `PORT` is supplied by Render; local default is 3000. `DASHBOARD_ORIGIN` defaults to the existing SCANTY dashboard origin. Do not rotate `SESSION_ENCRYPTION_KEY` unless you have an explicit session migration plan: doing so makes existing encrypted WhatsApp session rows unreadable.

Public account registration is disabled by the existing API design. Guest pairing identities are created through `/api/public/session`.

## Supported bot commands

`.menu`, `.help`, `.ping`, `.status`, `.settings`, `.alwaysonline on/off`, `.autoviewstatus on/off`, `.statusreact on/off`, `.antilink on/off`, `.welcome on/off`, `.goodbye on/off`, `.autoreact on/off`, `.setemojis <comma-separated emojis>`, and `.unban <phone number>`.

Settings-changing commands and `.unban` require the owner to send the command from the bot account's own chat. `.unban` removes a number from the bot-access ban list; it does not re-add a person to a WhatsApp group. Automatic group welcome/goodbye, anti-link enforcement, and automatic chat reactions require event handlers and are not represented as working features by the current command engine.

WhatsApp pairing and message delivery require a real WhatsApp account, network access, and valid service configuration. A successful health check does not prove a WhatsApp session is connected.
