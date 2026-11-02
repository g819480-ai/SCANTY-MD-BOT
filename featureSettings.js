
import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3
});

const DEFAULT_SETTINGS = {
  alwaysOnline: false,
  autoViewStatus: true,
  statusReact: true,
  statusEmojis: ['❤️', '🔥', '😍', '😂'],
  antiLink: false,
  welcome: false,
  goodbye: false,
  autoReact: false
};

export async function initializeFeatureSettings() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function getFeatureSettings(userId) {
  const result = await pool.query(
    'SELECT settings FROM bot_settings WHERE user_id = $1',
    [userId]
  );

  return {
    ...DEFAULT_SETTINGS,
    ...(result.rows[0]?.settings || {})
  };
}

export async function setFeatureSetting(userId, key, value) {
  const allowed = Object.keys(DEFAULT_SETTINGS);

  if (!allowed.includes(key)) {
    throw new Error('Unknown bot setting.');
  }

  const current = await getFeatureSettings(userId);
  current[key] = value;

  await pool.query(
    `INSERT INTO bot_settings (user_id, settings, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET settings = EXCLUDED.settings,
                   updated_at = NOW()`,
    [userId, JSON.stringify(current)]
  );

  return current;
}
