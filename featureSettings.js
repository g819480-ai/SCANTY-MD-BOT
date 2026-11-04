
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
  prefix: '.',
  aiChatEnabled: false,
  aiPersonality: 'friendly'
};

const ALLOWED_PERSONALITIES = [
  'friendly',
  'professional',
  'funny',
  'casual'
];

function normalizePhone(phone) {
  const number = String(phone || '').replace(/\D/g, '');

  if (!/^\d{10,15}$/.test(number)) {
    throw new Error('Enter a valid phone number with country code.');
  }

  return number;
}

export async function initializeFeatureSettings() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_bans (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      phone_number TEXT NOT NULL,
      banned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, phone_number)
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
  if (!Object.keys(DEFAULT_SETTINGS).includes(key)) {
    throw new Error('Unknown bot setting.');
  }

  if (key === 'prefix') {
    if (
      typeof value !== 'string' ||
      !/^[^\p{L}\p{N}\s]{1,3}$/u.test(value)
    ) {
      throw new Error('Prefix must contain 1 to 3 punctuation symbols.');
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
      value.length < 1 ||
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

// Ban a person from using this bot account.
export async function banBotUser(userId, phoneNumber) {
  const phone = normalizePhone(phoneNumber);

  const result = await pool.query(
    `INSERT INTO bot_bans (user_id, phone_number)
     VALUES ($1, $2)
     ON CONFLICT (user_id, phone_number) DO NOTHING
     RETURNING phone_number`,
    [userId, phone]
  );

  return result.rowCount > 0;
}

// Restore a person's access to this bot account.
export async function unbanBotUser(userId, phoneNumber) {
  const phone = normalizePhone(phoneNumber);

  const result = await pool.query(
    `DELETE FROM bot_bans
     WHERE user_id = $1 AND phone_number = $2
     RETURNING phone_number`,
    [userId, phone]
  );

  return result.rowCount > 0;
}

// Check whether a sender is banned.
export async function isBotUserBanned(userId, jid) {
  const phone = String(jid || '').split('@')[0].split(':')[0];

  if (!/^\d{10,15}$/.test(phone)) {
    return false;
  }

  const result = await pool.query(
    `SELECT 1 FROM bot_bans
     WHERE user_id = $1 AND phone_number = $2`,
    [userId, phone]
  );

  return result.rowCount > 0;
}

// List banned phone numbers.
export async function listBotBans(userId) {
  const result = await pool.query(
    `SELECT phone_number, banned_at
     FROM bot_bans
     WHERE user_id = $1
     ORDER BY banned_at DESC`,
    [userId]
  );

  return result.rows;
}
