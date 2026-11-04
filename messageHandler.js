import {
  getFeatureSettings,
  setFeatureSetting,
  isBotUserBanned,
  banBotUser,
  listBotBans,
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

function formatUptime(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return [days ? `${days}d` : null, hours ? `${hours}h` : null,
    minutes ? `${minutes}m` : null, `${remainingSeconds}s`].filter(Boolean).join(' ');
}

function getGroupAdmins(metadata) {
  return (metadata?.participants || [])
    .filter(participant => participant.admin === 'admin' || participant.admin === 'superadmin')
    .map(participant => participant.id);
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
    '┃ .uptime',
    '┃ .jid',
    '┃ .groupinfo (groups)',
    '┃ .admins (groups)',
    '┃ .settings',
    '┃ .alwaysonline on/off',
    '┃ .autoviewstatus on/off',
    '┃ .statusreact on/off',
    '┃ .antilink on/off',
    '┃ .welcome on/off',
    '┃ .goodbye on/off',
    '┃ .autoreact on/off',
    '┃ .setemojis ❤️,🔥,😍',
    '┃ .ban <phone number> (owner self-chat only)',
    '┃ .bans / .unban <phone number> (owner self-chat only)',
    '┃ Note: unban removes a bot-access ban; it does not add anyone to a WhatsApp group.',
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
  if (!selfChat && senderPhone && await isBotUserBanned(userId, senderPhone)) return;

  const settings = await getFeatureSettings(userId);
  const prefix = settings.prefix || DEFAULT_PREFIX;
  if (!text.startsWith(prefix)) return;
  const parts = text.slice(prefix.length).trim().split(/\s+/).filter(Boolean);
  const command = (parts.shift() || '').toLowerCase();
  const args = parts;
  if (!command || isRateLimited(`${userId}:${senderJid}`)) return;

  const reply = response => sock.sendMessage(chatId, { text: response }, { quoted: message });
  const ownerOnly = async () => {
    if (selfChat) return true;
    await reply('Only the bot owner can manage bot settings and access bans. Send the command from the bot account’s own chat.');
    return false;
  };

  try {
    switch (command) {
      case 'menu':
      case 'help': return reply(menuText());
      case 'ping': return reply('🏓 SCANTY MD BOT is responding.');
      case 'uptime': return reply(`⏱️ Bot uptime: ${formatUptime(process.uptime())}`);
      case 'jid':
        return reply(`Chat: ${chatId}\nSender: ${senderJid}${message.key.participant ? `\nParticipant: ${message.key.participant}` : ''}`);
      case 'groupinfo': {
        if (!chatId.endsWith('@g.us')) return reply('This command only works in a group.');
        const metadata = await sock.groupMetadata(chatId);
        const admins = getGroupAdmins(metadata);
        return reply([
          `Group: ${metadata.subject || '(unnamed)'}`,
          `ID: ${metadata.id || chatId}`,
          `Members: ${metadata.participants?.length || 0}`,
          `Admins: ${admins.length}`,
          metadata.desc ? `Description: ${metadata.desc}` : null
        ].filter(Boolean).join('\n'));
      }
      case 'admins': {
        if (!chatId.endsWith('@g.us')) return reply('This command only works in a group.');
        const metadata = await sock.groupMetadata(chatId);
        const admins = getGroupAdmins(metadata);
        if (!admins.length) return reply('No group admins were returned.');
        return reply(`Group admins (${admins.length}):\n${admins.map(jid => `• ${jid}`).join('\n')}`);
      }
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
      case 'ban': {
        if (!(await ownerOnly())) return;
        const target = args[0];
        if (!target) return reply('Usage: .ban <phone number> (include country code)');
        const added = await banBotUser(userId, target);
        return reply(added ? '✅ Number banned from using this bot.' : 'That number is already banned from this bot.');
      }
      case 'bans': {
        if (!(await ownerOnly())) return;
        const bans = await listBotBans(userId);
        if (!bans.length) return reply('There are no numbers banned from this bot.');
        return reply(`Bot access bans (${bans.length}):\n${bans.map(ban => `• ${ban.phoneNumber}`).join('\n')}`);
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
    try { await reply(`❌ ${error.message || 'Could not complete that command.'}`); } catch { /* socket may have closed */ }
  }
}

export const messageHandlerInternals = Object.freeze({
  getMessageText,
  isOwnerSelfChat,
  parseEmojis,
  formatUptime,
  getGroupAdmins,
  menuText
});
