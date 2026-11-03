# SCANTY MD BOT

SCANTY MD BOT is a free WhatsApp automation project built around the official Baileys stack, Neon PostgreSQL, a Render backend, and a Cloudflare dashboard interface.

The project is designed to preserve the SCANTY MD branding while hardening WhatsApp session management and improving pairing, reconnect reliability, and admin security.

## Features

- WhatsApp QR pairing and phone-number pairing
- Session persistence and restoration through Neon PostgreSQL
- Reliable reconnect behavior for transient disconnects
- Status viewing and random status reactions
- Bot command toggles and settings
- Admin login and protected dashboard access
- Free bot usage without forced monetization or ad clicks
- Safe pairing-code screen support with neutral, policy-compliant ad slots

## Requirements

- Node.js 20+
- PostgreSQL-compatible database (Neon recommended)
- Render service for the backend
- Cloudflare Worker or dashboard host configured to call the backend API
- `SESSION_ENCRYPTION_KEY` with at least 64 characters
- `JWT_SECRET` with at least 32 characters

## Environment variables

Copy `.env.example` to `.env` and fill in the real values. Do not commit production secrets.

Required variables:

- `PORT` — backend port; Render usually sets this automatically.
- `NODE_ENV` — `development` or `production`
- `DATABASE_URL` — Neon PostgreSQL connection string
- `JWT_SECRET` — JWT signing secret
- `ADMIN_EMAIL` — administrator email for the secure dashboard login
- `ADMIN_PASSWORD` — secure administrator password (minimum length 12 characters)
- `SESSION_ENCRYPTION_KEY` — encryption key used to protect saved WhatsApp session data
- `DASHBOARD_ORIGIN` — Cloudflare dashboard origin, e.g. `https://scanty-md-dashboard.g819480.workers.dev`

Optional variables:

- `DASHBOARD_ORIGINS` — comma-separated origin list for multiple dashboard domains

## Project architecture

- `server.js` — HTTP API for admin authentication, pairing, health checks, and dashboard compatibility
- `sessionManager.js` — WhatsApp socket lifecycle, QR state, phone pairing, session persistence, and reconnect logic
- `featureSettings.js` — bot command settings persisted in PostgreSQL
- `messageHandler.js` — WhatsApp command routing and bot commands
- `statusEvents.js` — status viewing and random reactions
- `render.yaml` — Render deployment manifest

## Render deployment

Use the included `render.yaml` or create a Web Service on Render with the following settings:

- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/health`
- Node Version: `20`
- Add environment variables from `.env.example`

Important:

- Keep `SESSION_ENCRYPTION_KEY` secret and unique per deployment.
- Add `DATABASE_URL` from your Neon database.
- Keep the admin credentials strong and rotate them periodically.
- Do not expose JWT secrets or session encryption secrets in logs or URLs.

## Cloudflare deployment and compatibility

The backend is configured to allow a Cloudflare dashboard origin through CORS. The environment uses `DASHBOARD_ORIGIN` and optionally `DASHBOARD_ORIGINS` to support explicit allowed origins.

Keep the frontend and backend in sync:

- The Cloudflare dashboard must call the backend API using the same origin list.
- The API answers with JSON only.
- No credentials or session data should appear in the browser or logs.

## WhatsApp pairing and session behavior

The project supports two pairing modes:

1. QR code pairing
2. Phone-number pairing with a generated pairing code

The implementation keeps the current SCANTY MD behavior while tightening lifecycle management:

- transient disconnects attempt to reconnect within safe limits
- terminal disconnect reasons such as `loggedOut` and `badSession` stop the reconnect loop
- stored credentials are restored from Neon if a session is still valid
- the session state is tracked so pairing requests do not overlap with active sockets

## Advertising compatibility policy

The bot remains free to all users. The optional ad placements are only intended for the pairing-code generation flow and must be implemented in a neutral, non-intrusive way.

Requirements for any placement:

- no forced click-throughs
- no deceptive placement or hidden ads
- no injection that violates AdSense policy
- no interruption of pairing or connection steps
- placement must remain clearly separate from account security or pairing actions

The backend exposes a small `advertising` metadata object on the pairing response to support compliant dashboard placement without violating user trust.

## Deployment validation checklist

Before declaring a deployment healthy:

- verify `DATABASE_URL` can connect to Neon
- verify `JWT_SECRET` is set and not empty
- verify `ADMIN_EMAIL` and `ADMIN_PASSWORD` are configured correctly
- verify `SESSION_ENCRYPTION_KEY` is length >= 64
- verify `DASHBOARD_ORIGIN` matches the Cloudflare origin exactly
- test QR pairing and phone-number pairing on a real phone account
- verify reconnect behavior and session restoration after network interruption
- confirm no secrets are printed in logs or returned by the API

## Security notes

- Do not commit `.env` files or session credentials.
- Do not log WhatsApp creds, pairing codes, JWTs, or authentication tokens.
- Keep the admin login protected and rate-limited.
- Use the Render environment variables and keep `NODE_ENV=production` in production deployments.

## Legacy note

The repository originally included a standalone `index.js` entry that used local file-based sessions. The updated approach keeps the main service in `server.js` and uses the Neon-backed session manager for the production runtime.
