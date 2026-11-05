import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
  max: 3,
  connectionTimeoutMillis: 10000
});

export const STATUS_EMOJIS = ['❤️', '🔥', '😍', '😂', '🥰', '👏', '👍', '💯', '😘'];

const DEFAULT_SETTINGS = Object.freeze({
  alwaysOnline: false,
  autoViewStatus: true,
  statusReact: true,
  statusEmojis: [...STATUS_EMOJIS],
  antiLink: false,
  welcome: false,
  goodbye: false,
  autoReact: false,
  aiChatEnabled: false,
  aiPersonality: 'friendly',
  prefix: '.'
});

function normalizePhoneNumber(input) {
  const number = String(input ?? '').replace(/[\s+()-]/g, '');
  if (!/^\d{7,15}$/.test(number)) {
    throw new Error('Enter a phone number containing 7 to 15 digits.');
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
      owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      phone_number TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_user_id, phone_number)
    )
  `);
}

export async function getFeatureSettings(userId) {
  const result = await pool.query(
    'SELECT settings FROM bot_settings WHERE user_id = $1',
    [userId]
  );

  const saved = result.rows[0]?.settings || {};

  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    statusEmojis: Array.isArray(saved.statusEmojis)
      ? [...saved.statusEmojis]
      : [...DEFAULT_SETTINGS.statusEmojis]
  };
}

function validateSetting(key, value) {
  if (!(key in DEFAULT_SETTINGS)) {
    throw new Error('Unknown bot setting.');
  }

  if (key === 'statusEmojis') {
    if (
      !Array.isArray(value) ||
      value.length < 1 ||
      value.length > 10 ||
      value.some(
        emoji =>
          typeof emoji !== 'string' ||
          !emoji.trim() ||
          emoji.length > 16
      )
    ) {
      throw new Error(
        'statusEmojis must contain between 1 and 10 short emoji values.'
      );
    }

    return [...new Set(value.map(emoji => emoji.trim()))];
  }

  if (key === 'prefix') {
    if (
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > 3 ||
      /\s/.test(value)
    ) {
      throw new Error(
        'prefix must be 1 to 3 non-whitespace characters.'
      );
    }

    return value;
  }

  if (key === 'aiPersonality') {
    if (
      typeof value !== 'string' ||
      value.trim().length < 1 ||
      value.trim().length > 40 ||
      /[\u0000-\u001F\u007F]/.test(value)
    ) {
      throw new Error(
        'aiPersonality must be a valid text value of up to 40 characters.'
      );
    }

    return value.trim();
  }

  if (typeof value !== 'boolean') {
    throw new Error(`${key} must be true or false.`);
  }

  return value;
}

export async function setFeatureSetting(userId, key, value) {
  const validatedValue = validateSetting(key, value);
  const current = await getFeatureSettings(userId);

  current[key] = validatedValue;

  await pool.query(
    `INSERT INTO bot_settings (user_id, settings, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET
       settings = EXCLUDED.settings,
       updated_at = NOW()`,
    [userId, JSON.stringify(current)]
  );

  return current;
}

export async function listBotBans(userId) {
  const result = await pool.query(
    `SELECT phone_number, created_at
     FROM bot_bans
     WHERE owner_user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );

  return result.rows.map(row => ({
    phoneNumber: row.phone_number,
    createdAt: row.created_at
  }));
}

export async function isBotUserBanned(userId, phoneNumber) {
  const number = normalizePhoneNumber(phoneNumber);

  const result = await pool.query(
    `SELECT 1
     FROM bot_bans
     WHERE owner_user_id = $1 AND phone_number = $2`,
    [userId, number]
  );

  return result.rowCount > 0;
}

export async function banBotUser(userId, phoneNumber) {
  const number = normalizePhoneNumber(phoneNumber);

  const result = await pool.query(
    `INSERT INTO bot_bans (owner_user_id, phone_number)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING
     RETURNING phone_number`,
    [userId, number]
  );

  return result.rowCount > 0;
}

export async function unbanBotUser(userId, phoneNumber) {
  const number = normalizePhoneNumber(phoneNumber);

  const result = await pool.query(
    `DELETE FROM bot_bans
     WHERE owner_user_id = $1 AND phone_number = $2
     RETURNING phone_number`,
    [userId, number]
  );

  return result.rowCount > 0;
}

export function getDefaultFeatureSettings() {
  return {
    ...DEFAULT_SETTINGS,
    statusEmojis: [...DEFAULT_SETTINGS.statusEmojis]
  };
}
