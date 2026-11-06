
import makeWASocket, {
  initAuthCreds,
  BufferJSON,
  proto,
  Browsers,
  fetchLatestBaileysVersion,
  DisconnectReason
} from '@whiskeysockets/baileys';

import pino from 'pino';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

import { handleIncomingMessage } from './messageHandler.js';
import { handleStatusUpdate } from './statusEvents.js';
import { getFeatureSettings } from './featureSettings.js';

import {
  cleanupExhaustedReconnect,
  createReconnectController,
  reconnectIfCurrent,
  waitForSocketReady,
  withPairingLock
} from './whatsappLifecycle.js';

const { Pool } = pg;

const sessions = new Map();
const sessionStatus = new Map();
const presenceTimers = new Map();
const qrStates = new Map();
const qrExpiryTimers = new Map();
const reconnectControllers = new Map();
const pairingLocks = new Set();
const reconnectContexts = new Map();

const secret = process.env.SESSION_ENCRYPTION_KEY?.trim();

if (!secret || secret.length < 64) {
  throw new Error(
    'SESSION_ENCRYPTION_KEY must exist and contain at least 64 characters.'
  );
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is missing.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5
});

const encryptionKey = crypto
  .createHash('sha256')
  .update(secret, 'utf8')
  .digest();

function normalizeQrValue(qr) {
  if (!qr) return null;

  if (typeof qr === 'string') return qr;

  if (Buffer.isBuffer(qr)) {
    return qr.toString('base64');
  }

  if (typeof qr === 'object') {
    if (typeof qr.data !== 'undefined') {
      return Buffer.from(qr.data).toString('base64');
    }

    if (
      typeof qr.toString === 'function' &&
      qr.toString() !== '[object Object]'
    ) {
      return qr.toString();
    }
  }

  return String(qr);
}

const QR_VALIDITY_MS = 30_000;

function clearQrExpiryTimer(userId) {
  const timer = qrExpiryTimers.get(userId);
  if (timer) clearTimeout(timer);
  qrExpiryTimers.delete(userId);
}

function expireQrSession(userId, expectedSocket, expectedExpiresAt) {
  const currentQr = qrStates.get(userId);
  const controller = reconnectControllers.get(userId);
  const context = reconnectContexts.get(userId);

  if (
    !currentQr ||
    currentQr.status !== 'qr' ||
    currentQr.expiresAt !== expectedExpiresAt ||
    sessions.get(userId) !== expectedSocket
  ) {
    return false;
  }

  clearQrExpiryTimer(userId);
  controller?.stop();
  stopPresenceHeartbeat(userId);

  sessions.delete(userId);
  sessionStatus.set(userId, 'expired');

  if (
    controller &&
    context?.controller === controller &&
    context.expectedSocket === expectedSocket
  ) {
    reconnectControllers.delete(userId);
    reconnectContexts.delete(userId);
  }

  qrStates.set(userId, {
    qr: null,
    status: 'expired',
    updatedAt: Date.now(),
    expiresAt: expectedExpiresAt,
    remainingSeconds: 0
  });

  try {
    expectedSocket.end(new Error('QR code expired after 30 seconds.'));
  } catch {}

  console.log('WHATSAPP QR EXPIRED:', { userId });
  return true;
}
  return String(qr);
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    encryptionKey,
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final()
  ]);

  return [
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64')
  ].join('.');
}

function decrypt(value) {
  const [ivText, tagText, dataText] = value.split('.');

  if (!ivText || !tagText || !dataText) {
    throw new Error('Invalid encrypted WhatsApp session record.');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey,
    Buffer.from(ivText, 'base64')
  );

  decipher.setAuthTag(Buffer.from(tagText, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(dataText, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

async function saveRecord(userId, type, id, value) {
  if (value == null) {
    await pool.query(
      `DELETE FROM whatsapp_sessions
       WHERE user_id=$1 AND record_type=$2 AND record_id=$3`,
      [userId, type, id]
    );

    return;
  }

  const encrypted = encrypt(
    JSON.stringify(value, BufferJSON.replacer)
  );

  await pool.query(
    `INSERT INTO whatsapp_sessions
      (user_id, record_type, record_id, encrypted_data)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, record_type, record_id)
     DO UPDATE SET
       encrypted_data=EXCLUDED.encrypted_data,
       updated_at=NOW()`,
    [userId, type, id, encrypted]
  );
}

async function readRecord(userId, type, id) {
  const result = await pool.query(
    `SELECT encrypted_data
     FROM whatsapp_sessions
     WHERE user_id=$1 AND record_type=$2 AND record_id=$3`,
    [userId, type, id]
  );

  if (!result.rows[0]) return null;

  return JSON.parse(
    decrypt(result.rows[0].encrypted_data),
    BufferJSON.reviver
  );
}

function makeAuthState(userId, creds) {
  return {
    creds: creds || initAuthCreds(),

    keys: {
      get: async (type, ids) => {
        const values = {};

        await Promise.all(
          ids.map(async id => {
            let value = await readRecord(userId, type, id);

            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.create(value);
            }

            if (value) values[id] = value;
          })
        );

        return values;
      },

      set: async data => {
        for (const [type, records] of Object.entries(data)) {
          await Promise.all(
            Object.entries(records).map(([id, value]) =>
              saveRecord(userId, type, id, value)
            )
          );
        }
      }
    }
  };
}

function stopPresenceHeartbeat(userId) {
  const timer = presenceTimers.get(userId);

  if (timer) {
    clearInterval(timer);
    presenceTimers.delete(userId);
  }
}

async function updatePresence(userId, sock) {
  if (sessions.get(userId) !== sock) return;

  try {
    const settings = await getFeatureSettings(userId);

    await sock.sendPresenceUpdate(
      settings.alwaysOnline ? 'available' : 'unavailable'
    );
  } catch (error) {
    console.error(
      `Presence update failed for ${userId}:`,
      error.message
    );
  }
}

function startPresenceHeartbeat(userId, sock) {
  stopPresenceHeartbeat(userId);

  updatePresence(userId, sock);

  const timer = setInterval(() => {
    if (sessions.get(userId) !== sock) {
      stopPresenceHeartbeat(userId);
      return;
    }

    updatePresence(userId, sock);
  }, 60000);

  presenceTimers.set(userId, timer);
}

async function sendScantyWelcome(userId, sock) {
  try {
    const alreadyWelcomed = await readRecord(
      userId,
      'meta',
      'welcome_notice_sent'
    );

    if (alreadyWelcomed) return;

    const linkedJid = sock.user?.id;

    if (!linkedJid) {
      throw new Error(
        'Could not determine the connected WhatsApp account.'
      );
    }

    const ownJid = linkedJid.endsWith('@s.whatsapp.net')
      ? `${linkedJid.split('@')[0].split(':')[0]}@s.whatsapp.net`
      : linkedJid;

    const image = await readFile(
      new URL('./scanty-md-welcome-final.jpg', import.meta.url)
    );

    await sock.sendMessage(ownJid, {
      image,
      mimetype: 'image/jpeg'
    });

    await sock.sendMessage(ownJid, {
      text:
        '✅ Bot Connected Successfully\n\n' +
        'Welcome to SCANTY MD 👑\n\n' +
        'Send .menu to see all commands.\n\n' +
        '━━━━━━━━━━━━━━━━━\n' +
        '💬 Message Developer: +233538573022\n' +
        '━━━━━━━━━━━━━━━━'
    });

    await saveRecord(
      userId,
      'meta',
      'welcome_notice_sent',
      true
    );

    console.log(
      `SCANTY MD welcome sequence sent for ${userId}`
    );
  } catch (error) {
    console.error(
      'SCANTY MD welcome sequence failed:',
      error.message
    );
  }
}

function getReconnectController(userId, state, captureQr) {
  const existing = reconnectControllers.get(userId);

  if (existing) return existing;

  let controller;

  controller = createReconnectController({
    reasons: DisconnectReason,
    maxAttempts: 10,

    onState: (status, detail, socketIdentity) => {
      if (
        status === 'reconnecting' ||
        status === 'disconnected'
      ) {
        sessionStatus.set(userId, status);
      }

      if (status === 'reconnecting') {
        console.warn('WHATSAPP RECONNECT SCHEDULED:', {
          userId,
          attempt: controller?.attempt,
          socketIsCurrent: sessions.get(userId) === detail
        });
      }

      if (status === 'reconnect_failed') {
        console.error('WHATSAPP RECONNECT FAILED:', {
          userId,
          attempt: controller?.attempt,
          message: detail?.message || String(detail),
          stack: detail?.stack,
          socketIsCurrent: sessions.get(userId) === socketIdentity
        });
      }

      if (status === 'connected') {
        console.log('WHATSAPP RECONNECT SUCCESSFUL:', { userId });
      }

      if (status === 'disconnected') {
        console.error('WHATSAPP RECONNECT EXHAUSTED:', {
          userId,
          socketIsCurrent: sessions.get(userId) === detail
        });
      }
    },

    onExhausted: expectedSocket => {
      cleanupExhaustedReconnect({
        userId,
        expectedSocket,
        controller,
        sessions,
        sessionStatus,
        reconnectControllers,
        reconnectContexts,
        qrStates,
        stopPresence: stopPresenceHeartbeat
      });
    },

    reconnect: async expectedSocket => {
      const context = reconnectContexts.get(userId);

      if (
        !context ||
        context.controller !== controller ||
        sessions.get(userId) !== expectedSocket
      ) {
        return;
      }

      await reconnectIfCurrent({
        currentSocket: sessions.get(userId),
        expectedSocket,

        reconnect: () =>
          attachSocket(
            userId,
            context.state,
            context.captureQr,
            controller,
            expectedSocket
          )
      });
    }
  });

  reconnectControllers.set(userId, controller);

  reconnectContexts.set(userId, {
    state,
    captureQr,
    controller,
    expectedSocket: null
  });

  return controller;
}

async function attachSocket(
  userId,
  state,
  captureQr = false,
  suppliedController = null,
  expectedSocket = null,
  onConnectionUpdate = null
) {
  if (
    expectedSocket &&
    sessions.get(userId) !== expectedSocket
  ) {
    return null;
  }

  const controller =
    suppliedController ||
    getReconnectController(userId, state, captureQr);

  const context = reconnectContexts.get(userId);

  reconnectContexts.set(userId, {
    ...context,
    state,
    captureQr,
    controller,
    expectedSocket:
      expectedSocket || context?.expectedSocket || null
  });

  console.log('Fetching the latest WhatsApp Web version...');

  const { version } = await fetchLatestBaileysVersion();

  if (
    expectedSocket &&
    sessions.get(userId) !== expectedSocket
  ) {
    return null;
  }

  console.log('Using WhatsApp Web version:', version);

  const sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.macOS('Safari'),
    auth: state,
    version,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    keepAliveIntervalMs: 30000,
    connectTimeoutMs: 30000
  });

  if (
    expectedSocket &&
    sessions.get(userId) !== expectedSocket
  ) {
    try {
      sock.end(new Error('Superseded reconnect socket.'));
    } catch {}

    return null;
  }

  sessions.set(userId, sock);
  sessionStatus.set(userId, 'connecting');

  const activeContext = reconnectContexts.get(userId);

  reconnectContexts.set(userId, {
    ...activeContext,
    controller,
    expectedSocket: sock
  });

  sock.ev.on('creds.update', async () => {
    console.log('WHATSAPP CREDS UPDATE:', {
      registered: state.creds.registered === true,
      hasMe: Boolean(state.creds.me)
    });

    try {
      await saveRecord(userId, 'creds', 'main', state.creds);

      console.log('WHATSAPP CREDS SAVED:', {
        registered: state.creds.registered === true,
        hasMe: Boolean(state.creds.me)
      });
    } catch (error) {
      console.error(
        'Could not save credentials:',
        error.message
      );
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log('WHATSAPP MESSAGE EVENT:', {
      type,
      count: messages?.length || 0
    });

    if (type !== 'notify' && type !== 'append') return;

    for (const message of messages || []) {
      try {
        if (type === 'append' && !message.key?.fromMe) {
          continue;
        }

        if (message.key?.remoteJid === 'status@broadcast') {
          await handleStatusUpdate(sock, userId, message);
        } else {
          await handleIncomingMessage(sock, userId, message);
        }
      } catch (error) {
        console.error(
          'Incoming message processing failed:',
          error.message
        );
      }
    }
  });

  sock.ev.on('connection.update', async update => {
    const {
      connection,
      lastDisconnect,
      qr
    } = update;

    if (sessions.get(userId) !== sock) return;

    // Notify the pairing flow from this original listener.
    // This avoids missing an early QR event.
    if (typeof onConnectionUpdate === 'function') {
      try {
        onConnectionUpdate(update);
      } catch (error) {
        console.error(
          'Pairing readiness callback failed:',
          error.message
        );
      }
    }

    const statusCode =
      lastDisconnect?.error?.output?.statusCode;

    if (captureQr && qr) {
  clearQrExpiryTimer(userId);

  const expiresAt = Date.now() + QR_VALIDITY_MS;

  qrStates.set(userId, {
    qr: normalizeQrValue(qr),
    status: 'qr',
    updatedAt: Date.now(),
    expiresAt
  });

  const expiryTimer = setTimeout(() => {
    expireQrSession(userId, sock, expiresAt);
  }, QR_VALIDITY_MS);

  qrExpiryTimers.set(userId, expiryTimer);
}

    if (connection === 'open') {
      controller.connected();
      sessionStatus.set(userId, 'connected');

      if (captureQr) {
  clearQrExpiryTimer(userId);

  qrStates.set(userId, {
    qr: null,
    status: 'connected',
    updatedAt: Date.now(),
    expiresAt: null,
    remainingSeconds: null
  });
}

      console.log(`WhatsApp connected for user ${userId}`);

      await sendScantyWelcome(userId, sock);
      startPresenceHeartbeat(userId, sock);

      return;
    }

    if (connection === 'connecting') {
      sessionStatus.set(userId, 'connecting');

      if (captureQr && !qr) {
        const current = qrStates.get(userId);

        if (!current || current.status !== 'qr') {
          qrStates.set(userId, {
            qr: null,
            status: 'connecting',
            updatedAt: Date.now()
          });
        }
      }

      return;
    }

    if (connection !== 'close') return;

    stopPresenceHeartbeat(userId);

    console.error('WHATSAPP DISCONNECT DETAILS:', {
      userId,
      statusCode,
      message: lastDisconnect?.error?.message,
      error: lastDisconnect?.error?.toString()
    });

    if (!controller.schedule(statusCode, sock)) {
      cleanupExhaustedReconnect({
        userId,
        expectedSocket: sock,
        controller,
        sessions,
        sessionStatus,
        reconnectControllers,
        reconnectContexts,
        qrStates,
        stopPresence: stopPresenceHeartbeat
      });
    }
  });

  return sock;
}

export async function initializeSessionStorage() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      record_type TEXT NOT NULL,
      record_id TEXT NOT NULL,
      encrypted_data TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, record_type, record_id)
    )
  `);
}

export async function restoreUserSessions() {
  const result = await pool.query(
    `SELECT DISTINCT user_id
     FROM whatsapp_sessions
     WHERE record_type = 'creds'
       AND record_id = 'main'`
  );

  let restored = 0;
  let unregistered = 0;
  let failed = 0;

  console.log(
    `Found ${result.rows.length} saved WhatsApp credential record(s).`
  );

  for (const { user_id: userId } of result.rows) {
    if (sessions.has(userId)) continue;

    try {
      const creds = await readRecord(userId, 'creds', 'main');

      if (!creds?.registered) {
        unregistered++;
        continue;
      }

      await attachSocket(
        userId,
        makeAuthState(userId, creds)
      );

      restored++;
    } catch (error) {
      failed++;
      sessionStatus.set(userId, 'restore_failed');

      console.error(
        'WhatsApp session restore failed:',
        error.message
      );
    }
  }

  console.log('SESSION RESTORE SUMMARY:', {
    found: result.rows.length,
    restored,
    unregistered,
    failed
  });

  return restored;
}

export function getUserSessionStatus(userId) {
  return sessionStatus.get(userId) || 'not_connected';
}

function serializeQrState(state, includeQr = true) {
  if (!state) return null;

  const remainingSeconds = state.expiresAt
    ? Math.max(0, Math.ceil((state.expiresAt - Date.now()) / 1000))
    : null;

  return {
    ...(includeQr
      ? {
          qr:
            state.status === 'qr' && remainingSeconds > 0
              ? state.qr
              : null
        }
      : {}),
    status:
      state.expiresAt &&
      remainingSeconds === 0 &&
      state.status === 'qr'
        ? 'expired'
        : state.status,
    updatedAt: state.updatedAt,
    expiresAt: state.expiresAt || null,
    remainingSeconds
  };
}

export function getUserQrState(userId) {
  const state = qrStates.get(userId);

  if (!state) {
    return {
      qr: null,
      status: getUserSessionStatus(userId),
      expiresAt: null,
      remainingSeconds: null
    };
  }

  return serializeQrState(state, true);
}

export function getQrMonitoringStates() {
  return Array.from(qrStates.entries())
    .map(([userId, state]) => ({
      userId,
      ...serializeQrState(state, false)
    }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function startUserQrSession(userId) {
  return withPairingLock(
    pairingLocks,
    userId,
    async () => {
      if (!/^[a-f0-9-]{16,64}$/i.test(userId)) {
        throw new Error('Invalid user ID.');
      }

      if (sessions.has(userId)) {
        throw new Error(
          'A WhatsApp session is already active for this user.'
        );
      }

      const savedCreds = await readRecord(
        userId,
        'creds',
        'main'
      );

      if (savedCreds?.registered) {
        throw new Error(
          'This WhatsApp account is already linked.'
        );
      }

      const state = makeAuthState(userId, savedCreds);
      clearQrExpiryTimer(userId);
      qrStates.set(userId, {
        qr: null,
        status: 'connecting',
        updatedAt: Date.now()
      });

      await attachSocket(userId, state, true);

      return { started: true };
    }
  );
}

export async function startUserSession(
  userId,
  phoneNumber,
  onPairingCode
) {
  return withPairingLock(
    pairingLocks,
    userId,
    async () => {
      if (!/^[a-f0-9-]{16,64}$/i.test(userId)) {
        throw new Error('Invalid user ID.');
      }

      if (!/^\d{10,15}$/.test(phoneNumber)) {
        throw new Error(
          'Enter your country code and phone number using digits only.'
        );
      }
     clearQrExpiryTimer(userId);
      if (sessions.has(userId)) {
        throw new Error(
          'A WhatsApp session is already active for this user.'
        );
      }

      const savedCreds = await readRecord(
        userId,
        'creds',
        'main'
      );

      if (savedCreds?.registered) {
        throw new Error(
          'This WhatsApp account is already linked.'
        );
      }

      qrStates.delete(userId);

      const state = makeAuthState(userId, savedCreds);

      let sock = null;

      try {
        sock = await attachSocket(
          userId,
          state,
          false
        );

        if (!sock) {
          throw new Error(
            'WhatsApp socket could not be created.'
          );
        }

        console.log(
          'Waiting for WhatsApp WebSocket readiness:',
          userId
        );

        await waitForSocketReady(sock, 30000);

        if (sessions.get(userId) !== sock) {
          throw new Error(
            'WhatsApp connection changed before pairing.'
          );
        }

        // Allow the WhatsApp handshake to settle.
        await new Promise(resolve => setTimeout(resolve, 3000));

        if (sessions.get(userId) !== sock) {
          throw new Error(
            'WhatsApp connection closed before pairing.'
          );
        }

        const code = await sock.requestPairingCode(
          phoneNumber
        );

        if (!code) {
          throw new Error(
            'WhatsApp did not return a pairing code.'
          );
        }

        if (typeof onPairingCode === 'function') {
          onPairingCode(code);
        }

        console.log(
          'WHATSAPP PAIRING CODE GENERATED:',
          userId
        );

        return {
          started: true
        };
      } catch (error) {
        stopPresenceHeartbeat(userId);

        const activeController =
          reconnectControllers.get(userId);

        const activeContext =
          reconnectContexts.get(userId);

        if (
          activeController &&
          activeContext?.controller === activeController &&
          activeContext.captureQr === false &&
          (
            !sock ||
            activeContext.expectedSocket === sock
          )
        ) {
          activeController.stop();
          reconnectControllers.delete(userId);
          reconnectContexts.delete(userId);
        }

        if (sock && sessions.get(userId) === sock) {
          sessions.delete(userId);
        }

        if (
          !sock ||
          sessions.get(userId) === undefined
        ) {
          sessionStatus.set(userId, 'disconnected');
        }

        try {
          sock?.end(error);
        } catch {
          // Socket may already be closed.
        }

        console.error('PAIRING REQUEST FAILED:', {
          userId,
          message: error.message,
          stack: error.stack
        });

        throw error;
      }
    }
  );
}

      
