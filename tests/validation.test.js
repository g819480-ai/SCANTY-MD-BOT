import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDashboardOrigins,
  resolveAllowedOrigin,
  normalizePhoneNumber,
  isValidPhoneNumber,
  isValidUserId
} from '../utils/validation.js';

test('parseDashboardOrigins accepts comma-separated origins and strips trailing slashes', () => {
  assert.deepEqual(
    parseDashboardOrigins('https://a.example.com/,https://b.example.com///'),
    ['https://a.example.com', 'https://b.example.com']
  );
});

test('resolveAllowedOrigin allows only configured dashboard origins', () => {
  const allowed = ['https://dashboard.example.com'];

  assert.equal(resolveAllowedOrigin('https://dashboard.example.com', allowed), 'https://dashboard.example.com');
  assert.equal(resolveAllowedOrigin('https://evil.example.com', allowed), null);
  assert.equal(resolveAllowedOrigin('', allowed), null);
});

test('normalizePhoneNumber removes formatting and preserves digits', () => {
  assert.equal(normalizePhoneNumber('+1 (555) 123-4567'), '15551234567');
  assert.equal(normalizePhoneNumber('00015551234567'), '15551234567');
});

test('isValidPhoneNumber accepts international digits only', () => {
  assert.equal(isValidPhoneNumber('15551234567'), true);
  assert.equal(isValidPhoneNumber('12345'), false);
  assert.equal(isValidPhoneNumber('+15551234567'), false);
});

test('isValidUserId accepts UUID-like IDs and rejects invalid values', () => {
  assert.equal(isValidUserId('123e4567-e89b-12d3-a456-426614174000'), true);
  assert.equal(isValidUserId('not-a-valid-id'), false);
  assert.equal(isValidUserId(''), false);
});
