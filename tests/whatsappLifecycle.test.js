import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  cleanupExhaustedReconnect,
  createReconnectController,
  reconnectDelay,
  reconnectIfCurrent,
  shouldReconnect,
  waitForSocketReady,
  withPairingLock
} from '../whatsappLifecycle.js';

const reasons = {
  loggedOut: 401,
  connectionReplaced: 440,
  badSession: 500,
  restartRequired: 515,
  timedOut: 408
};

function fakeTimers() {
  let nextId = 0;
  const callbacks = new Map();
  return {
    callbacks,
    setTimeoutFn(fn, ms) {
      const id = ++nextId;
      callbacks.set(id, { fn, ms });
      return id;
    },
    clearTimeoutFn(id) { callbacks.delete(id); },
    async runNext() {
      const entry = callbacks.entries().next().value;
      if (!entry) return false;
      const [id, timer] = entry;
      callbacks.delete(id);
      await timer.fn();
      return timer.ms;
    }
  };
}

function cleanupMaps(socket = {}, controller = {}) {
  const context = { controller, expectedSocket: socket, captureQr: true };
  return {
    socket,
    controller,
    sessions: new Map([['user', socket]]),
    sessionStatus: new Map([['user', 'reconnecting']]),
    reconnectControllers: new Map([['user', controller]]),
    reconnectContexts: new Map([['user', context]]),
    qrStates: new Map(),
    context
  };
}

function cleanup(maps, expectedSocket = maps.socket, controller = maps.controller) {
  return cleanupExhaustedReconnect({
    userId: 'user',
    expectedSocket,
    controller,
    ...maps
  });
}

test('restartRequired immediately reconnects; terminal reasons do not', () => {
  assert.equal(shouldReconnect(515, reasons), true);
  assert.equal(reconnectDelay(0, 515, reasons), 0);
  assert.equal(shouldReconnect(401, reasons), false);
  assert.equal(shouldReconnect(440, reasons), false);
  assert.equal(shouldReconnect(500, reasons), false);
  assert.equal(shouldReconnect(408, reasons), true);
});

test('consecutive reconnect failures retry to the configured maximum', async () => {
  const timers = fakeTimers();
  let attempts = 0;
  const controller = createReconnectController({
    reconnect: async () => { attempts += 1; throw new Error('offline'); },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    maxAttempts: 4,
    reasons
  });
  controller.schedule(408, 'socket-A');
  const delays = [];
  while (timers.callbacks.size) delays.push(await timers.runNext());
  assert.equal(attempts, 4);
  assert.equal(controller.attempt, 4);
  assert.equal(controller.exhausted, true);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
});

test('cleanup safely rejects a missing reconnect context without changing session state', () => {
  const maps = cleanupMaps();
  maps.reconnectContexts.delete('user');

  assert.doesNotThrow(() => assert.equal(cleanup(maps), false));
  assert.equal(maps.sessions.get('user'), maps.socket);
  assert.equal(maps.sessionStatus.get('user'), 'reconnecting');
  assert.equal(maps.reconnectControllers.get('user'), maps.controller);
  assert.equal(maps.controller.stopped, false);
});

test('cleanup rejects a socket replaced by a newer active session and never deletes it', () => {
  const maps = cleanupMaps();
  const newerSocket = {};
  maps.sessions.set('user', newerSocket);

  assert.equal(cleanup(maps), false);
  assert.equal(maps.sessions.get('user'), newerSocket);
  assert.equal(maps.sessionStatus.get('user'), 'reconnecting');
  assert.equal(maps.reconnectControllers.get('user'), maps.controller);
});

test('cleanup rejects a controller replaced by a newer controller', () => {
  const maps = cleanupMaps();
  const newerController = {};
  maps.reconnectControllers.set('user', newerController);

  assert.equal(cleanup(maps), false);
  assert.equal(maps.sessions.get('user'), maps.socket);
  assert.equal(maps.reconnectControllers.get('user'), newerController);
  assert.equal(maps.sessionStatus.get('user'), 'reconnecting');
});

test('cleanup succeeds only for the current session, socket, and controller', () => {
  const maps = cleanupMaps();
  let stoppedPresence = 0;

  assert.equal(cleanupExhaustedReconnect({
    userId: 'user',
    expectedSocket: maps.socket,
    controller: maps.controller,
    ...maps,
    stopPresence: () => { stoppedPresence += 1; }
  }), true);
  assert.equal(maps.sessions.has('user'), false);
  assert.equal(maps.sessionStatus.get('user'), 'disconnected');
  assert.equal(maps.reconnectControllers.has('user'), false);
  assert.equal(maps.reconnectContexts.has('user'), false);
  assert.deepEqual(maps.qrStates.get('user').status, 'disconnected');
  assert.equal(stoppedPresence, 1);
  assert.equal(maps.controller.stopped, true);
});

test('retry exhaustion cleans current in-memory socket/controller and permits a fresh pairing', async () => {
  const timers = fakeTimers();
  const maps = cleanupMaps();
  let cleanupResult;
  let stoppedPresence = 0;
  let controller;
  controller = createReconnectController({
    reconnect: async () => { throw new Error('offline'); },
    onExhausted: expectedSocket => {
      cleanupResult = cleanupExhaustedReconnect({
        userId: 'user',
        expectedSocket,
        controller,
        ...maps,
        stopPresence: () => { stoppedPresence += 1; }
      });
    },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    maxAttempts: 1,
    reasons
  });
  maps.reconnectControllers.set('user', controller);
  maps.reconnectContexts.set('user', {
    ...maps.context,
    controller
  });

  controller.schedule(408, maps.socket);
  await timers.runNext();
  assert.equal(cleanupResult, true);
  assert.equal(maps.sessionStatus.get('user'), 'disconnected');
  assert.equal(maps.sessions.has('user'), false);
  assert.equal(maps.reconnectControllers.has('user'), false);
  assert.equal(maps.reconnectContexts.has('user'), false);
  assert.equal(maps.qrStates.get('user').status, 'disconnected');
  assert.equal(stoppedPresence, 1);
  // Persistence is deliberately not part of this cleanup; pairing can begin again.
  assert.equal(controller.stopped, true);
});

test('retry cancellation after stop prevents reconnect and exhaustion cleanup', async () => {
  const timers = fakeTimers();
  let attempts = 0;
  let exhausted = 0;
  const controller = createReconnectController({
    reconnect: async () => { attempts += 1; },
    onExhausted: () => { exhausted += 1; },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    reasons
  });
  controller.schedule(408, 'socket-A');
  controller.stop();
  assert.equal(timers.callbacks.size, 0);
  assert.equal(await timers.runNext(), false);
  assert.equal(attempts, 0);
  assert.equal(exhausted, 0);
});

test('scheduled reconnect cannot replace a newer socket', async () => {
  const timers = fakeTimers();
  const oldSocket = {};
  const newSocket = {};
  let currentSocket = oldSocket;
  let reconnects = 0;
  const controller = createReconnectController({
    reconnect: identity => reconnectIfCurrent({
      currentSocket,
      expectedSocket: identity,
      reconnect: async () => { reconnects += 1; }
    }),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    reasons
  });
  controller.schedule(408, oldSocket);
  currentSocket = newSocket;
  await timers.runNext();
  assert.equal(reconnects, 0);
});

test('successful reconnection resets retry count', async () => {
  const timers = fakeTimers();
  let attempts = 0;
  const controller = createReconnectController({
    reconnect: async () => { attempts += 1; },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    reasons
  });
  controller.schedule(408, 'socket-A');
  await timers.runNext();
  assert.equal(attempts, 1);
  controller.connected();
  assert.equal(controller.attempt, 0);
  controller.schedule(408, 'socket-B');
  assert.equal(await timers.runNext(), 1000);
  assert.equal(attempts, 2);
});

test('pairing lock rejects concurrent pairing and releases after completion', async () => {
  const locks = new Set();
  let release;
  const inFlight = withPairingLock(locks, 'user', () => new Promise(resolve => { release = resolve; }));
  await assert.rejects(withPairingLock(locks, 'user', async () => {}), { code: 'PAIRING_IN_PROGRESS' });
  release('done');
  assert.equal(await inFlight, 'done');
  assert.equal(locks.has('user'), false);
  assert.equal(await withPairingLock(locks, 'user', async () => 'ok'), 'ok');
});

test('phone pairing readiness waits for WebSocket open', async () => {
  const ws = new EventEmitter();
  ws.OPEN = 1;
  ws.readyState = 0;
  const ready = waitForSocketReady({ ws }, 1000);
  ws.readyState = 1;
  ws.emit('open');
  await ready;
});

test('phone pairing readiness rejects WebSocket close before open', async () => {
  const ws = new EventEmitter();
  ws.OPEN = 1;
  ws.readyState = 0;
  const ready = waitForSocketReady({ ws }, 1000);
  ws.emit('close');
  await assert.rejects(ready, /closed before pairing/);
});
