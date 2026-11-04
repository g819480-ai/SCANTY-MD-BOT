
import 'dotenv/config';

const parseBoolean = (value, fallback = false) => {
  if (value == null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
};

const statusEmojis = (
  process.env.AUTO_LIKE_EMOJI ||
  '❤️,🌹,✨,🥰,😍,💞,💕,☺️,🤗'
)
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

export const config = {
  SESSION_ID: process.env.SESSION_ID || 'SCANTY MD BOT',
  PREFIX: process.env.PREFIX || '.',
  OWNER_NUMBER: process.env.OWNER_NUMBER || '',
  BOT_NAME: process.env.BOT_NAME || 'SCANTY MD Mini',
  BOT_FOOTER: process.env.BOT_FOOTER || '© Powered by SCANTY MD',
  WORK_TYPE: process.env.WORK_TYPE || 'public',

  AUTO_VIEW_STATUS: process.env.AUTO_VIEW_STATUS || 'true',
  AUTO_LIKE_STATUS: process.env.AUTO_LIKE_STATUS || 'true',
  AUTO_LIKE_EMOJI: statusEmojis,
  AUTO_STATUS_REPLY: process.env.AUTO_STATUS_REPLY || 'false',
  AUTO_STATUS_MSG: process.env.AUTO_STATUS_MSG || '🤗',

  READ_MESSAGE: process.env.READ_MESSAGE || 'false',
  AUTO_TYPING: process.env.AUTO_TYPING || 'false',
  AUTO_RECORDING: process.env.AUTO_RECORDING || 'false',

  WELCOME_ENABLE: process.env.WELCOME_ENABLE || 'true',
  GOODBYE_ENABLE: process.env.GOODBYE_ENABLE || 'true',
  WELCOME_MSG: process.env.WELCOME_MSG || null,
  GOODBYE_MSG: process.env.GOODBYE_MSG || null,
  WELCOME_IMAGE: process.env.WELCOME_IMAGE || null,
  GOODBYE_IMAGE: process.env.GOODBYE_IMAGE || null,
  GROUP_INVITE_LINK: process.env.GROUP_INVITE_LINK || '',
  ANTI_CALL: process.env.ANTI_CALL || 'false',
  REJECT_MSG: process.env.REJECT_MSG || '*CALL LATER PLEASE*',
  IMAGE_PATH: process.env.IMAGE_PATH || '',

  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',

  allowedContacts: (process.env.ALLOWED_CONTACTS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean),

  reactionSettings: {
    enabled: parseBoolean(process.env.AUTO_LIKE_STATUS, true),
    emojis: statusEmojis
  }
};

export default config;
