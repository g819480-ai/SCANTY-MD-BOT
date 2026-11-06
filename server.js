
import 'dotenv/config';
import http from 'node:http';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

import { getMongoDb } from './mongo.js';

import {
  initializeSessionStorage,
  startUserSession,
  startUserQrSession,
  getUserQrState,
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

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const DASHBOARD_ORIGIN = (
  process.env.DASHBOARD_ORIGIN ||
  'https://scanty-md-dashboard.g819480.workers.dev'
).trim().replace(/\/+$/, '');

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error(
    'JWT_SECRET of at least 32 characters is required.'
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

  return header.startsWith('Bearer ')
    ? header.slice(7)
    : null;
}

async function authenticatedUser(req) {
  const token = getToken(req);

  if (!token) return null;

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    const db = await getMongoDb();

    const user = await db.collection('users').findOne({
      id: String(decoded.userId)
    });

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

function rateLimit(req, res, limit = 20) {
  const key = `${req.socket.remoteAddress}:${req.url}`;
  const now = Date.now();
  const previous = rateLimits.get(key);

  if (!previous || now - previous.start > 60000) {
    rateLimits.set(key, {
      start: now,
      count: 1
    });

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

/*
 * MONGODB INITIALIZATION
 */

async function initializeDatabase() {
  const db = await getMongoDb();

  await db.collection('users').createIndex(
    { email: 1 },
    { unique: true }
  );

  await db.collection('users').createIndex({
    is_guest: 1,
    created_at: -1
  });

  await db.collection('whatsapp_sessions').createIndex({
    user_id: 1,
    record_type: 1,
    record_id: 1
  });

  await db.collection('bot_settings').createIndex(
    { user_id: 1 },
    { unique: true }
  );

  await db.collection('bot_bans').createIndex(
    { user_id: 1, phone_number: 1 },
    { unique: true }
  );

  const passwordHash = await bcrypt.hash(
    ADMIN_PASSWORD,
    12
  );

  await db.collection('users').updateOne(
    { email: ADMIN_EMAIL },
    {
      $set: {
        email: ADMIN_EMAIL,
        password_hash: passwordHash,
        role: 'admin',
        is_guest: false
      },
      $setOnInsert: {
        _id: crypto.randomUUID(),
        id: crypto.randomUUID(),
        created_at: new Date()
      }
    },
    { upsert: true }
  );

  console.log('MongoDB database initialized.');
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

  const db = await getMongoDb();

  return db.collection('users').findOne({
    id: String(visitorId),
    is_guest: true
  });
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
      const db = await getMongoDb();
      await db.command({ ping: 1 });

      return send(res, 200, {
        status: 'connected',
        database: 'MongoDB Atlas'
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
    if (rateLimit(req, res, 5)) return;

    try {
      const db = await getMongoDb();

      const guestId = crypto.randomUUID();

      const guestEmail =
        `guest-${guestId}@guest.scanty.invalid`;

      const randomPassword =
        crypto.randomBytes(48).toString('hex');

      const passwordHash = await bcrypt.hash(
        randomPassword,
        10
      );

      const guest = {
        _id: guestId,
        id: guestId,
        email: guestEmail,
        password_hash: passwordHash,
        role: 'user',
        is_guest: true,
        created_at: new Date()
      };

      await db.collection('users').insertOne(guest);

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
    if (rateLimit(req, res, 5)) return;

    let body;

    try {
      body = await readBody(req);
    } catch {
      return send(res, 400, {
        error: 'Invalid request body.'
      });
    }

    const email = String(body.email || '')
      .trim()
      .toLowerCase();

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
      const db = await getMongoDb();

      const user = await db.collection('users').findOne({
        email: ADMIN_EMAIL,
        is_guest: false
      });

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

    try {
      const body = await readBody(req);
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

  // WHATSAPP QR PAIRING

  if (
    req.method === 'POST' &&
    url.pathname === '/api/whatsapp/qr'
  ) {
    if (rateLimit(req, res, 5)) return;

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

  if (
    req.method === 'GET' &&
    url.pathname === '/api/whatsapp/qr'
  ) {
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

  // WHATSAPP PHONE PAIRING

  if (
    req.method === 'POST' &&
    url.pathname === '/api/whatsapp/pair'
  ) {
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

  // ADMIN OVERVIEW AND EXISTING NON-GUEST USERS

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
      const db = await getMongoDb();
      const users = db.collection('users');

      if (url.pathname === '/api/admin/stats') {
        const [
          totalUsers,
          totalAdmins,
          totalMembers,
          totalVisitors,
          visitorIds
        ] = await Promise.all([
          users.countDocuments({ is_guest: false }),
          users.countDocuments({
            role: 'admin',
            is_guest: false
          }),
          users.countDocuments({
            role: 'user',
            is_guest: false
          }),
          users.countDocuments({ is_guest: true }),
          users.distinct('id', { is_guest: true })
        ]);

        let connectedVisitors = 0;

        if (visitorIds.length > 0) {
          connectedVisitors =
            await db.collection('whatsapp_sessions').countDocuments({
              user_id: { $in: visitorIds },
              record_type: 'creds',
              record_id: 'main'
            });
        }

        return send(res, 200, {
          success: true,
          stats: {
            total_users: totalUsers,
            total_admins: totalAdmins,
            total_members: totalMembers,
            total_visitors: totalVisitors,
            connected_visitors: connectedVisitors
          }
        });
      }

      const result = await users.find({
        is_guest: false
      })
        .sort({ created_at: -1 })
        .limit(100)
        .project({
          _id: 0,
          id: 1,
          email: 1,
          role: 1,
          created_at: 1
        })
        .toArray();

      return send(res, 200, {
        success: true,
        users: result
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
      const db = await getMongoDb();

      const result = await db.collection('users').find({
        is_guest: true
      })
        .sort({ created_at: -1 })
        .limit(500)
        .project({
          _id: 0,
          id: 1,
          created_at: 1
        })
        .toArray();

      const visitors = result.map(visitor => ({
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
      try {
        const body = await readBody(req);

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
      try {
        const body = await readBody(req);

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
  await getMongoDb();
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
    console.log('Database: MongoDB Atlas');
    console.log('Allowed dashboard origin:', DASHBOARD_ORIGIN);
  });
}

startServer().catch(error => {
  console.error('Server startup failed:', error.message);
  process.exit(1);
});
