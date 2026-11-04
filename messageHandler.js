import {
  getFeatureSettings,
  setFeatureSetting,
  isBotUserBanned,
  unbanBotUser
} from './featureSettings.js';

const DEFAULT_PREFIX = '.';
const COMMAND_COOLDOWN_MS = 3000;
const lastCommands = new Map();
const MAX_RATE_LIMIT_ENTRIES = 5000;

function normalizeJid(jid) {
  if (typeof jid !== 'string') return '';
  const [user, server] = jid.split('@');
  return user && server ? `${user.split(':')[0]}@${server}` : '';
}

function getMessageText(message) {
  let content = message?.message;
  for (let i = 0; content && i < 6; i += 1) {
    const wrapped = content.ephemeralMessage?.message ||
      content.viewOnceMessage?.message || content.viewOnceMessageV2?.message ||
      content.viewOnceMessageV2Extension?.message || content.documentWithCaptionMessage?.message;
    if (!wrapped) break;
    content = wrapped;
  }
  return String(content?.conversation || content?.extendedTextMessage?.text ||
    content?.imageMessage?.caption || content?.videoMessage?.caption ||
    content?.documentMessage?.caption || '').trim();
}

function isOwnerSelfChat(sock, message, chatId) {
  if (!message.key?.fromMe || !chatId || chatId.endsWith('@g.us') ||
      chatId.endsWith('@newsletter') || chatId === 'status@broadcast') return false;
  return [sock.user?.id, sock.user?.lid].map(normalizeJid).filter(Boolean).includes(normalizeJid(chatId));
}

function isRateLimited(key) {
  const now = Date.now();
  const previous = lastCommands.get(key);
  if (previous && now - previous < COMMAND_COOLDOWN_MS) return true;
  lastCommands.set(key, now);
  if (lastCommands.size > MAX_RATE_LIMIT_ENTRIES) {
    for (const [entry, timestamp] of lastCommands) {
      if (now - timestamp > COMMAND_COOLDOWN_MS) lastCommands.delete(entry);
      if (lastCommands.size <= MAX_RATE_LIMIT_ENTRIES) break;
    }
  }
  return false;
}

function phoneFromJid(jid) {
  const id = normalizeJid(jid).split('@')[0];
  return /^\d{7,15}$/.test(id) ? id : '';
}

function parseEmojis(input) {
  const values = input.split(',').map(value => value.trim()).filter(Boolean);
  if (values.length < 1 || values.length > 10 || values.some(value => value.length > 16)) return null;
  return [...new Set(values)];
}

const toggleSettings = Object.freeze({
  alwaysonline: 'alwaysOnline',
  autoviewstatus: 'autoViewStatus',
  statusreact: 'statusReact',
  antilink: 'antiLink',
  welcome: 'welcome',
  goodbye: 'goodbye',
  autoreact: 'autoReact'
});

function menuText() {
  return [
    '╭━━〔 SCANTY MD BOT 〕━━╮',
    '┃ .menu / .help',
    '┃ .ping',
    '┃ .status',
    '┃ .settings',
    '┃ .alwaysonline on/off',
    '┃ .autoviewstatus on/off',
    '┃ .statusreact on/off',
    '┃ .antilink on/off',
    '┃ .welcome on/off',
    '┃ .goodbye on/off',
    '┃ .autoreact on/off',
    '┃ .setemojis ❤️,🔥,😍',
    '┃ .unban <phone number> (owner self-chat only)',
    '╰━━━━━━━━━━━━━━━━━━╯'
  ].join('\n');
}

export async function handleIncomingMessage(sock, userId, message) {
  if (!message?.key) return;
  const chatId = message.key.remoteJid;
  if (!chatId || chatId === 'status@broadcast' || chatId.endsWith('@newsletter')) return;
  const selfChat = isOwnerSelfChat(sock, message, chatId);
  if (message.key.fromMe && !selfChat) return;

  const text = getMessageText(message);
  if (!text) return;
  const senderJid = selfChat ? normalizeJid(sock.user?.id || sock.user?.lid) :
    (message.key.participant || chatId);
  const senderPhone = phoneFromJid(senderJid);

  // A bot-level ban applies to messages from that number, but never blocks the owner.
  if (!selfChat && senderPhone && await isBotUserBanned(userId, senderPhone)) return;

  const settings = await getFeatureSettings(userId);
  const prefix = settings.prefix || DEFAULT_PREFIX;
  if (!text.startsWith(prefix)) return;
  const parts = text.slice(prefix.length).trim().split(/\s+/).filter(Boolean);
  const command = (parts.shift() || '').toLowerCase();
  const args = parts;
  if (!command) return;
  if (isRateLimited(`${userId}:${senderJid}`)) return;

  const reply = response => sock.sendMessage(chatId, { text: response }, { quoted: message });
  const ownerOnly = async () => {
    if (selfChat) return true;
    await reply('Only the bot owner can change these settings. Send the command from the bot account’s own chat.');
    return false;
  };

  try {
    switch (command) {
      case 'menu':
      case 'help': return reply(menuText());
      case 'ping': return reply('🏓 SCANTY MD BOT is responding.');
      case 'status': {
        const open = sock.ws?.readyState === (sock.ws?.OPEN ?? 1) && Boolean(sock.user);
        return reply(`${open ? '✅ Connected' : '⚠️ Not connected'}\nAccount: ${sock.user?.id || 'unknown'}\nPrefix: ${prefix}`);
      }
      case 'settings':
        return reply([
          'SCANTY MD BOT SETTINGS',
          `Always Online: ${settings.alwaysOnline ? 'ON' : 'OFF'}`,
          `Auto View Status: ${settings.autoViewStatus ? 'ON' : 'OFF'}`,
          `Status Reactions: ${settings.statusReact ? 'ON' : 'OFF'}`,
          `Anti-link: ${settings.antiLink ? 'ON' : 'OFF'}`,
          `Welcome: ${settings.welcome ? 'ON' : 'OFF'}`,
          `Goodbye: ${settings.goodbye ? 'ON' : 'OFF'}`,
          `Auto React: ${settings.autoReact ? 'ON' : 'OFF'}`,
          `Status emojis: ${(settings.statusEmojis || []).join(' ')}`,
          `Prefix: ${prefix}`
        ].join('\n'));
      case 'setemojis': {
        if (!(await ownerOnly())) return;
        const emojis = parseEmojis(args.join(''));
        if (!emojis) return reply('Usage: .setemojis ❤️,🔥,😍,😂 (1–10 emoji values)');
        await setFeatureSetting(userId, 'statusEmojis', emojis);
        return reply(`✅ Status emojis saved: ${emojis.join(' ')}`);
      }
      case 'unban': {
        if (!(await ownerOnly())) return;
        const mention = message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        const target = args[0] || phoneFromJid(mention);
        if (!target) return reply('Usage: .unban <phone number>\nThis removes a bot-access ban; it does not add anyone to a WhatsApp group.');
        const removed = await unbanBotUser(userId, target);
        return reply(removed ? '✅ Number unbanned from this bot.' : 'That number was not on this bot’s ban list.');
      }
      default:
        if (Object.hasOwn(toggleSettings, command)) {
          if (!(await ownerOnly())) return;
          const value = args[0]?.toLowerCase();
          if (!['on', 'off'].includes(value)) return reply(`Usage: ${prefix}${command} on/off`);
          await setFeatureSetting(userId, toggleSettings[command], value === 'on');
          return reply(`✅ ${command} turned ${value.toUpperCase()}.`);
        }
        return reply(`Unknown command: ${prefix}${command}\nSend ${prefix}menu to see supported commands.`);
    }
  } catch (error) {
    console.error('Message handler error:', error.message);
    try { await reply('❌ Could not complete that command. Check the bot service logs.'); } catch { /* socket may have closed */ }
  }
}

export const messageHandlerInternals = Object.freeze({ getMessageText, isOwnerSelfChat, parseEmojis, menuText });
