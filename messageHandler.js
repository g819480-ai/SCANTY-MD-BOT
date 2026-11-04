
import {
  getFeatureSettings,
  setFeatureSetting,
  banBotUser,
  unbanBotUser,
  isBotUserBanned,
  listBotBans
} from './featureSettings.js';

import { generateAIReply } from './aiChat.js';

const aiHistory = new Map();
const MAX_HISTORY = 10;
const AI_COOLDOWN_MS = 5000;
const lastAIReply = new Map();

function getMessageText(message) {
  let content = message.message;
  if (!content) return '';

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
    ''
  ).trim();
}

function normalizeJid(jid) {
  if (!jid) return '';

  const [user, server] = jid.split('@');
  return `${user.split(':')[0]}@${server || ''}`;
}

function isPrivateChat(chatId) {
  return (
    chatId?.endsWith('@s.whatsapp.net') ||
    chatId?.endsWith('@lid')
  );
}

function getHistoryKey(userId, chatId) {
  return `${userId}:${chatId}`;
}

async function sendAIReply(
  sock,
  chatId,
  userId,
  text,
  personality,
  message
) {
  const key = getHistoryKey(userId, chatId);
  const history = aiHistory.get(key) || [];

  const now = Date.now();
  const last = lastAIReply.get(key) || 0;

  if (now - last < AI_COOLDOWN_MS) return;

  lastAIReply.set(key, now);

  try {
    const answer = await generateAIReply({
      message: text,
      personality,
      history
    });

    history.push(
      { role: 'user', content: text },
      { role: 'assistant', content: answer }
    );

    aiHistory.set(key, history.slice(-MAX_HISTORY));

    await sock.sendMessage(
      chatId,
      { text: answer },
      message ? { quoted: message } : {}
    );
  } catch (error) {
    console.error('AI reply error:', error.message);

    await sock.sendMessage(chatId, {
      text: '⚠️ AI is temporarily unavailable. Please try again later.'
    });
  }
}

export async function handleIncomingMessage(sock, userId, message) {
  try {
    if (!message?.key) return;

    const chatId = message.key.remoteJid;

    if (!chatId || chatId === 'status@broadcast') return;
    if (chatId.endsWith('@newsletter')) return;

    // Recognize the owner's WhatsApp account using its JID or LID.
    const ownerJids = [
      sock.user?.id,
      sock.user?.lid
    ]
      .map(normalizeJid)
      .filter(Boolean);

    const chatJids = [
      chatId,
      message.key.remoteJidAlt
    ]
      .map(normalizeJid)
      .filter(Boolean);

    const isOwnerSelfChat =
      message.key.fromMe === true &&
      isPrivateChat(chatId) &&
      chatJids.some(jid => ownerJids.includes(jid));

    // Ignore messages sent by the bot to other chats.
    if (message.key.fromMe && !isOwnerSelfChat) return;

    const text = getMessageText(message);
    if (!text) return;

    const settings = await getFeatureSettings(userId);
    const prefix = settings.prefix || '.';

    const senderJid =
      message.key.participant || chatId;

    const reply = async response => {
      await sock.sendMessage(
        chatId,
        { text: response },
        { quoted: message }
      );
    };

    // Block banned users, but never block the recognized owner.
    if (!isOwnerSelfChat && !message.key.fromMe) {
      const banned = await isBotUserBanned(userId, senderJid);
      if (banned) return;
    }

    if (text.startsWith(prefix)) {
      const parts = text.slice(prefix.length).trim().split(/\s+/);
      const command = (parts.shift() || '').toLowerCase();
      const args = parts;

      switch (command) {
        case 'menu':
        case 'help':
          return reply(`
╭━━〔 SCANTY MD BOT 〕━━╮

GENERAL
${prefix}menu
${prefix}ping
${prefix}status
${prefix}settings
${prefix}setprefix !

STATUS
${prefix}alwaysonline on/off
${prefix}autoviewstatus on/off
${prefix}statusreact on/off
${prefix}setemojis ❤️,🔥,😍

AI CHAT
${prefix}aichat on/off
${prefix}ai <question>
${prefix}aipersonality friendly
${prefix}aipersonality professional
${prefix}aipersonality funny
${prefix}aipersonality casual
${prefix}aiclear

OWNER ONLY
${prefix}ban 233XXXXXXXXX
${prefix}unban 233XXXXXXXXX
${prefix}banlist

╰━━━━━━━━━━━━━━━━━━━━╯
SCANTY MD BOT
          `.trim());

        case 'ping':
          return reply('🏓 SCANTY MD BOT is online!');

        case 'status':
          return reply(
            `✅ SCANTY MD BOT is connected.\nAccount: ${sock.user?.id || 'unknown'}\nPrefix: ${prefix}`
          );

        case 'settings':
          return reply(`
SCANTY MD BOT SETTINGS

Always Online: ${settings.alwaysOnline ? 'ON' : 'OFF'}
Auto View Status: ${settings.autoViewStatus ? 'ON' : 'OFF'}
Status Reactions: ${settings.statusReact ? 'ON' : 'OFF'}
Anti-link: ${settings.antiLink ? 'ON' : 'OFF'}
Welcome: ${settings.welcome ? 'ON' : 'OFF'}
Goodbye: ${settings.goodbye ? 'ON' : 'OFF'}
Auto React: ${settings.autoReact ? 'ON' : 'OFF'}

AI Auto Chat: ${settings.aiChatEnabled ? 'ON' : 'OFF'}
AI Personality: ${settings.aiPersonality}
Command Prefix: ${prefix}

Status emojis: ${(settings.statusEmojis || []).join(' ')}
          `.trim());

        case 'setprefix': {
          const newPrefix = args[0];

          if (!newPrefix) {
            return reply(`Current prefix: ${prefix}\nExample: ${prefix}setprefix !`);
          }

          try {
            await setFeatureSetting(userId, 'prefix', newPrefix);
            return reply(`✅ Command prefix changed to: ${newPrefix}`);
          } catch (error) {
            return reply(error.message);
          }
        }

        case 'aichat': {
          const value = args[0]?.toLowerCase();

          if (!['on', 'off'].includes(value)) {
            return reply(`Usage: ${prefix}aichat on/off`);
          }

          await setFeatureSetting(
            userId,
            'aiChatEnabled',
            value === 'on'
          );

          return reply(`🤖 Automatic private AI chat is now ${value.toUpperCase()}.`);
        }

        case 'ai': {
          if (!isPrivateChat(chatId)) {
            return reply('🤖 AI questions are available in private chats only.');
          }

          const question = args.join(' ').trim();

          if (!question) {
            return reply(`Example: ${prefix}ai Explain artificial intelligence.`);
          }

          await sendAIReply(
            sock,
            chatId,
            userId,
            question,
            settings.aiPersonality,
            message
          );

          return;
        }

        case 'aipersonality': {
          const personality = args[0]?.toLowerCase();

          const allowed = [
            'friendly',
            'professional',
            'funny',
            'casual'
          ];

          if (!allowed.includes(personality)) {
            return reply(`Choose one: ${allowed.join(', ')}`);
          }

          await setFeatureSetting(
            userId,
            'aiPersonality',
            personality
          );

          return reply(`✅ AI personality changed to ${personality}.`);
        }

        case 'aiclear': {
          if (!isPrivateChat(chatId)) {
            return reply('This command works in private chats only.');
          }

          aiHistory.delete(getHistoryKey(userId, chatId));

          return reply('🧹 Your AI conversation memory has been cleared.');
        }

        case 'ban': {
          if (!isOwnerSelfChat) {
            return reply('⛔ Only the bot owner can use this command from the bot self-chat.');
          }

          const phone = args[0];

          if (!phone) {
            return reply(`Usage: ${prefix}ban 233XXXXXXXXX`);
          }

          try {
            const added = await banBotUser(userId, phone);
            return reply(
              added
                ? `🚫 ${phone} is now banned from using this bot.`
                : `${phone} is already banned.`
            );
          } catch (error) {
            return reply(`❌ ${error.message}`);
          }
        }

        case 'unban': {
          if (!isOwnerSelfChat) {
            return reply('⛔ Only the bot owner can use this command from the bot self-chat.');
          }

          const phone = args[0];

          if (!phone) {
            return reply(`Usage: ${prefix}unban 233XXXXXXXXX`);
          }

          try {
            const removed = await unbanBotUser(userId, phone);
            return reply(
              removed
                ? `✅ ${phone} can use the bot again.`
                : `${phone} was not on the ban list.`
            );
          } catch (error) {
            return reply(`❌ ${error.message}`);
          }
        }

        case 'banlist': {
          if (!isOwnerSelfChat) {
            return reply('⛔ Only the bot owner can use this command from the bot self-chat.');
          }

          const bans = await listBotBans(userId);

          if (!bans.length) {
            return reply('✅ No users are currently banned.');
          }

          const list = bans
            .map((item, index) => `${index + 1}. ${item.phone_number}`)
            .join('\n');

          return reply(`🚫 BANNED USERS\n\n${list}`);
        }

        case 'alwaysonline':
        case 'autoviewstatus':
        case 'statusreact':
        case 'antilink':
        case 'welcome':
        case 'goodbye':
        case 'autoreact': {
          const value = args[0]?.toLowerCase();

          if (!['on', 'off'].includes(value)) {
            return reply(`Usage: ${prefix}${command} on/off`);
          }

          const settingNames = {
            alwaysonline: 'alwaysOnline',
            autoviewstatus: 'autoViewStatus',
            statusreact: 'statusReact',
            antilink: 'antiLink',
            welcome: 'welcome',
            goodbye: 'goodbye',
            autoreact: 'autoReact'
          };

          await setFeatureSetting(
            userId,
            settingNames[command],
            value === 'on'
          );

          return reply(
            `✅ ${command} has been turned ${value.toUpperCase()}.`
          );
        }

        case 'setemojis': {
          const emojis = args.join('').split(',').filter(Boolean);

          if (!emojis.length || emojis.length > 10) {
            return reply(
              `Example: ${prefix}setemojis ❤️,🔥,😍,😂\nUse between 1 and 10 emojis.`
            );
          }

          await setFeatureSetting(userId, 'statusEmojis', emojis);

          return reply(`✅ Status emojis saved: ${emojis.join(' ')}`);
        }

        default:
          return reply(
            `Unknown command: ${prefix}${command}\nSend ${prefix}menu to see commands.`
          );
      }
    }

    // Automatic AI replies are limited to private chats.
    // Do not let the bot reply to its own messages.
    if (
      settings.aiChatEnabled &&
      isPrivateChat(chatId) &&
      !message.key.fromMe
    ) {
      await sendAIReply(
        sock,
        chatId,
        userId,
        text,
        settings.aiPersonality,
        message
      );
    }
  } catch (error) {
    console.error('Message handler error:', error.message);

    try {
      await sock.sendMessage(
        message.key.remoteJid,
        { text: '❌ Something went wrong while processing that message.' }
      );
    } catch {
      // Ignore reply failures.
    }
  }
}
