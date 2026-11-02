
import 'dotenv/config';
import http from 'node:http';

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'online',
      bot: 'SCANTY MD BOT'
    }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({
    error: 'Route not found'
  }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SCANTY MD BOT server running on port ${PORT}`);
});
