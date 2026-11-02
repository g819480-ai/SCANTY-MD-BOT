import 'dotenv/config';
import http from 'node:http';
const PORT = Number(process.env.PORT) || 3000;
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Homepage
  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200);
    return res.end(JSON.stringify({
      success: true,
      name: 'SCANTY MD BOT',
      message: 'Welcome to SCANTY MD BOT',
      status: 'running',
      endpoints: {
        health: '/health',
        api: '/api'
      }
    }, null, 2));
  }

  // Health check
  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200);
    return res.end(JSON.stringify({
      status: 'online',
      bot: 'SCANTY MD BOT',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    }, null, 2));
  }

  // API information
  if (url.pathname === '/api' && req.method === 'GET') {
    res.writeHead(200);
    return res.end(JSON.stringify({
      name: 'SCANTY MD BOT API',
      version: '1.0.0',
      status: 'online',
      message: 'API is ready for development'
    }, null, 2));
  }

  // Unknown route
  res.writeHead(404);
  return res.end(JSON.stringify({
    success: false,
    error: 'Route not found',
    requested: url.pathname
  }, null, 2));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SCANTY MD BOT server running on port ${PORT}`);
});

server.on('error', (error) => {
  console.error('Server error:', error);
  process.exit(1);
});
