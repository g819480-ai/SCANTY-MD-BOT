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
  if (attempt === 0 && statusCode === reasons.restartRequired) return 0;
  const boundedAttempt = Math.max(0, Math.min(attempt, 6));
  return Math.min(1000 * (2 ** boundedAttempt), 30000);
}

/**
 * Removes only reconnect state owned by the exhausted socket/controller pair.
 * This function is deliberately memory-only: it never touches persisted auth.
 */
export function cleanupExhaustedReconnect({
  userId,
  expectedSocket,
  controller,
  sessions,
  sessionStatus,
  reconnectControllers,
  reconnectContexts,
  qrStates,
  stopPresence = () => {}
}) {
  const context = reconnectContexts.get(userId);
  // Fail closed unless all three ownership invariants still match. In
  // particular, a missing context cannot establish that this controller owns
  // the current socket, so it must not authorize cleanup.
  if (
    sessions.get(userId) !== expectedSocket ||
    reconnectControllers.get(userId) !== controller ||
    !context ||
    context.controller !== controller ||
    context.expectedSocket !== expectedSocket
  ) {
    return false;
  }

  controller.stop();
  stopPresence(userId);
  sessionStatus.set(userId, 'disconnected');
  sessions.delete(userId);
  if (context.captureQr) {
    qrStates.set(userId, {
      qr: null,
      status: 'disconnected',
      updatedAt: Date.now()
    });
  }
  reconnectControllers.delete(userId);
  reconnectContexts.delete(userId);
  return true;
}

export function createReconnectController({
  reconnect,
  onState = () => {},
  onExhausted = () => {},
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  maxAttempts = 10,
  reasons
}) {
  let attempt = 0;
  let timer;
  let stopped = false;
  let exhausted = false;

  const finishExhausted = socketIdentity => {
    if (stopped || exhausted) return;
    exhausted = true;
    onState('disconnected', socketIdentity);
    onExhausted(socketIdentity);
  };

  const queueAttempt = (statusCode, socketIdentity) => {
    if (stopped) return false;
    if (attempt >= maxAttempts) {
      finishExhausted(socketIdentity);
      return false;
    }
    if (timer) return true;

    const attemptNumber = attempt++;
    const wait = reconnectDelay(attemptNumber, statusCode, reasons);
    onState('reconnecting', socketIdentity);
    timer = setTimeoutFn(async () => {
      timer = undefined;
      if (stopped) return;
      try {
        await reconnect(socketIdentity);
      } catch (error) {
        onState('reconnect_failed', error, socketIdentity);
        // Every failed attempt continues through the same bounded backoff loop.
        queueAttempt(undefined, socketIdentity);
      }
    }, wait);
    return true;
  };

  return {
    schedule(statusCode, socketIdentity) {
      if (stopped) return false;
      if (!shouldReconnect(statusCode, reasons)) {
        finishExhausted(socketIdentity);
        return false;
      }
      return queueAttempt(statusCode, socketIdentity);
    },
    connected() {
      attempt = 0;
      exhausted = false;
      if (timer) clearTimeoutFn(timer);
      timer = undefined;
      onState('connected');
    },
    stop() {
      stopped = true;
      if (timer) clearTimeoutFn(timer);
      timer = undefined;
    },
    get attempt() { return attempt; },
    get stopped() { return stopped; },
    get exhausted() { return exhausted; }
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

/** Wait for the WebSocket transport to open before requesting a pairing code. */
const WRAPPER_OPEN_STATE = 1;
const WRAPPER_CLOSING_STATE = 2;
const WRAPPER_CLOSED_STATE = 3;

function isSocketOpen(ws) {
  if (!ws) return false;

  if (ws.isClosed === true || ws.isClosing === true) {
    return false;
  }

  if (ws.isOpen === true) return true;
  if (ws.isOpen === false) return false;

  return ws.readyState === (ws.OPEN ?? WRAPPER_OPEN_STATE);
}

function socketIsClosedOrClosing(ws) {
  if (!ws) return true;

  if (ws.isClosed === true || ws.isClosing === true) {
    return true;
  }

  if (ws.isOpen === true || ws.isOpen === false) {
    return false;
  }

  return (
    ws.readyState === WRAPPER_CLOSING_STATE ||
    ws.readyState === WRAPPER_CLOSED_STATE
  );
}

export function waitForSocketReady(sock, timeoutMs = 20000) {
  const ws = sock?.ws;

  if (!ws) {
    return Promise.reject(
      new Error('WhatsApp WebSocket is unavailable.')
    );
  }

  if (socketIsClosedOrClosing(ws)) {
    return Promise.reject(
      new Error('WhatsApp WebSocket is already closed or closing.')
    );
  }

  if (isSocketOpen(ws)) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);

      ws.off?.('open', onOpen);
      ws.off?.('error', onError);
      ws.off?.('close', onClose);

      ws.removeListener?.('open', onOpen);
      ws.removeListener?.('error', onError);
      ws.removeListener?.('close', onClose);
    };

    const settle = (error) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (error) reject(error);
      else resolve();
    };

    const onOpen = () => {
      if (socketIsClosedOrClosing(ws)) {
        settle(new Error(
          'WhatsApp WebSocket closed before becoming ready.'
        ));
        return;
      }

      if (!isSocketOpen(ws)) return;

      settle();
    };

    const onError = (error) => {
      settle(
        error instanceof Error
          ? error
          : new Error('WhatsApp WebSocket failed.')
      );
    };

    const onClose = () => {
      settle(
        new Error('WhatsApp WebSocket closed before pairing.')
      );
    };

    ws.on('open', onOpen);
    ws.on('error', onError);
    ws.on('close', onClose);

    if (settled) return;

    if (socketIsClosedOrClosing(ws)) {
      settle(new Error(
        'WhatsApp WebSocket closed before becoming ready.'
      ));
      return;
    }

    if (isSocketOpen(ws)) {
      settle();
      return;
    }

    timer = setTimeout(() => {
      settle(
        new Error(
          'Timed out waiting for WhatsApp WebSocket readiness.'
        )
      );
    }, timeoutMs);
  });
}
