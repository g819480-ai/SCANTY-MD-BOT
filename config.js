const config = Object.freeze({
  SESSION_ID: process.env.SESSION_ID || 'SCANTY MD BOT',
  PREFIX: process.env.PREFIX || '.',
  BOT_NAME: 'SCANTY MD BOT',
  BOT_FOOTER: '© SCANTY MD BOT',
  // Optional integrations must be configured outside source control.
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || ''
});

export { config };
export default config;
