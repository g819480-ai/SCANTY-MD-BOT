
import 'dotenv/config';
import http from 'node:http';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import { initializeSessionStorage, startUserSession, restoreUserSessions } from "./sessionManager.js";
const { Pool } = pg;
import { initializeFeatureSettings } from './featureSettings.js';

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const DASHBOARD_ORIGIN =
  process.env.DASHBOARD_ORIGIN ||
  'https://scanty-md-dashboard.g819480.workers.dev';

if (!DATABASE_URL || !JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('DATABASE_URL and a JWT_SECRET of at least 32 characters are required.');
}

if (
  !ADMIN_EMAIL ||
  !ADMIN_PASSWORD ||
  Buffer.byteLength(ADMIN_PASSWORD, 'utf8') > 72 ||
  ADMIN_PASSWORD.length < 12
) {
  throw new Error('Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 characters.');
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

function createToken(user) {
  return jwt.sign(
    { userId: user.id },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

function getToken(req) {
  const header = req.headers.authorization || '';

  if (!header.startsWith('Bearer ')) return null;

  return header.slice(7);
}

async function authenticatedUser(req) {
  const token = getToken(req);

  if (!token) return null;

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    const result = await pool.query(
      `SELECT id, email, role, created_at
       FROM users
       WHERE id = $1`,
      [decoded.userId]
    );

    return result.rows[0] || null;
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
    UPDATE users
    SET role = 'user'
    WHERE role IS NULL OR role NOT IN ('user', 'admin')
  `);

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

  await pool.query(
    `INSERT INTO users (email, password_hash, role)
     VALUES ($1, $2, 'admin')
     ON CONFLICT (email) DO NOTHING`,
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

  if (origin === DASHBOARD_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', DASHBOARD_ORIGIN);
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

  if (req.method === 'OPTIONS') {
    if (origin && origin !== DASHBOARD_ORIGIN) {
      return send(res, 403, { error: 'Origin not allowed.' });
    }

    res.writeHead(204);
    return res.end();
  }

  if (origin && origin !== DASHBOARD_ORIGIN) {
    return send(res, 403, { error: 'Origin not allowed.' });
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );

  // Health checks

  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, {
      success: true,
      name: 'SCANTY MD BOT',
      status: 'running'
    });
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { status: 'online' });
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

  // Registration and login

  if (
    req.method === 'POST' &&
    (
      url.pathname === '/api/auth/register' ||
      url.pathname === '/api/auth/login'
    )
  ) {
    if (rateLimit(req, res)) return;

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

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return send(res, 400, {
        error: 'Enter a valid email address.'
      });
    }

    if (
      typeof password !== 'string' ||
      password.length < 8 ||
      Buffer.byteLength(password, 'utf8') > 72
    ) {
      return send(res, 400, {
        error: 'Password must be at least 8 characters and no more than 72 bytes.'
      });
    }

    if (url.pathname === '/api/auth/register') {
      if (email === ADMIN_EMAIL) {
        return send(res, 403, {
          error: 'This email is reserved for the administrator.'
        });
      }

      try {
        const passwordHash = await bcrypt.hash(password, 12);

        const result = await pool.query(
          `INSERT INTO users (email, password_hash, role)
           VALUES ($1, $2, 'user')
           RETURNING id, email, role, created_at`,
          [email, passwordHash]
        );

        const user = result.rows[0];

        return send(res, 201, {
          success: true,
          message: 'Account created successfully.',
          user,
          token: createToken(user)
        });
      } catch (error) {
        if (error.code === '23505') {
          return send(res, 409, {
            error: 'This email is already registered.'
          });
        }

        console.error('Registration error:', error.message);

        return send(res, 500, {
          error: 'Registration could not be completed.'
        });
      }
    }

    try {
      const result = await pool.query(
        `SELECT id, email, password_hash, role, created_at
         FROM users
         WHERE email = $1`,
        [email]
      );

      const user = result.rows[0];

      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return send(res, 401, {
          error: 'Incorrect email or password.'
        });
      }

      return send(res, 200, {
        success: true,
        message: 'Login successful.',
        user: {
          id: user.id,
          email: user.email,
          role: user.role
        },
        token: createToken(user)
      });
    } catch (error) {
      console.error('Login error:', error.message);

      return send(res, 500, {
        error: 'Login could not be completed.'
      });
    }
  }

  // Current logged-in user

  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const user = await authenticatedUser(req);

    if (!user) {
      return send(res, 401, {
        error: 'Please log in again.'
      });
    }

    return send(res, 200, {
      success: true,
      user
    });
  }

  // WhatsApp pairing code

  if (
    req.method === 'POST' &&
    url.pathname === '/api/whatsapp/pair'
  ) {
    if (rateLimit(req, res, 5)) return;

    const user = await authenticatedUser(req);

    if (!user) {
      return send(res, 401, {
        error: 'Please log in before connecting WhatsApp.'
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

    const phoneNumber = String(body.phoneNumber || '').replace(/[\s+()-]/g, '');

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

  // Admin dashboard

  if (
    req.method === 'GET' &&
    (
      url.pathname === '/api/admin/stats' ||
      url.pathname === '/api/admin/users'
    )
  ) {
    const user = await authenticatedUser(req);

    if (!user || user.role !== 'admin') {
      return send(res, 403, {
        error: 'Administrator access required.'
      });
    }

    try {
      if (url.pathname === '/api/admin/stats') {
        const result = await pool.query(`
          SELECT
            COUNT(*)::int AS total_users,
            COUNT(*) FILTER (WHERE role = 'admin')::int AS total_admins,
            COUNT(*) FILTER (WHERE role = 'user')::int AS total_members
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
  });
}

startServer().catch(error => {
  console.error('Server startup failed:', error.message);
  process.exit(1);
});
