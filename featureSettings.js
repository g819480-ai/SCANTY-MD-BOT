
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
  autoReact: false,

  // Command settings
  prefix: '.',

  // AI settings
  aiChatEnabled: false,
  aiPersonality: 'friendly'
};

const ALLOWED_PERSONALITIES = [
  'friendly',
  'professional',
  'funny',
  'casual'
];

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

  if (key === 'prefix') {
    if (
      typeof value !== 'string' ||
      !/^[^\p{L}\p{N}\s]{1,3}$/u.test(value)
    ) {
      throw new Error(
        'Prefix must contain 1 to 3 punctuation symbols.'
      );
    }
  }

  if (key === 'aiChatEnabled' && typeof value !== 'boolean') {
    throw new Error('AI chat setting must be true or false.');
  }

  if (
    key === 'aiPersonality' &&
    !ALLOWED_PERSONALITIES.includes(value)
  ) {
    throw new Error('Invalid AI personality.');
  }

  if (
    key === 'statusEmojis' &&
    (!Array.isArray(value) ||
      value.length > 20 ||
      value.some(
        emoji => typeof emoji !== 'string' || emoji.length > 20
      ))
  ) {
    throw new Error('Invalid status emoji list.');
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

export async function getDefaultFeatureSettings() {
  return { ...DEFAULT_SETTINGS };
}
