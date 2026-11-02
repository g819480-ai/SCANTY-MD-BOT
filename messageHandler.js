const PREFIX = '.';
const processedMessages = new Set();

function getMessageText(message) {
  let content = message.message;

  if (!content) return '';

  // Unwrap common WhatsApp message wrappers.
  content =
    content.ephemeralMessage?.message ||
    content.viewOnceMessage?.message ||
    content.viewOnceMessageV2?.message ||
    content;

  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    ''
  ).trim();
}

function getSenderName(message) {
  return (
    message.pushName ||
    message.key.participant?.split('@')[0] ||
    'User'
  );
}

export async function handleIncomingMessage(sock, userId, message) {
  try {
    if (!message?.key || message.key.fromMe) return;

    const chatId = message.key.remoteJid;

    if (!chatId || chatId === 'status@broadcast') return;

    // Ignore broadcasts and newsletter messages.
    if (chatId.endsWith('@newsletter')) return;

    const messageId = message.key.id;

    if (!messageId) return;

    const uniqueId = `${userId}:${messageId}`;

    if (processedMessages.has(uniqueId)) return;

    processedMessages.add(uniqueId);

    // Keep the duplicate-protection cache from growing forever.
    if (processedMessages.size > 5000) {
      const oldest = processedMessages.values().next().value;
      processedMessages.delete(oldest);
    }

    const text = getMessageText(message);

    if (!text.startsWith(PREFIX)) return;

    const parts = text.slice(PREFIX.length).trim().split(/\s+/);
    const command = (parts.shift() || '').toLowerCase();
    const args = parts;
    const sender = getSenderName(message);

    if (!command) return;

    switch (command) {
      case 'menu':
      case 'help': {
        const menu = `
╭━━━〔 SCANTY MD BOT 〕━━━╮
┃
┃ Hello, ${sender}!
┃ Your multifunctional WhatsApp bot.
┃
┣━━ GENERAL ━━
┃ .menu
┃ .help
┃ .ping
┃ .owner
┃
┣━━ AI & TEXT ━━
┃ .ai <question>
┃ .translate <language> <text>
┃ .tts <text>
┃
┣━━ GROUP MANAGEMENT ━━
┃ .antilink on/off
┃ .welcome on/off
┃ .goodbye on/off
┃ .kick @user
┃ .promote @user
┃ .demote @user
┃
┣━━ MEDIA ━━
┃ .sticker
┃ .toimg
┃ .tomp3
┃
┣━━ AUTOMATION ━━
┃ .autoreact on/off
┃ .schedule <time> <message>
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯

More commands will be activated as their modules are installed.
        `.trim();

        await sock.sendMessage(chatId, { text: menu }, {
          quoted: message
        });
        break;
      }

      case 'ping': {
        await sock.sendMessage(chatId, {
          text: '🏓 SCANTY MD BOT is online!'
        }, { quoted: message });
        break;
      }

      case 'owner': {
        await sock.sendMessage(chatId, {
          text: 'SCANTY MD BOT owner information will be configured in the next step.'
        }, { quoted: message });
        break;
      }

      default: {
        await sock.sendMessage(chatId, {
          text: `Unknown command: ${PREFIX}${command}\nSend .menu to see available commands.`
        }, { quoted: message });
      }
    }
  } catch (error) {
    console.error('Message handler error:', error.message);
  }
}
