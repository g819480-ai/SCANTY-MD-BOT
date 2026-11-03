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

test('restartRequired immediately reconnects; terminal reasons do not', () => {
  assert.equal(shouldReconnect(515, reasons), true);
  assert.equal(reconnectDelay(3, 515, reasons), 0);
  assert.equal(shouldReconnect(401, reasons), false);
  assert.equal(shouldReconnect(440, reasons), false);
  assert.equal(shouldReconnect(500, reasons), false);
  assert.equal(shouldReconnect(408, reasons), true);
});

test('reconnect controller invokes replacement callback and resets attempts on open', async () => {
  let callback;
  let reconnects = 0;
  const states = [];
  const controller = createReconnectController({
    reconnect: async () => { reconnects += 1; },
    onState: state => states.push(state),
    setTimeoutFn: fn => { callback = fn; return 1; },
    clearTimeoutFn: () => {},
    reasons
  });

  assert.equal(controller.schedule(515), true);
  assert.equal(states.at(-1), 'reconnecting');
  await callback();
  assert.equal(reconnects, 1);
  controller.connected();
  assert.equal(controller.attempt, 0);
  assert.equal(states.at(-1), 'connected');
  controller.stop();
});

test('stale socket cannot trigger a replacement after a newer socket is installed', async () => {
  const oldSocket = {};
  const currentSocket = {};
  let reconnects = 0;
  assert.equal(await reconnectIfCurrent({
    currentSocket,
    expectedSocket: oldSocket,
    reconnect: async () => { reconnects += 1; }
  }), false);
  assert.equal(reconnects, 0);
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
