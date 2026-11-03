import 'dotenv/config';
import http from 'node:http';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

import {
  initializeSessionStorage,
  startUserSession,
  startUserQrSession,
  getUserQrState,
  restoreUserSessions
} from './sessionManager.js';

import { initializeFeatureSettings } from './featureSettings.js';
import {
  isValidPhoneNumber,
  isValidUserId,
  normalizePhoneNumber,
  parseDashboardOrigins,
  resolveAllowedOrigin
} from './utils/validation.js';

const { Pool } = pg;

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD?.trim();
const SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY?.trim();

const DASHBOARD_ORIGINS = parseDashboardOrigins(
  process.env.DASHBOARD_ORIGINS || process.env.DASHBOARD_ORIGIN ||
    'https://scanty-md-dashboard.g819480.workers.dev'
);

if (!DATABASE_URL || !JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error(
    'DATABASE_URL and a JWT_SECRET of at least 32 characters are required.'
  );
}

if (!SESSION_ENCRYPTION_KEY || SESSION_ENCRYPTION_KEY.length < 64) {
  throw new Error(
    'SESSION_ENCRYPTION_KEY must be present and at least 64 characters long.'
  );
}

if (
  !ADMIN_EMAIL ||
  !ADMIN_PASSWORD ||
  Buffer.byteLength(ADMIN_PASSWORD, 'utf8') > 72 ||
  ADMIN_PASSWORD.length < 12
) {
  throw new Error(
    'Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 characters.'
  );
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 10000
});

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });

  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
      body += chunk;

      if (body.length > 20000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', reject);
  });
}

function createToken(user, isGuest = false) {
  return jwt.sign(
    { userId: user.id, guest: isGuest },
    JWT_SECRET,
    { expiresIn: isGuest ? '7d' : '1h' }
  );
}

function getToken(req) {
  const header = req.headers.authorization || '';

  if (!header.startsWith('Bearer ')) {
    return null;
  }

  return header.slice(7);
}

async function authenticatedUser(req) {
  const token = getToken(req);

  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    const result = await pool.query(
      `SELECT id, email, role, is_guest, created_at
       FROM users
       WHERE id = $1`,
      [decoded.userId]
    );

    const user = result.rows[0];

    if (!user) return null;
    if (decoded.guest && !user.is_guest) return null;
    if (!decoded.guest && user.is_guest) return null;

    return user;
  } catch {
    return null;
  }
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_guest BOOLEAN NOT NULL DEFAULT FALSE
  `);

  await pool.query(`
    UPDATE users
    SET role = 'user'
    WHERE role IS NULL OR role NOT IN ('user', 'admin')
  `);

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

  await pool.query(
    `INSERT INTO users (email, password_hash, role, is_guest)
     VALUES ($1, $2, 'admin', FALSE)
     ON CONFLICT (email)
     DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       role = 'admin',
       is_guest = FALSE`,
    [ADMIN_EMAIL, passwordHash]
  );

  console.log('Database initialized.');
}

const rateLimits = new Map();

function rateLimit(req, res, limit = 20) {
  const key = `${req.socket.remoteAddress}:${req.url}`;
  const now = Date.now();
  const previous = rateLimits.get(key);

  if (!previous || now - previous.start > 60000) {
    rateLimits.set(key, { start: now, count: 1 });
    return false;
  }

  previous.count += 1;

  if (previous.count > limit) {
    send(res, 429, {
      error: 'Too many requests. Please try again later.'
    });

    return true;
  }

  return false;
}

async function handleRequest(req, res) {
  const origin = req.headers.origin;
  const allowedOrigin = resolveAllowedOrigin(origin, DASHBOARD_ORIGINS);

  if (origin && !allowedOrigin) {
    console.error('CORS BLOCKED:', {
      receivedOrigin: origin,
      allowedOrigins: DASHBOARD_ORIGINS
    });

    return send(res, 403, {
      error: 'Origin not allowed.'
    });
  }

  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  );
  res.setHeader('Access-Control-Max-Age', '600');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );

  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, {
      success: true,
      name: 'SCANTY MD BOT',
      status: 'running'
    });
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, {
      status: 'online'
    });
  }

  if (req.method === 'GET' && url.pathname === '/db-health') {
    try {
      await pool.query('SELECT NOW()');

      return send(res, 200, {
        status: 'connected',
        database: 'Neon PostgreSQL'
      });
    } catch (error) {
      console.error('Database health error:', error.message);

      return send(res, 503, {
        status: 'disconnected'
      });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/public/session') {
    if (rateLimit(req, res, 5)) return;

    try {
      const guestId = crypto.randomUUID();
      const guestEmail = `guest-${guestId}@guest.scanty.invalid`;
      const randomPassword = crypto.randomBytes(48).toString('hex');
      const passwordHash = await bcrypt.hash(randomPassword, 10);

      const result = await pool.query(
        `INSERT INTO users
          (id, email, password_hash, role, is_guest)
         VALUES ($1, $2, $3, 'user', TRUE)
         RETURNING id`,
        [guestId, guestEmail, passwordHash]
      );

      const guest = result.rows[0];

      return send(res, 201, {
        success: true,
        token: createToken(guest, true),
        message: 'Private pairing session created.'
      });
    } catch (error) {
      console.error(
        'Guest session creation failed:',
        error.message
      );

      return send(res, 500, {
        error: 'Could not create a pairing session. Please try again.'
      });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    return send(res, 403, {
      error: 'Public registration is disabled.'
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    if (rateLimit(req, res, 5)) return;

    let body;

    try {
      body = await readBody(req);
    } catch {
      return send(res, 400, {
        error: 'Invalid request body.'
      });
    }

    const email = String(body.email || '').trim().toLowerCase();
    const password = body.password;

    if (
      email !== ADMIN_EMAIL ||
      typeof password !== 'string' ||
      password.length < 1 ||
      Buffer.byteLength(password, 'utf8') > 72
    ) {
      return send(res, 401, {
        error: 'Incorrect administrator email or password.'
      });
    }

    try {
      const result = await pool.query(
        `SELECT id, email, password_hash, role
         FROM users
         WHERE email = $1 AND is_guest = FALSE`,
        [ADMIN_EMAIL]
      );

      const user = result.rows[0];

      if (
        !user ||
        user.role !== 'admin' ||
        !(await bcrypt.compare(password, user.password_hash))
      ) {
        return send(res, 401, {
          error: 'Incorrect administrator email or password.'
        });
      }

      return send(res, 200, {
        success: true,
        message: 'Administrator login successful.',
        user: {
          id: user.id,
          email: user.email,
          role: user.role
        },
        token: createToken(user)
      });
    } catch (error) {
      console.error('Admin login error:', error.message);

      return send(res, 500, {
        error: 'Administrator login could not be completed.'
      });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const user = await authenticatedUser(req);

    if (!user || user.is_guest || user.role !== 'admin') {
      return send(res, 401, {
        error: 'Administrator login required.'
      });
    }

    return send(res, 200, {
      success: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role
      }
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/whatsapp/qr') {
    const user = await authenticatedUser(req);

    if (!user) {
      return send(res, 401, {
        error: 'Create a pairing session before connecting WhatsApp.'
      });
    }

    try {
      await startUserQrSession(user.id);

      return send(res, 202, {
        success: true,
        message: 'QR pairing started. Waiting for WhatsApp QR code.',
        ...getUserQrState(user.id)
      });
    } catch (error) {
      console.error('WhatsApp QR start error:', error.message);

      return send(res, 400, {
        error: error.message || 'Could not start QR pairing.'
      });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/whatsapp/qr') {
    if (rateLimit(req, res, 60)) return;

    const user = await authenticatedUser(req);

    if (!user) {
      return send(res, 401, {
        error: 'Create a pairing session before checking WhatsApp pairing.'
      });
    }

    return send(res, 200, {
      success: true,
      ...getUserQrState(user.id)
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/whatsapp/pair') {
    if (rateLimit(req, res, 5)) return;

    const user = await authenticatedUser(req);

    if (!user) {
      return send(res, 401, {
        error: 'Create a pairing session before connecting WhatsApp.'
      });
    }

    let body;

    try {
      body = await readBody(req);
    } catch {
      return send(res, 400, {
        error: 'Invalid request body.'
      });
    }

    const phoneNumber = normalizePhoneNumber(body.phoneNumber);

    if (!isValidPhoneNumber(phoneNumber)) {
      return send(res, 400, {
        error: 'Enter your phone number with country code, using digits only.'
      });
    }

    if (!isValidUserId(user.id)) {
      return send(res, 400, {
        error: 'Invalid user session.'
      });
    }

    try {
      let pairingCode = null;

      await startUserSession(
        user.id,
        phoneNumber,
        code => {
          pairingCode = code;
        }
      );

      if (!pairingCode) {
        return send(res, 500, {
          error: 'The pairing code could not be generated.'
        });
      }

      return send(res, 200, {
        success: true,
        message: 'Pairing code generated. Enter it in WhatsApp Linked Devices.',
        pairingCode,
        advertising: {
          placement: 'pairing-code',
          compliant: true,
          policy: 'Neutral, non-intrusive, no forced clicks or deceptive UI.'
        }
      });
    } catch (error) {
      console.error('WhatsApp pairing error:', error.message);

      return send(res, 400, {
        error: error.message || 'Could not start WhatsApp pairing.'
      });
    }
  }

  if (
    req.method === 'GET' &&
    (url.pathname === '/api/admin/stats' || url.pathname === '/api/admin/users')
  ) {
    const user = await authenticatedUser(req);

    if (!user || user.is_guest || user.role !== 'admin') {
      return send(res, 403, {
        error: 'Administrator access required.'
      });
    }

    try {
      if (url.pathname === '/api/admin/stats') {
        const result = await pool.query(`
          SELECT
            COUNT(*) FILTER (
              WHERE is_guest = FALSE
            )::int AS total_users,

            COUNT(*) FILTER (
              WHERE role = 'admin' AND is_guest = FALSE
            )::int AS total_admins,

            COUNT(*) FILTER (
              WHERE role = 'user' AND is_guest = FALSE
            )::int AS total_members

          FROM users
        `);

        return send(res, 200, {
          success: true,
          stats: result.rows[0]
        });
      }

      const result = await pool.query(`
        SELECT id, email, role, created_at
        FROM users
        WHERE is_guest = FALSE
        ORDER BY created_at DESC
        LIMIT 100
      `);

      return send(res, 200, {
        success: true,
        users: result.rows
      });
    } catch (error) {
      console.error('Admin request error:', error.message);

      return send(res, 500, {
        error: 'Could not load admin data.'
      });
    }
  }

  return send(res, 404, {
    error: 'Route not found.'
  });
}

async function startServer() {
  await initializeDatabase();
  await initializeSessionStorage();
  await initializeFeatureSettings();
  await restoreUserSessions();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(error => {
      console.error('Request error:', error.message);

      if (!res.headersSent) {
        send(res, 500, {
          error: 'Internal server error.'
        });
      } else {
        res.end();
      }
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`SCANTY MD BOT running on port ${PORT}`);
    console.log('Allowed dashboard origins:', DASHBOARD_ORIGINS);
  });
}

startServer().catch(error => {
  console.error('Server startup failed:', error.message);
  process.exit(1);
});
