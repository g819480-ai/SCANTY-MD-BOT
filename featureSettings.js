
import { getMongoDb } from './mongo.js';

export const STATUS_EMOJIS = [
  '❤️', '🔥', '😍', '😂', '🥰', '👏', '👍', '💯', '😘'
];

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
  const db = await getMongoDb();

  await db.collection('bot_settings').createIndex(
    { user_id: 1 },
    { unique: true }
  );

  await db.collection('bot_bans').createIndex(
    { user_id: 1, phone_number: 1 },
    { unique: true }
  );
}

export async function getFeatureSettings(userId) {
  const db = await getMongoDb();

  const savedDocument = await db.collection('bot_settings').findOne({
    user_id: String(userId)
  });

  const saved = savedDocument?.settings || {};

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

  const db = await getMongoDb();

  await db.collection('bot_settings').updateOne(
    { user_id: String(userId) },
    {
      $set: {
        user_id: String(userId),
        settings: current,
        updated_at: new Date()
      },
      $setOnInsert: {
        _id: String(userId)
      }
    },
    { upsert: true }
  );

  return current;
}

export async function listBotBans(userId) {
  const db = await getMongoDb();

  const rows = await db.collection('bot_bans')
    .find({ user_id: String(userId) })
    .sort({ banned_at: -1 })
    .toArray();

  return rows.map(row => ({
    phoneNumber: row.phone_number,
    createdAt: row.banned_at
  }));
}

export async function isBotUserBanned(userId, phoneNumber) {
  const number = normalizePhoneNumber(phoneNumber);
  const db = await getMongoDb();

  const result = await db.collection('bot_bans').findOne({
    user_id: String(userId),
    phone_number: number
  });

  return Boolean(result);
}

export async function banBotUser(userId, phoneNumber) {
  const number = normalizePhoneNumber(phoneNumber);
  const db = await getMongoDb();

  const result = await db.collection('bot_bans').updateOne(
    {
      user_id: String(userId),
      phone_number: number
    },
    {
      $setOnInsert: {
        _id: `${userId}:${number}`,
        user_id: String(userId),
        phone_number: number,
        banned_at: new Date()
      }
    },
    { upsert: true }
  );

  return result.upsertedCount > 0;
}

export async function unbanBotUser(userId, phoneNumber) {
  const number = normalizePhoneNumber(phoneNumber);
  const db = await getMongoDb();

  const result = await db.collection('bot_bans').deleteOne({
    user_id: String(userId),
    phone_number: number
  });

  return result.deletedCount > 0;
}

export function getDefaultFeatureSettings() {
  return {
    ...DEFAULT_SETTINGS,
    statusEmojis: [...DEFAULT_SETTINGS.statusEmojis]
  };
}
