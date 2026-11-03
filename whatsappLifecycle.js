const TERMINAL_REASONS = new Set([
  'loggedOut',
  'connectionReplaced',
  'badSession'
]);

export function shouldReconnect(statusCode, reasons) {
  if (statusCode === reasons.restartRequired) return true;
  return !Object.entries(reasons).some(
    ([name, code]) => TERMINAL_REASONS.has(name) && statusCode === code
  );
}

export function reconnectDelay(attempt, statusCode, reasons) {
  if (statusCode === reasons.restartRequired) return 0;
  const boundedAttempt = Math.max(0, Math.min(attempt, 6));
  return Math.min(1000 * (2 ** boundedAttempt), 30000);
}

export function createReconnectController({
  reconnect,
  onState = () => {},
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  maxAttempts = 10,
  reasons
}) {
  let attempt = 0;
  let timer;
  let stopped = false;

  return {
    schedule(statusCode) {
      if (stopped || !shouldReconnect(statusCode, reasons) || attempt >= maxAttempts) {
        onState('disconnected');
        return false;
      }
      if (timer) clearTimeoutFn(timer);
      const wait = reconnectDelay(attempt, statusCode, reasons);
      attempt += 1;
      onState('reconnecting');
      timer = setTimeoutFn(async () => {
        timer = undefined;
        if (stopped) return;
        try {
          await reconnect();
        } catch (error) {
          onState('reconnect_failed', error);
          // Retry transient failures through the normal bounded backoff path.
          if (!stopped && attempt < maxAttempts) {
            timer = setTimeoutFn(async () => {
              timer = undefined;
              if (stopped) return;
              try { await reconnect(); } catch (nextError) {
                onState('reconnect_failed', nextError);
              }
            }, reconnectDelay(attempt++, undefined, reasons));
          }
        }
      }, wait);
      return true;
    },
    connected() {
      attempt = 0;
      if (timer) clearTimeoutFn(timer);
      timer = undefined;
      onState('connected');
    },
    stop() {
      stopped = true;
      if (timer) clearTimeoutFn(timer);
      timer = undefined;
    },
    get attempt() { return attempt; }
  };
}

export async function reconnectIfCurrent({ currentSocket, expectedSocket, reconnect }) {
  if (!currentSocket || currentSocket !== expectedSocket) return false;
  await reconnect();
  return true;
}

export async function withPairingLock(locks, userId, action) {
  if (locks.has(userId)) {
    const error = new Error('A pairing request is already in progress for this user.');
    error.code = 'PAIRING_IN_PROGRESS';
    throw error;
  }
  locks.add(userId);
  try {
    return await action();
  } finally {
    locks.delete(userId);
  }
}

/** Wait for the WebSocket transport to open. Baileys pairing must be requested
 * after transport readiness and before WhatsApp authentication completes.
 */
export function waitForSocketReady(sock, timeoutMs = 20000) {
  const ws = sock?.ws;
  if (!ws) return Promise.reject(new Error('WhatsApp WebSocket is unavailable.'));
  const openState = ws.OPEN ?? 1;
  if (ws.readyState === openState) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      ws.off?.('open', onOpen);
      ws.off?.('error', onError);
      ws.off?.('close', onClose);
      // Support EventEmitter implementations that only expose removeListener.
      ws.removeListener?.('open', onOpen);
      ws.removeListener?.('error', onError);
      ws.removeListener?.('close', onClose);
    };
    const onOpen = () => { cleanup(); resolve(); };
    const onError = error => {
      cleanup();
      reject(error || new Error('WhatsApp WebSocket failed.'));
    };
    const onClose = () => {
      cleanup();
      reject(new Error('WhatsApp WebSocket closed before pairing.'));
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for WhatsApp WebSocket readiness.'));
    }, timeoutMs);
    ws.once('open', onOpen);
    ws.once('error', onError);
    ws.once('close', onClose);
    if (ws.readyState === openState) onOpen();
  });
}
