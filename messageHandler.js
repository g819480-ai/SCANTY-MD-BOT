import {
  getFeatureSettings,
  setFeatureSetting
} from './featureSettings.js';

const PREFIX = '.';

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
  const context =
    message.message?.extendedTextMessage?.contextInfo;

  return context?.mentionedJid || [];
}

function getParticipantJid(jid) {
  return jid?.split(':')[0];
}

async function isGroupAdmin(sock, chatId, senderJid) {
  const metadata = await sock.groupMetadata(chatId);
  const participant = metadata.participants.find(
    p => getParticipantJid(p.id) === getParticipantJid(senderJid)
  );

  return participant?.admin === 'admin' ||
    participant?.admin === 'superadmin';
}

export async function handleIncomingMessage(sock, userId, message) {
  try {
    if (!message?.key || message.key.fromMe) return;

    const chatId = message.key.remoteJid;

    if (!chatId || chatId === 'status@broadcast') return;
    if (chatId.endsWith('@newsletter')) return;

    const text = getMessageText(message);
    if (!text.startsWith(PREFIX)) return;

    const parts = text.slice(PREFIX.length).trim().split(/\s+/);
    const command = (parts.shift() || '').toLowerCase();
    const args = parts;

    const senderJid =
      message.key.participant || message.key.remoteJid;

    const settings = await getFeatureSettings(userId);

    const reply = async text => {
      await sock.sendMessage(chatId, { text }, {
        quoted: message
      });
    };

    switch (command) {
      case 'menu':
      case 'help':
        return reply(`
╭━━〔 SCANTY MD BOT 〕━━╮
┃
┣━━ GENERAL ━━
┃ .menu
┃ .ping
┃ .settings
┃
┣━━ STATUS ━━
┃ .alwaysonline on/off
┃ .autoviewstatus on/off
┃ .statusreact on/off
┃ .setemojis ❤️,🔥,😍
┃
┣━━ GROUP MANAGEMENT ━━
┃ .antilink on/off
┃ .welcome on/off
┃ .goodbye on/off
┃ .kick @user
┃ .promote @user
┃ .demote @user
┃ .unban @user
┃
┣━━ AI & MEDIA ━━
┃ .ai <question>
┃ .translate <language> <text>
┃ .sticker
┃ .toimg
┃ .tomp3
┃ .tts <text>
┃
╰━━━━━━━━━━━━━━━━━━╯

SCANTY MD BOT
        `.trim());

      case 'ping':
        return reply('🏓 SCANTY MD BOT is online!');

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

Status emojis: ${settings.statusEmojis.join(' ')}
        `.trim());

      case 'alwaysonline':
      case 'autoviewstatus':
      case 'statusreact':
      case 'antilink':
      case 'welcome':
      case 'goodbye':
      case 'autoreact': {
        const value = args[0]?.toLowerCase();

        if (!['on', 'off'].includes(value)) {
          return reply(`Usage: .${command} on/off`);
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
            'Example: .setemojis ❤️,🔥,😍,😂\nUse between 1 and 10 emojis.'
          );
        }

        await setFeatureSetting(userId, 'statusEmojis', emojis);

        return reply(`✅ Status emojis saved: ${emojis.join(' ')}`);
      }

      case 'unban': {
        if (!chatId.endsWith('@g.us')) {
          return reply('This command only works in groups.');
        }

        const mentioned = getMentionedJids(message);
        const target = mentioned[0];

        if (!target) {
          return reply('Mention the person you want to add back.\nExample: .unban @user');
        }

        const senderIsAdmin = await isGroupAdmin(
          sock, chatId, senderJid
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
          `Unknown command: .${command}\nSend .menu to see commands.`
        );
    }
  } catch (error) {
    console.error('Message handler error:', error.message);

    try {
      await sock.sendMessage(
        message.key.remoteJid,
        { text: '❌ Something went wrong while processing that command.' }
      );
    } catch {
      // Ignore reply failures.
    }
  }
}
