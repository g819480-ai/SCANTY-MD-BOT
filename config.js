
export const config = {
  botName: 'SCANTY MD BOT',

  statusSettings: {
    enabled: false,
    onlyOptedInContacts: true
  },

  reactionSettings: {
    enabled: false,
    randomEmoji: true,
    emojis: [
      '❤️',
      '🔥',
      '😍',
      '😂',
      '🥰',
      '👏',
      '👍',
      '💯',
      '😘'
    ]
  },

  // Add contacts here only after they agree.
  allowedContacts: []
};
