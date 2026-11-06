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
  getQrMonitoringStates,
  getUserSessionStatus,
  restoreUserSessions
} from './sessionManager.js';

import {
  initializeFeatureSettings,
  getFeatureSettings,
  setFeatureSetting,
  listBotBans,
  banBotUser,
  unbanBotUser
} from './featureSettings.js';

const { Pool } = pg;

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const DASHBOARD_ORIGIN = (
  process.env.DASHBOARD_ORIGIN ||
  'https://scanty-md-dashboard.g819480.workers.dev'
).trim().replace(/\/+$/, '');

if (!DATABASE_URL || !JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error(
    'DATABASE_URL and a JWT_SECRET of at least 32 characters are required.'
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

const databaseUrl = new URL(DATABASE_URL);

databaseUrl.searchParams.set('uselibpqcompat', 'true');
databaseUrl.searchParams.set('sslmode', 'require');

const pool = new Pool({
  connectionString: databaseUrl.toString(),
  max: 5,
  connectionTimeoutMillis: 10000
});
const ALLOWED_SETTINGS = [
  'alwaysOnline',
  'autoViewStatus',
  'statusReact',
  'statusEmojis',
  'antiLink',
  'welcome',
  'goodbye',
  'autoReact',
  'prefix',
  'aiChatEnabled',
  'aiPersonality'
];

const BOOLEAN_SETTINGS = [
  'alwaysOnline',
  'autoViewStatus',
  'statusReact',
  'antiLink',
  'welcome',
  'goodbye',
  'autoReact',
  'aiChatEnabled'
];

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

      if (body.length > 10000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
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
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

async function authenticatedUser(req) {
  const token = getToken(req);

  if (!token) return null;

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    const result = await pool.query(
      `SELECT id, email, role, is_guest, created_at
       FROM users WHERE id = $1`,
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

function isAdmin(user) {
  return Boolean(
    user &&
    !user.is_guest &&
    user.role === 'admin'
  );
}

function isVisitor(user) {
  return Boolean(user && user.is_guest);
}

const rateLimits = new Map();

function rateLimit(req, res, limit = 20, windowMs = 60000) {
  const key = `${req.socket.remoteAddress}:${req.method}:${req.url}`;
  const now = Date.now();
  const previous = rateLimits.get(key);

  if (!previous || now - previous.start >= windowMs) {
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
    UPDATE users SET role = 'user'
    WHERE role IS NULL OR role NOT IN ('user', 'admin')
  `);

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

  await pool.query(
    `INSERT INTO users (email, password_hash, role, is_guest)
     VALUES ($1, $2, 'admin', FALSE)
     ON CONFLICT (email) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       role = 'admin',
       is_guest = FALSE`,
    [ADMIN_EMAIL, passwordHash]
  );

  console.log('Database initialized.');
}

async function requireAdmin(req, res) {
  const user = await authenticatedUser(req);

  if (!isAdmin(user)) {
    send(res, 403, {
      error: 'Administrator access required.'
    });
    return null;
  }

  return user;
}

async function requireVisitor(req, res) {
  const user = await authenticatedUser(req);

  if (!isVisitor(user)) {
    send(res, 401, {
      error: 'A valid visitor pairing session is required.'
    });
    return null;
  }

  return user;
}

async function findVisitor(visitorId) {
  if (!/^[a-f0-9-]{16,64}$/i.test(visitorId)) {
    return null;
  }

  const result = await pool.query(
    `SELECT id, created_at
     FROM users
     WHERE id = $1 AND is_guest = TRUE`,
    [visitorId]
  );

  return result.rows[0] || null;
}

async function updateSettings(userId, body) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body)
  ) {
    throw new Error('Settings must be sent as an object.');
  }

  const keys = Object.keys(body);

  if (keys.length === 0) {
    throw new Error('No settings were provided.');
  }

  for (const key of keys) {
    if (!ALLOWED_SETTINGS.includes(key)) {
      throw new Error(`Setting "${key}" is not allowed.`);
    }

    if (
      BOOLEAN_SETTINGS.includes(key) &&
      typeof body[key] !== 'boolean'
    ) {
      throw new Error(`${key} must be true or false.`);
    }
  }

  let settings = await getFeatureSettings(userId);

  for (const key of keys) {
    settings = await setFeatureSetting(
      userId,
      key,
      body[key]
    );
  }

  return settings;
}

async function handleRequest(req, res) {
  const origin = req.headers.origin;

  console.log('CORS CHECK:', {
    method: req.method,
    path: req.url,
    receivedOrigin: origin || '(no origin)',
    allowedOrigin: DASHBOARD_ORIGIN
  });

  if (origin === DASHBOARD_ORIGIN) {
    res.setHeader(
      'Access-Control-Allow-Origin',
      DASHBOARD_ORIGIN
    );
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  );

  res.setHeader('Access-Control-Max-Age', '600');

  if (req.method === 'OPTIONS') {
    if (origin && origin !== DASHBOARD_ORIGIN) {
      return send(res, 403, {
        error: 'Origin not allowed.'
      });
    }

    res.writeHead(204);
    return res.end();
  }

  if (origin && origin !== DASHBOARD_ORIGIN) {
    return send(res, 403, {
      error: 'Origin not allowed.'
    });
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );

  // PUBLIC HEALTH ROUTES

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

  // PRIVATE VISITOR SESSION CREATION

  if (
    req.method === 'POST' &&
    url.pathname === '/api/public/session'
  ) {
    if (rateLimit(req, res, 200)) return;

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

      return send(res, 201, {
        success: true,
        token: createToken(result.rows[0], true),
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

  // PUBLIC REGISTRATION IS DISABLED

  if (
    req.method === 'POST' &&
    url.pathname === '/api/auth/register'
  ) {
    return send(res, 403, {
      error: 'Public registration is disabled.'
    });
  }

  // ADMIN LOGIN

  if (
    req.method === 'POST' &&
    url.pathname === '/api/auth/login'
  ) {
    if (rateLimit(req, res, 200)) return;

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

  // ADMIN IDENTITY

  if (
    req.method === 'GET' &&
    url.pathname === '/api/auth/me'
  ) {
    const user = await requireAdmin(req, res);

    if (!user) return;

    return send(res, 200, {
      success: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role
      }
    });
  }

  // VISITOR PRIVATE DASHBOARD IDENTITY

  if (
    req.method === 'GET' &&
    url.pathname === '/api/visitor/me'
  ) {
    const user = await requireVisitor(req, res);

    if (!user) return;

    return send(res, 200, {
      success: true,
      visitor: {
        id: user.id,
        createdAt: user.created_at,
        connectionStatus: getUserSessionStatus(user.id)
      }
    });
  }

  // VISITOR READS THEIR OWN SETTINGS

  if (
    req.method === 'GET' &&
    url.pathname === '/api/visitor/settings'
  ) {
    const user = await requireVisitor(req, res);

    if (!user) return;

    try {
      return send(res, 200, {
        success: true,
        settings: await getFeatureSettings(user.id)
      });
    } catch (error) {
      console.error('Visitor settings error:', error.message);

      return send(res, 500, {
        error: 'Could not load your bot settings.'
      });
    }
  }

  // VISITOR UPDATES THEIR OWN SETTINGS

  if (
    req.method === 'POST' &&
    url.pathname === '/api/visitor/settings'
  ) {
    const user = await requireVisitor(req, res);

    if (!user) return;

    let body;

    try {
      body = await readBody(req);

      const settings = await updateSettings(user.id, body);

      return send(res, 200, {
        success: true,
        message: 'Your bot settings have been updated.',
        settings
      });
    } catch (error) {
      return send(res, 400, {
        error: error.message || 'Could not update your settings.'
      });
    }
  }

  // WHATSAPP QR GENERATION

  if (
    req.method === 'POST' &&
    url.pathname === '/api/whatsapp/qr'
  ) {
    if (rateLimit(req, res, 200, 30000)) return;

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

  // WHATSAPP QR STATUS POLLING

  if (
    req.method === 'GET' &&
    url.pathname === '/api/whatsapp/qr'
  ) {
    if (rateLimit(req, res, 200, 30000)) return;

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

  // WHATSAPP PHONE PAIRING

  if (
    req.method === 'POST' &&
    url.pathname === '/api/whatsapp/pair'
  ) {
    if (rateLimit(req, res, 200, 30000)) return;

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

    const phoneNumber = String(body.phoneNumber || '')
      .replace(/[\s+()-]/g, '');

    if (!/^\d{10,15}$/.test(phoneNumber)) {
      return send(res, 400, {
        error: 'Enter your phone number with country code, using digits only.'
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
        pairingCode
      });
    } catch (error) {
      console.error('WhatsApp pairing error:', error.message);

      return send(res, 400, {
        error: error.message || 'Could not start WhatsApp pairing.'
      });
    }
  }

  // ADMIN: QR SESSION MONITORING

  if (
    req.method === 'GET' &&
    url.pathname === '/api/admin/qr-sessions'
  ) {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    return send(res, 200, {
      success: true,
      sessions: getQrMonitoringStates()
    });
  }

  // ADMIN STATS AND USERS

  if (
    req.method === 'GET' &&
    (
      url.pathname === '/api/admin/stats' ||
      url.pathname === '/api/admin/users'
    )
  ) {
    const admin = await requireAdmin(req, res);

    if (!admin) return;

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
            )::int AS total_members,

            COUNT(*) FILTER (
              WHERE is_guest = TRUE
            )::int AS total_visitors

          FROM users
        `);

        const connectedResult = await pool.query(`
          SELECT COUNT(*)::int AS connected_visitors
          FROM users u
          WHERE u.is_guest = TRUE
          AND EXISTS (
            SELECT 1
            FROM whatsapp_sessions w
            WHERE w.user_id = u.id
              AND w.record_type = 'creds'
              AND w.record_id = 'main'
          )
        `);

        return send(res, 200, {
          success: true,
          stats: {
            ...result.rows[0],
            connected_visitors:
              connectedResult.rows[0].connected_visitors
          }
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

  // ADMIN: LIST ALL VISITORS

  if (
    req.method === 'GET' &&
    url.pathname === '/api/admin/visitors'
  ) {
    const admin = await requireAdmin(req, res);

    if (!admin) return;

    try {
      const result = await pool.query(`
        SELECT id, created_at
        FROM users
        WHERE is_guest = TRUE
        ORDER BY created_at DESC
        LIMIT 500
      `);

      const visitors = result.rows.map(visitor => ({
        id: visitor.id,
        createdAt: visitor.created_at,
        connectionStatus: getUserSessionStatus(visitor.id)
      }));

      return send(res, 200, {
        success: true,
        visitors
      });
    } catch (error) {
      console.error('Visitor list error:', error.message);

      return send(res, 500, {
        error: 'Could not load visitors.'
      });
    }
  }

  // ADMIN: MANAGE A SPECIFIC VISITOR

  const visitorMatch = url.pathname.match(
    /^\/api\/admin\/visitors\/([a-f0-9-]{16,64})(?:\/(settings|bans|ban|unban))?$/i
  );

  if (visitorMatch) {
    const admin = await requireAdmin(req, res);

    if (!admin) return;

    const visitorId = visitorMatch[1];
    const action = visitorMatch[2] || '';

    const visitor = await findVisitor(visitorId);

    if (!visitor) {
      return send(res, 404, {
        error: 'Visitor not found.'
      });
    }

    // ADMIN READS ONE VISITOR

    if (req.method === 'GET' && action === '') {
      return send(res, 200, {
        success: true,
        visitor: {
          id: visitor.id,
          createdAt: visitor.created_at,
          connectionStatus: getUserSessionStatus(visitor.id)
        }
      });
    }

    // ADMIN READS VISITOR SETTINGS

    if (
      req.method === 'GET' &&
      action === 'settings'
    ) {
      try {
        return send(res, 200, {
          success: true,
          settings: await getFeatureSettings(visitorId)
        });
      } catch (error) {
        console.error('Admin visitor settings error:', error.message);

        return send(res, 500, {
          error: 'Could not load visitor settings.'
        });
      }
    }

    // ADMIN UPDATES VISITOR SETTINGS

    if (
      req.method === 'POST' &&
      action === 'settings'
    ) {
      try {
        const body = await readBody(req);
        const settings = await updateSettings(visitorId, body);

        return send(res, 200, {
          success: true,
          message: 'Visitor settings updated.',
          settings
        });
      } catch (error) {
        return send(res, 400, {
          error: error.message || 'Could not update visitor settings.'
        });
      }
    }

    // ADMIN LISTS BANNED NUMBERS

    if (
      req.method === 'GET' &&
      action === 'bans'
    ) {
      try {
        return send(res, 200, {
          success: true,
          bans: await listBotBans(visitorId)
        });
      } catch (error) {
        console.error('Visitor ban list error:', error.message);

        return send(res, 500, {
          error: 'Could not load visitor ban list.'
        });
      }
    }

    // ADMIN BANS A NUMBER

    if (
      req.method === 'POST' &&
      action === 'ban'
    ) {
      let body;

      try {
        body = await readBody(req);

        if (!body.phoneNumber) {
          return send(res, 400, {
            error: 'Phone number is required.'
          });
        }

        const added = await banBotUser(
          visitorId,
          body.phoneNumber
        );

        return send(res, 200, {
          success: true,
          banned: true,
          alreadyBanned: !added,
          message: added
            ? 'Number banned from this visitor bot.'
            : 'Number was already banned.'
        });
      } catch (error) {
        return send(res, 400, {
          error: error.message || 'Could not ban this number.'
        });
      }
    }

    // ADMIN UNBANS A NUMBER

    if (
      req.method === 'POST' &&
      action === 'unban'
    ) {
      let body;

      try {
        body = await readBody(req);

        if (!body.phoneNumber) {
          return send(res, 400, {
            error: 'Phone number is required.'
          });
        }

        const removed = await unbanBotUser(
          visitorId,
          body.phoneNumber
        );

        return send(res, 200, {
          success: true,
          unbanned: removed,
          message: removed
            ? 'Number unbanned from this visitor bot.'
            : 'Number was not on this bot ban list.'
        });
      } catch (error) {
        return send(res, 400, {
          error: error.message || 'Could not unban this number.'
        });
      }
    }

    return send(res, 405, {
      error: 'Method not allowed for this visitor route.'
    });
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
    console.log('Allowed dashboard origin:', DASHBOARD_ORIGIN);
  });
}

startServer().catch(error => {
  console.error('Server startup failed:', error.message);
  process.exit(1);
});
