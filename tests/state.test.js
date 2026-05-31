const test = require('node:test');
const assert = require('node:assert/strict');
const { messageId, markForwarded, hasForwarded } = require('../src/state');

test('uses HMAC ids for public state', () => {
  const id = messageId({ shortCode: 'abc123' }, 'state-secret');
  assert.equal(id.length, 64);
  assert.equal(id.includes('abc123'), false);
});

test('marks forwarded messages once', () => {
  const state = { forwarded: [] };
  markForwarded(state, 'id-1');
  markForwarded(state, 'id-1');
  assert.equal(hasForwarded(state, 'id-1'), true);
  assert.equal(state.forwarded.length, 1);
});
