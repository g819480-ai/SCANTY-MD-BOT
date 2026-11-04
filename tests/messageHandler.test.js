import test from 'node:test';
import assert from 'node:assert/strict';
import { messageHandlerInternals } from '../messageHandler.js';

test('command menu advertises only the supported command family', () => {
  const menu = messageHandlerInternals.menuText();
  assert.match(menu, /\.ping/);
  assert.match(menu, /\.unban <phone number>/);
  assert.doesNotMatch(menu, /\.ai|\.translate|\.sticker|\.toimg/);
  assert.match(menu, /does not add/i);
});

test('message text parser unwraps ephemeral and caption messages', () => {
  const { getMessageText } = messageHandlerInternals;
  assert.equal(getMessageText({ message: { ephemeralMessage: { message: { conversation: '.ping' } } } }), '.ping');
  assert.equal(getMessageText({ message: { imageMessage: { caption: '.help' } } }), '.help');
});

test('emoji parser rejects empty/oversized lists and de-duplicates values', () => {
  const { parseEmojis } = messageHandlerInternals;
  assert.deepEqual(parseEmojis('❤️,🔥,❤️'), ['❤️', '🔥']);
  assert.equal(parseEmojis(''), null);
  assert.equal(parseEmojis(Array(11).fill('😀').join(',')), null);
});
