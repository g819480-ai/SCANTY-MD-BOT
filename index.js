import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();

app.use(cors({
  origin: process.env.DASHBOARD_ORIGIN || '*'
}));

app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    success: true,
    name: 'SCANTY MD BOT',
    message: 'Welcome to SCANTY MD BOT',
    status: 'running'
  });
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy'
  });
});

app.get('/api', (req, res) => {
  res.json({
    success: true,
    name: 'SCANTY MD BOT API',
    version: '2.0.0'
  });
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`SCANTY MD BOT running on port ${PORT}`);
});
