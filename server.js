
import 'dotenv/config';
import http from 'node:http';
import pg from 'pg';

const { Pool } = pg;
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 10000
});

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200);
    return res.end(JSON.stringify({
      success: true,
      name: 'SCANTY MD BOT',
      status: 'running'
    }));
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200);
    return res.end(JSON.stringify({
      status: 'online',
      bot: 'SCANTY MD BOT'
    }));
  }

  if (req.method === 'GET' && url.pathname === '/db-health') {
    try {
      const result = await pool.query('SELECT NOW() AS database_time');

      res.writeHead(200);
      return res.end(JSON.stringify({
        status: 'connected',
        database: 'Neon PostgreSQL',
        time: result.rows[0].database_time
      }));
    } catch (error) {
      console.error('Database connection failed:', error.message);

      res.writeHead(503);
      return res.end(JSON.stringify({
        status: 'disconnected',
        message: 'Database connection failed'
      }));
    }
  }

  res.writeHead(404);
  return res.end(JSON.stringify({
    error: 'Route not found'
  }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SCANTY MD BOT server running on port ${PORT}`);
});

server.on('error', (error) => {
  console.error('Server error:', error);
  process.exit(1);
});
