const test = require('node:test');
const assert = require('node:assert');
const { parseToggle, isOwner } = require('../statusCommands');

process.env.OWNER_NUMBER = '233538573022';

test('parseToggle accepts on/off variants', () => {
  assert.strictEqual(parseToggle('on'), true);
  assert.strictEqual(parseToggle('OFF'), false);
  assert.strictEqual(parseToggle('1'), true);
  assert.strictEqual(parseToggle('0'), false);
  assert.strictEqual(parseToggle('maybe'), null);
  assert.strictEqual(parseToggle(undefined), null);
});

test('isOwner matches owner JID only', () => {
  assert.strictEqual(isOwner('254712345678@s.whatsapp.net'), true);
  assert.strictEqual(isOwner('254799999999@s.whatsapp.net'), false);
  assert.strictEqual(isOwner(''), false);
});
