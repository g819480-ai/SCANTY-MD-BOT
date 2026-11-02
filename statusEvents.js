import { getFeatureSettings } from './featureSettings.js';

export async function handleStatusUpdate(sock, userId, message) {
  try {
    if (!message?.key || message.key.fromMe) return;
    if (message.key.remoteJid !== 'status@broadcast') return;

    const participant = message.key.participant;

    if (!participant) return;

    const settings = await getFeatureSettings(userId);

    if (settings.autoViewStatus) {
      await sock.readMessages([message.key]);
    }

    if (settings.statusReact) {
      const emojis = settings.statusEmojis?.length
        ? settings.statusEmojis
        : ['❤️', '🔥', '😍', '😂'];

      const emoji = emojis[
        Math.floor(Math.random() * emojis.length)
      ];

      await sock.sendMessage('status@broadcast', {
        react: {
          text: emoji,
          key: message.key
        }
      });
    }
  } catch (error) {
    console.error('Status handler error:', error.message);
  }
}
