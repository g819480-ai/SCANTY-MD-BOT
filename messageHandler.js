import {
  styleMessage,
  successMessage,
  errorMessage,
  warningMessage,
  infoMessage,
  menuMessage
} from './messageStyle.js';

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
const AI_COOLDOWN_MS = 4000;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || 'gemini-3.8-flash';

const GEMINI_FALLBACK_MODELS = (
  process.env.GEMINI_FALLBACK_MODELS ||
  'gemini-3.5-flash-lite,gemini-3.1-flash-lite'
)
  .split(',')
  .map(model => model.trim())
  .filter(Boolean);

const GEMINI_TEMPORARY_ERRORS = new Set([
  429, 500, 502, 503, 504
]);

const lastCommands = new Map();
const lastAIReplies = new Map();
const MAX_RATE_LIMIT_ENTRIES = 5000;

function normalizeJid(jid) {
  if (typeof jid !== 'string') return '';

  const [user, server] = jid.split('@');

  return user && server
    ? `${user.split(':')[0]}@${server}`
    : '';
}

function getMessageText(message) {
  let content = message?.message;

  for (let i = 0; content && i < 6; i += 1) {
    const wrapped =
      content.ephemeralMessage?.message ||
      content.viewOnceMessage?.message ||
      content.viewOnceMessageV2?.message ||
      content.viewOnceMessageV2Extension?.message ||
      content.documentWithCaptionMessage?.message;

    if (!wrapped) break;

    content = wrapped;
  }

  return String(
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    content?.imageMessage?.caption ||
    content?.videoMessage?.caption ||
    content?.documentMessage?.caption ||
    ''
  ).trim();
}

function isOwnerSelfChat(sock, message, chatId) {
  if (
    !message.key?.fromMe ||
    !chatId ||
    chatId.endsWith('@g.us') ||
    chatId.endsWith('@newsletter') ||
    chatId === 'status@broadcast'
  ) {
    return false;
  }

  return [sock.user?.id, sock.user?.lid]
    .map(normalizeJid)
    .filter(Boolean)
    .includes(normalizeJid(chatId));
}

function cleanRateLimitMap(map) {
  if (map.size <= MAX_RATE_LIMIT_ENTRIES) return;

  for (const [entry, timestamp] of map) {
    if (Date.now() - timestamp > 60000) {
      map.delete(entry);
    }

    if (map.size <= MAX_RATE_LIMIT_ENTRIES) break;
  }
}

function isRateLimited(key) {
  const now = Date.now();
  const previous = lastCommands.get(key);

  if (previous && now - previous < COMMAND_COOLDOWN_MS) {
    return true;
  }

  lastCommands.set(key, now);
  cleanRateLimitMap(lastCommands);

  return false;
}

function isAIRateLimited(key) {
  const now = Date.now();
  const previous = lastAIReplies.get(key);

  if (previous && now - previous < AI_COOLDOWN_MS) {
    return true;
  }

  lastAIReplies.set(key, now);
  cleanRateLimitMap(lastAIReplies);

  return false;
}

function phoneFromJid(jid) {
  const id = normalizeJid(jid).split('@')[0];

  return /^\d{7,15}$/.test(id) ? id : '';
}

function parseEmojis(input) {
  const values = input
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  if (
    values.length < 1 ||
    values.length > 10 ||
    values.some(value => value.length > 16)
  ) {
    return null;
  }

  return [...new Set(values)];
}

function formatUptime(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  return [
    days ? `${days}d` : null,
    hours ? `${hours}h` : null,
    minutes ? `${minutes}m` : null,
    `${remainingSeconds}s`
  ].filter(Boolean).join(' ');
}

function getGroupAdmins(metadata) {
  return (metadata?.participants || [])
    .filter(
      participant =>
        participant.admin === 'admin' ||
        participant.admin === 'superadmin'
    )
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
    '╭━━━〔 🔴 SCANTY MD BOT 〕━━━╮',
    '┃',
    '┃  ⚡ SYSTEM STATUS: ONLINE',
    '┃  🤖 WHATSAPP AUTOMATION',
    '┃  📌 PREFIX: .',
    '┃',
    '┣━━━〔 📡 GENERAL COMMANDS 〕━━━',
    '┃',
    '┃  ▸ .menu / .help',
    '┃  ▸ .ping',
    '┃  ▸ .status',
    '┃  ▸ .uptime',
    '┃  ▸ .jid',
    '┃',
    '┣━━━〔 👥 GROUP COMMANDS 〕━━━',
    '┃',
    '┃  ▸ .groupinfo',
    '┃  ▸ .admins',
    '┃  ▸ .antilink on/off',
    '┃',
    '┣━━━〔 ⚙️ BOT SETTINGS 〕━━━',
    '┃',
    '┃  ▸ .settings',
    '┃  ▸ .ai on/off (Owner)',
    '┃  ▸ .alwaysonline on/off',
    '┃  ▸ .autoviewstatus on/off',
    '┃  ▸ .statusreact on/off',
    '┃  ▸ .welcome on/off',
    '┃  ▸ .goodbye on/off',
    '┃  ▸ .autoreact on/off',
    '┃  ▸ .setemojis ❤️,🔥,😍',
    '┃',
    '┣━━━〔 👑 OWNER COMMANDS 〕━━━',
    '┃',
    '┃  ▸ .ban <phone number>',
    '┃  ▸ .bans',
    '┃  ▸ .unban <phone number>',
    '┃',
    '┣━━━━━━━━━━━━━━━━━━━━',
    '┃  🔐 Owner commands are restricted',
    '┃  📌 Unban removes a bot-access ban',
    '┃',
    '╰━━━━━━━━━━━━━━━━━━━━╯',
    '       🔴 POWERED BY SCANTY'
  ].join('\n');
}


async function generateGeminiReply(userText) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is missing from the environment.'
    );
  }

  const models = [
    ...new Set([
      GEMINI_MODEL,
      ...GEMINI_FALLBACK_MODELS
    ])
  ];

  let lastError;

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];

    try {
      console.log('GEMINI REQUEST:', { model });

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{
                text:
                  'You are SCANTY MD BOT AI assistant. ' +
                  'Answer the user clearly, naturally, helpfully and politely. ' +
                  'Understand the question before answering. ' +
                  'Do not pretend to perform actions you cannot perform. ' +
                  'Keep answers reasonably concise and suitable for WhatsApp.'
              }]
            },
            contents: [{
              role: 'user',
              parts: [{
                text: userText.slice(0, 4000)
              }]
            }],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 700
            }
          }),
          signal: AbortSignal.timeout(25000)
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const error = new Error(
          data?.error?.message ||
          `Gemini API error (${response.status}).`
        );

        error.status = response.status;

        throw error;
      }

      const answer = data?.candidates?.[0]?.content?.parts
        ?.map(part => part.text || '')
        .join('')
        .trim();

      if (!answer) {
        throw new Error('Gemini returned an empty response.');
      }

      console.log('GEMINI RESPONSE SUCCESS:', { model });

      return answer.slice(0, 4000);

    } catch (error) {
      lastError = error;

      const isTemporaryHttpError =
        GEMINI_TEMPORARY_ERRORS.has(error.status);

      const isNetworkOrTimeoutError =
        error.name === 'AbortError' ||
        error.name === 'TimeoutError' ||
        error.name === 'TypeError';

      const shouldFallback =
        index < models.length - 1 &&
        (isTemporaryHttpError || isNetworkOrTimeoutError);

      console.error('Gemini model failed:', {
        model,
        status: error.status || null,
        message: error.message
      });

      if (!shouldFallback) {
        throw error;
      }

      console.warn(
        `Trying the next Gemini model after ${model} failed.`
      );
    }
  }

  throw new Error(
    `All Gemini models are temporarily unavailable. ${
      lastError?.message || ''
    }`
  );
}

export async function handleIncomingMessage(
  sock,
  userId,
  message
) {
  if (!message?.key) return;

  const chatId = message.key.remoteJid;

  if (
    !chatId ||
    chatId === 'status@broadcast' ||
    chatId.endsWith('@newsletter')
  ) {
    return;
  }

  const selfChat = isOwnerSelfChat(
    sock,
    message,
    chatId
  );

  if (message.key.fromMe && !selfChat) return;

  const text = getMessageText(message);

  if (!text) return;

  const senderJid = selfChat
    ? normalizeJid(sock.user?.id || sock.user?.lid)
    : (message.key.participant || chatId);

  const senderPhone = phoneFromJid(senderJid);

  let settings;

  try {
    if (
      !selfChat &&
      senderPhone &&
      await isBotUserBanned(userId, senderPhone)
    ) {
      return;
    }

    settings = await getFeatureSettings(userId);

  } catch (error) {
    console.error('Message handler setup error:', error);

    try {
      await sock.sendMessage(
        chatId,
        {
          text:
            '❌ SCANTY MD BOT could not process this message right now. Please try again later.'
        },
        { quoted: message }
      );
    } catch (sendError) {
      console.error(
        'Could not send setup error reply:',
        sendError
      );
    }

    return;
  }

  const prefix = settings.prefix || DEFAULT_PREFIX;

  const reply = (response, type = 'info') =>
  sock.sendMessage(
    chatId,
    { text: styleMessage(response, type) },
    { quoted: message }
  );

  // Commands are processed before ordinary AI messages.
  if (!text.startsWith(prefix)) {
    if (!settings.aiChatEnabled) return;

    const aiKey = `${userId}:${chatId}`;

    if (isAIRateLimited(aiKey)) return;

    try {
      const answer = await generateGeminiReply(text);

      await reply(answer);

    } catch (error) {
      console.error('Gemini reply error:', error);

      try {
        await reply(
          '⚠️ SCANTY MD BOT AI is temporarily unavailable. Please try again shortly.'
        );
      } catch (sendError) {
        console.error(
          'Could not send Gemini error reply:',
          sendError
        );
      }
    }

    return;
  }

  const parts = text
    .slice(prefix.length)
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const command = (parts.shift() || '').toLowerCase();
  const args = parts;

  if (!command || isRateLimited(`${userId}:${senderJid}`)) {
    return;
  }

  const ownerOnly = async () => {
    if (selfChat) return true;

    await reply(
      'Only the bot owner can manage bot settings and access bans. Send the command from the bot account’s own chat.'
    );

    return false;
  };

  try {
    switch (command) {
      case 'menu':
      case 'help':
        return reply(menuText());

      case 'ai': {
        if (!(await ownerOnly())) return;

        const value = args[0]?.toLowerCase();

        if (!['on', 'off'].includes(value)) {
          return reply(
            'Usage: .ai on\nOr: .ai off'
          );
        }

        await setFeatureSetting(
          userId,
          'aiChatEnabled',
          value === 'on'
        );

        return reply(
          value === 'on'
            ? '🤖 Gemini AI is now ON. Ordinary messages will receive AI replies. Bot commands will continue working.'
            : '✅ Gemini AI is now OFF. Ordinary messages will no longer receive AI replies.'
        );
      }

      case 'ping': {
  const timestamp = Number(message.messageTimestamp);

  const speed = Number.isFinite(timestamp) && timestamp > 0
    ? Math.max(0, Date.now() - (timestamp * 1000))
    : 0;

  return reply(
    '🏓 PONG!\n\n' +
    `⚡ Response Speed: ${speed} ms\n` +
    '🟢 System Status: ACTIVE\n' +
    '🤖 Bot: SCANTY MD BOT\n' +
    '🚀 Connection: ONLINE',
    'success'
  );
}
      case 'uptime': {
  const uptimeSeconds = Math.floor(process.uptime());
  const uptime = formatUptime(uptimeSeconds);

  return reply(
    '⏱️ SERVER UPTIME REPORT\n\n' +
    '🤖 BOT: SCANTY MD BOT\n' +
    `⚡ Running Time: ${uptime}\n` +
    `🔢 Total Seconds: ${uptimeSeconds.toLocaleString()}s\n` +
    '🟢 Server Status: ACTIVE\n\n' +
    '🚀 SCANTY MD BOT is running smoothly.',
    'success'
  );
}
      case 'jid': {
  const isGroup = chatId.endsWith('@g.us');

  return reply(
    '🆔 WHATSAPP IDENTITY REPORT\n\n' +
    '🤖 BOT: SCANTY MD BOT\n\n' +
    `💬 Chat Type: ${isGroup ? 'GROUP' : 'PRIVATE CHAT'}\n` +
    `📌 Chat ID: ${chatId}\n` +
    `👤 Sender ID: ${senderJid}\n` +
    `👥 Participant: ${message.key.participant || 'Not applicable'}\n\n` +
    '🔴 ID INFORMATION GENERATED SUCCESSFULLY.',
    'success'
  );
} 
        case 'groupinfo': {
  if (!chatId.endsWith('@g.us')) {
    return reply(
      'This command only works in a WhatsApp group.',
      'warning'
    );
  }

  try {
    const metadata = await sock.groupMetadata(chatId);
    const admins = getGroupAdmins(metadata);

    const owner = metadata.owner || 'Not available';
    const members = metadata.participants?.length || 0;

    return reply(
      '👥 GROUP INFORMATION REPORT\n\n' +
      `📛 Group Name: ${metadata.subject || 'Unnamed'}\n` +
      `🆔 Group ID: ${metadata.id || chatId}\n` +
      `👑 Group Owner: ${owner}\n` +
      `👥 Total Members: ${members}\n` +
      `🛡️ Total Admins: ${admins.length}\n\n` +
      '📝 GROUP DESCRIPTION\n' +
      `${metadata.desc || 'No description available.'}\n\n` +
      '🔴 SCANTY MD BOT GROUP REPORT',
      'success'
    );
  } catch (error) {
    console.error('Group info error:', error);

    return reply(
      'Unable to retrieve group information. Please try again.',
      'error'
    );
  }
}

    case 'admins': {
  if (!chatId.endsWith('@g.us')) {
    return reply(
      'This command only works in a WhatsApp group.',
      'warning'
    );
  }

  try {
    const metadata = await sock.groupMetadata(chatId);
    const admins = getGroupAdmins(metadata);

    if (!admins.length) {
      return reply(
        'No group administrators were found.',
        'warning'
      );
    }

    const owner = metadata.owner;

    const adminList = admins.map((jid, index) => {
      const isOwner = owner === jid;

      return (
        `${index + 1}. ${isOwner ? '👑 GROUP OWNER' : '🛡️ ADMIN'}\n` +
        `   📱 ${jid}`
      );
    }).join('\n\n');

    return reply(
      '🛡️ GROUP ADMINISTRATION REPORT\n\n' +
      `📛 Group: ${metadata.subject || 'Unnamed'}\n` +
      `👥 Total Admins: ${admins.length}\n\n` +
      '━━━━━━━━━━━━━━━━━━\n' +
      adminList +
      '\n\n━━━━━━━━━━━━━━━━━━\n' +
      '🔴 POWERED BY SCANTY',
      'success'
    );

  } catch (error) {
    console.error('Admins command error:', error);

    return reply(
      'Unable to retrieve the group administrators.',
      'error'
    );
  }
}
     
      case 'status': {
  const open =
    sock.ws?.readyState === (sock.ws?.OPEN ?? 1) &&
    Boolean(sock.user);

  const uptimeSeconds = Math.floor(process.uptime());
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = uptimeSeconds % 60;

  const uptime = `${hours}h ${minutes}m ${seconds}s`;

  const now = new Date().toLocaleString('en-GB', {
    timeZone: 'Africa/Accra',
    dateStyle: 'medium',
    timeStyle: 'medium'
  });

  return reply(
    '📡 SYSTEM STATUS REPORT\n\n' +
    `🤖 Bot: SCANTY MD BOT\n` +
    `🔌 Connection: ${open ? 'CONNECTED' : 'DISCONNECTED'}\n` +
    `👤 Account: ${sock.user?.id || 'Unknown'}\n` +
    `📌 Prefix: ${prefix}\n` +
    `⏱️ Server Uptime: ${uptime}\n` +
    `🕒 Ghana Time: ${now}\n\n` +
    `${open ? '🟢 All systems operational.' : '🟠 WhatsApp connection needs attention.'}`,
    open ? 'success' : 'warning'
  );
}


case 'settings': {
  const indicator = value => value ? '🟢 ON' : '🔴 OFF';

  return reply([
    '⚙️ BOT CONFIGURATION PANEL',
    '',
    '╭━━〔 🔴 SYSTEM SETTINGS 〕━━',
    `┃ Always Online: ${indicator(settings.alwaysOnline)}`,
    `┃ Auto View Status: ${indicator(settings.autoViewStatus)}`,
    `┃ Status Reactions: ${indicator(settings.statusReact)}`,
    `┃ Anti-link: ${indicator(settings.antiLink)}`,
    '┣━━〔 👥 GROUP FEATURES 〕━━',
    `┃ Welcome: ${indicator(settings.welcome)}`,
    `┃ Goodbye: ${indicator(settings.goodbye)}`,
    `┃ Auto React: ${indicator(settings.autoReact)}`,
    '┣━━〔 🤖 AI CONFIGURATION 〕━━',
    `┃ Gemini AI: ${indicator(settings.aiChatEnabled)}`,
    '┣━━〔 📌 PREFERENCES 〕━━',
    `┃ Status Emojis: ${(settings.statusEmojis || []).join(' ') || 'Not set'}`,
    `┃ Command Prefix: ${prefix}`,
    '╰━━━━━━━━━━━━━━━━━━━━',
    '',
    '🔴 SCANTY MD BOT CONTROL PANEL'
  ].join('\n'), 'info');
}

      case 'setemojis': {
        if (!(await ownerOnly())) return;

        const emojis = parseEmojis(args.join(''));

        if (!emojis) {
          return reply(
            'Usage: .setemojis ❤️,🔥,😍,😂 (1–10 emoji values)'
          );
        }

        await setFeatureSetting(
          userId,
          'statusEmojis',
          emojis
        );

        return reply(
          `✅ Status emojis saved: ${emojis.join(' ')}`
        );
      }

      case 'ban': {
        if (!(await ownerOnly())) return;

        const target = args[0];

        if (!target) {
          return reply(
            'Usage: .ban <phone number> (include country code)'
          );
        }

        const added = await banBotUser(
          userId,
          target
        );

        return reply(
          added
            ? '✅ Number banned from using this bot.'
            : 'That number is already banned from this bot.'
        );
      }

      case 'bans': {
        if (!(await ownerOnly())) return;

        const bans = await listBotBans(userId);

        if (!bans.length) {
          return reply(
            'There are no numbers banned from this bot.'
          );
        }

        return reply(
          `Bot access bans (${bans.length}):\n${bans
            .map(ban => `• ${ban.phoneNumber}`)
            .join('\n')}`
        );
      }

      case 'unban': {
        if (!(await ownerOnly())) return;

        const mention =
          message.message?.extendedTextMessage?.contextInfo
            ?.mentionedJid?.[0];

        const target =
          args[0] || phoneFromJid(mention);

        if (!target) {
          return reply(
            'Usage: .unban <phone number>\nThis removes a bot-access ban; it does not add anyone to a WhatsApp group.'
          );
        }

        const removed = await unbanBotUser(
          userId,
          target
        );

        return reply(
          removed
            ? '✅ Number unbanned from this bot.'
            : 'That number was not on this bot’s ban list.'
        );
      }

      default:
        if (Object.hasOwn(toggleSettings, command)) {
          if (!(await ownerOnly())) return;

          const value = args[0]?.toLowerCase();

          if (!['on', 'off'].includes(value)) {
            return reply(
              `Usage: ${prefix}${command} on/off`
            );
          }

          await setFeatureSetting(
            userId,
            toggleSettings[command],
            value === 'on'
          );

          return reply(
            `✅ ${command} turned ${value.toUpperCase()}.`
          );
        }

        return reply(
          `Unknown command: ${prefix}${command}\nSend ${prefix}menu to see supported commands.`
        );
    }

  } catch (error) {
    console.error('Message handler error:', error);

    try {
      await reply(
        '❌ Could not complete that command right now. Please try again later.'
      );
    } catch (sendError) {
      console.error(
        'Could not send command error reply:',
        sendError
      );
    }
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
