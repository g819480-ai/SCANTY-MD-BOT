
const BRAND = '🔴 SCANTY MD BOT';

export function styleMessage(message, type = 'info') {
  const styles = {
    success: '✅ SUCCESS',
    error: '❌ ERROR',
    warning: '⚠️ WARNING',
    info: '📡 INFORMATION'
  };

  const heading = styles[type] || styles.info;
  const body = String(message ?? '').trim();

  return [
    '╭━━━〔 🔴 SCANTY MD BOT 〕━━━╮',
    `┃ ${heading}`,
    '┣━━━━━━━━━━━━━━━━━━',
    ...body.split('\n').map(line => `┃ ${line}`),
    '╰━━━━━━━━━━━━━━━━━━╯',
    '       POWERED BY SCANTY'
  ].join('\n');
}

export function successMessage(message) {
  return styleMessage(message, 'success');
}

export function errorMessage(message) {
  return styleMessage(message, 'error');
}

export function warningMessage(message) {
  return styleMessage(message, 'warning');
}

export function infoMessage(message) {
  return styleMessage(message, 'info');
}

export function menuMessage(prefix = '.') {
  return [
    '╭━━━〔 🔴 SCANTY MD BOT 〕━━━╮',
    '┃',
    '┃ 👋 WELCOME TO THE COMMAND CENTRE',
    '┃ ⚡ SYSTEM: ONLINE',
    '┃',
    '┣━━━〔 📌 GENERAL 〕━━━',
    `┃ ▸ ${prefix}menu`,
    `┃ ▸ ${prefix}ping`,
    `┃ ▸ ${prefix}status`,
    `┃ ▸ ${prefix}uptime`,
    `┃ ▸ ${prefix}jid`,
    '┃',
    '┣━━━〔 👥 GROUP TOOLS 〕━━━',
    `┃ ▸ ${prefix}groupinfo`,
    `┃ ▸ ${prefix}admins`,
    `┃ ▸ ${prefix}antilink on/off`,
    `┃ ▸ ${prefix}promote @user`,
    `┃ ▸ ${prefix}demote @user`,
    `┃ ▸ ${prefix}remove @user`,
    `┃ ▸ ${prefix}join <link>`,
    '┃',
    '┣━━━〔 ⚙️ BOT SETTINGS 〕━━━',
    `┃ ▸ ${prefix}settings`,
    `┃ ▸ ${prefix}alwaysonline on/off`,
    `┃ ▸ ${prefix}autoviewstatus on/off`,
    `┃ ▸ ${prefix}statusreact on/off`,
    `┃ ▸ ${prefix}setemojis ❤️,🔥,😍`,
    '┃',
    '┣━━━〔 🤖 AI ASSISTANT 〕━━━',
    `┃ ▸ ${prefix}ai on/off`,
    '┃',
    '┣━━━〔 👑 OWNER TOOLS 〕━━━',
    `┃ ▸ ${prefix}ban <number>`,
    `┃ ▸ ${prefix}bans`,
    `┃ ▸ ${prefix}unban <number>`,
    '┃',
    '╰━━━━━━━━━━━━━━━━━━╯',
    '  🔴 POWERED BY SCANTY'
  ].join('\n');
}
