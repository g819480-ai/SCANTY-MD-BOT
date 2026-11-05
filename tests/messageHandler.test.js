
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleIncomingMessage,
  messageHandlerInternals
} from '../messageHandler.js';

function createMessage(text, overrides = {}) {
  return {
    key: {
      remoteJid: '233241234567@s.whatsapp.net',
      fromMe: false,
      ...overrides
    },
    message: {
      conversation: text
    }
  };
}

function createSocket(sendMessage = async () => ({
  key: { id: 'test-message' }
})) {
  return {
    user: {
      id: '233200000000@s.whatsapp.net'
    },
    ws: {
      readyState: 1
    },
    sendMessage
  };
}

function createDependencies() {
  return {
    isBotUserBanned: async () => false,
    getFeatureSettings: async () => ({
      prefix: '.'
    })
  };
}

test('command menu advertises supported commands', () => {
  const menu = messageHandlerInternals.menuText();

  assert.match(menu, /\.ping/);
  assert.match(menu, /\.unban <phone number>/);
  assert.match(menu, /\.alwaysonline on\/off/);
  assert.match(menu, /\.autoviewstatus on\/off/);
  assert.match(menu, /\.statusreact on\/off/);

  assert.doesNotMatch(
    menu,
    /\.translate|\.sticker|\.toimg/
  );

  assert.match(menu, /does not add/i);
});

test('message parser unwraps supported WhatsApp message formats', () => {
  const { getMessageText } = messageHandlerInternals;

  assert.equal(
    getMessageText({
      message: {
        conversation: '.ping'
      }
    }),
    '.ping'
  );

  assert.equal(
    getMessageText({
      message: {
        ephemeralMessage: {
          message: {
            conversation: '.ping'
          }
        }
      }
    }),
    '.ping'
  );

  assert.equal(
    getMessageText({
      message: {
        imageMessage: {
          caption: '.help'
        }
      }
    }),
    '.help'
  );

  assert.equal(
    getMessageText({
      message: {
        viewOnceMessage: {
          message: {
            extendedTextMessage: {
              text: '.status'
            }
          }
        }
      }
    }),
    '.status'
  );
});

test('emoji parser removes duplicates and rejects invalid lists', () => {
  const { parseEmojis } = messageHandlerInternals;

  assert.deepEqual(
    parseEmojis('❤️,🔥,❤️'),
    ['❤️', '🔥']
  );

  assert.equal(parseEmojis(''), null);

  assert.equal(
    parseEmojis(Array(11).fill('😀').join(',')),
    null
  );
});

test('incoming .ping sends the exact expected WhatsApp reply', async () => {
  const sent = [];

  const sock = createSocket(async (...args) => {
    sent.push(args);
    return {
      key: { id: 'successful-test-message' }
    };
  });

  const message = createMessage('.ping');

  await handleIncomingMessage(
    sock,
    'test-user-ping-success',
    message,
    createDependencies()
  );

  assert.equal(sent.length, 1);

  assert.equal(
    sent[0][1].text,
    '🏓 SCANTY MD BOT is responding.'
  );

  assert.equal(
    sent[0][0],
    message.key.remoteJid
  );

  assert.equal(
    sent[0][2].quoted,
    message
  );
});

test('failed WhatsApp sends are caught without an unhandled rejection', async () => {
  let attempts = 0;

  const sock = createSocket(async () => {
    attempts += 1;
    throw new Error('Simulated WhatsApp send failure');
  });

  const originalError = console.error;
  console.error = () => {};

  try {
    await assert.doesNotReject(
      handleIncomingMessage(
        sock,
        'test-user-ping-failure',
        createMessage('.ping'),
        createDependencies()
      )
    );
  } finally {
    console.error = originalError;
  }

  // First attempt: command reply.
  // Second attempt: fallback error reply.
  assert.equal(attempts, 2);
});

test('ordinary messages without a command do not send replies', async () => {
  let attempts = 0;

  const sock = createSocket(async () => {
    attempts += 1;
  });

  await handleIncomingMessage(
    sock,
    'test-user-ordinary-message',
    createMessage('hello'),
    createDependencies()
  );

  assert.equal(attempts, 0);
});
