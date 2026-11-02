import 'dotenv/config';
import http from 'node:http';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const { Pool } = pg;
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL || !process.env.JWT_SECRET) {
  throw new Error('DATABASE_URL and JWT_SECRET must be configured.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 10000
});

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
      body += chunk;

      if (body.length > 10000) {
        reject(new Error('Request too large'));
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
    { userId: user.id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

async function startServer() {
  await pool.query('SELECT 1');
  console.log('Neon database connected.');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

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
      } catch {
        return send(res, 503, { status: 'disconnected' });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/register') {
      try {
        const { email, password } = await readBody(req);

        const cleanEmail = String(email || '').trim().toLowerCase();

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
          return send(res, 400, { error: 'Enter a valid email address.' });
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

        const passwordHash = await bcrypt.hash(password, 12);

        const result = await pool.query(
          `INSERT INTO users (email, password_hash)
           VALUES ($1, $2)
           RETURNING id, email, created_at`,
          [cleanEmail, passwordHash]
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
          return send(res, 409, { error: 'This email is already registered.' });
        }

        console.error('Registration error:', error.message);
        return send(res, 400, { error: 'Registration could not be completed.' });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      try {
        const { email, password } = await readBody(req);
        const cleanEmail = String(email || '').trim().toLowerCase();

        if (typeof password !== 'string') {
          return send(res, 400, { error: 'Email and password are required.' });
        }

        const result = await pool.query(
          'SELECT id, email, password_hash FROM users WHERE email = $1',
          [cleanEmail]
        );

        const user = result.rows[0];

        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
          return send(res, 401, { error: 'Incorrect email or password.' });
        }

        return send(res, 200, {
          success: true,
          message: 'Login successful.',
          user: { id: user.id, email: user.email },
          token: createToken(user)
        });
      } catch (error) {
        console.error('Login error:', error.message);
        return send(res, 400, { error: 'Login could not be completed.' });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/me') {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';

      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const result = await pool.query(
          'SELECT id, email, created_at FROM users WHERE id = $1',
          [decoded.userId]
        );

        if (!result.rows[0]) {
          return send(res, 404, { error: 'Account not found.' });
        }

        return send(res, 200, {
          success: true,
          user: result.rows[0]
        });
      } catch {
        return send(res, 401, { error: 'A valid login token is required.' });
      }
    }

    return send(res, 404, { error: 'Route not found.' });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`SCANTY MD BOT running on port ${PORT}`);
  });
}

startServer().catch(error => {
  console.error('Server startup failed:', error.message);
  process.exit(1);
});
