import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
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

  assert.equal(controller.schedule(408, 'socket-A'), true);
  const delays = [];
  while (timers.callbacks.size) delays.push(await timers.runNext());
  assert.equal(attempts, 4);
  assert.equal(controller.attempt, 4);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
  assert.equal(controller.schedule(408, 'socket-A'), false);
});

test('stop cancels scheduled reconnect and prevents further attempts', async () => {
  const timers = fakeTimers();
  let attempts = 0;
  const controller = createReconnectController({
    reconnect: async () => { attempts += 1; },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    reasons
  });
  controller.schedule(408, 'socket-A');
  controller.stop();
  assert.equal(timers.callbacks.size, 0);
  assert.equal(await timers.runNext(), false);
  assert.equal(attempts, 0);
});

test('scheduled reconnect retains socket identity and cannot replace a newer socket', async () => {
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
  assert.equal((await timers.runNext()), 1000);
  assert.equal(attempts, 2);
});

test('pairing lock rejects concurrent pairing and releases after completion', async () => {
  const locks = new Set();
  let release;
  const inFlight = withPairingLock(
    locks,
    'user',
    () => new Promise(resolve => { release = resolve; })
  );
  await assert.rejects(
    withPairingLock(locks, 'user', async () => {}),
    { code: 'PAIRING_IN_PROGRESS' }
  );
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
