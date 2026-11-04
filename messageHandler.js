
import {
  getFeatureSettings,
  setFeatureSetting
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

function getMentionedJids(message) {
  const content =
    message.message?.ephemeralMessage?.message ||
    message.message?.viewOnceMessage?.message ||
    message.message?.viewOnceMessageV2?.message ||
    message.message;

  return content?.extendedTextMessage?.contextInfo?.mentionedJid || [];
}

function normalizeJid(jid) {
  if (!jid) return '';

  const [user, server] = jid.split('@');
  return `${user.split(':')[0]}@${server || ''}`;
}

function getParticipantJid(jid) {
  return jid?.split(':')[0];
}

function isPrivateChat(chatId) {
  return (
    chatId?.endsWith('@s.whatsapp.net') ||
    chatId?.endsWith('@lid')
  );
}

async function isGroupAdmin(sock, chatId, senderJid) {
  const metadata = await sock.groupMetadata(chatId);

  const participant = metadata.participants.find(
    p =>
      getParticipantJid(p.id) ===
      getParticipantJid(senderJid)
  );

  return (
    participant?.admin === 'admin' ||
    participant?.admin === 'superadmin'
  );
}

function getHistoryKey(userId, chatId) {
  return `${userId}:${chatId}`;
}

async function sendAIReply(sock, chatId, userId, text, personality, message) {
  const key = getHistoryKey(userId, chatId);
  const history = aiHistory.get(key) || [];

  const now = Date.now();
  const last = lastAIReply.get(key) || 0;

  if (now - last < AI_COOLDOWN_MS) {
    return;
  }

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
      text: `⚠️ AI error: ${error.message}`
    });
  }
}

export async function handleIncomingMessage(sock, userId, message) {
  try {
    if (!message?.key) return;

    const chatId = message.key.remoteJid;

    if (!chatId || chatId === 'status@broadcast') return;
    if (chatId.endsWith('@newsletter')) return;

    const isOwnerSelfChat =
      message.key.fromMe === true &&
      !chatId.endsWith('@g.us') &&
      normalizeJid(chatId) === normalizeJid(sock.user?.id);

    if (message.key.fromMe && !isOwnerSelfChat) return;

    const text = getMessageText(message);
    if (!text) return;

    const settings = await getFeatureSettings(userId);
    const prefix = settings.prefix || '.';

    const reply = async response => {
      await sock.sendMessage(
        chatId,
        { text: response },
        { quoted: message }
      );
    };

    // Handle commands using the saved prefix.
    if (text.startsWith(prefix)) {
      const parts = text.slice(prefix.length).trim().split(/\s+/);
      const command = (parts.shift() || '').toLowerCase();
      const args = parts;

      const senderJid =
        message.key.participant || message.key.remoteJid;

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

GROUP SETTINGS
${prefix}antilink on/off
${prefix}welcome on/off
${prefix}goodbye on/off
${prefix}unban @user

AI CHAT
${prefix}aichat on/off
${prefix}ai <question>
${prefix}aipersonality friendly
${prefix}aipersonality professional
${prefix}aipersonality funny
${prefix}aipersonality casual
${prefix}aiclear

╰━━━━━━━━━━━━━━━━━━━━╯

SCANTY MD BOT
          `.trim());

        case 'ping':
          return reply('🏓 SCANTY MD BOT is online!');

        case 'status':
          return reply(
            `✅ SCANTY MD BOT is connected.\nAccount: ${sock.user?.id || 'unknown'}\nCommand prefix: ${prefix}`
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

          return reply(
            `🤖 Automatic private AI chat is now ${value.toUpperCase()}.`
          );
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
            return reply(
              `Choose one: ${allowed.join(', ')}`
            );
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

        case 'unban': {
          if (!chatId.endsWith('@g.us')) {
            return reply('This command only works in groups.');
          }

          const target = getMentionedJids(message)[0];

          if (!target) {
            return reply(`Mention the person you want to add back.\nExample: ${prefix}unban @user`);
          }

          const senderIsAdmin = await isGroupAdmin(
            sock,
            chatId,
            senderJid
          );

          if (!senderIsAdmin) {
            return reply('Only group admins can use this command.');
          }

          const metadata = await sock.groupMetadata(chatId);
          const botJid = getParticipantJid(sock.user.id);

          const botParticipant = metadata.participants.find(
            p => getParticipantJid(p.id) === botJid
          );

          if (
            botParticipant?.admin !== 'admin' &&
            botParticipant?.admin !== 'superadmin'
          ) {
            return reply('The bot must be a group admin to add participants.');
          }

          await sock.groupParticipantsUpdate(
            chatId,
            [target],
            'add'
          );

          return reply(
            '✅ Add-member request sent. WhatsApp privacy settings may require an invitation instead.'
          );
        }

        default:
          return reply(
            `Unknown command: ${prefix}${command}\nSend ${prefix}menu to see commands.`
          );
      }
    }

    // Automatic AI replies: private chats only, never groups or self-messages.
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
        {
          text: '❌ Something went wrong while processing that message.'
        }
      );
    } catch {
      // Ignore reply failures.
    }
  }
}
