const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePushPlusUpdateTime } = require('../src/pushplus');

test('parses PushPlus local updateTime as UTC+8', () => {
  assert.equal(
    parsePushPlusUpdateTime('2026-06-01 12:30:45'),
    Date.UTC(2026, 5, 1, 4, 30, 45),
  );
});

test('parses numeric PushPlus timestamps in seconds and milliseconds', () => {
  assert.equal(parsePushPlusUpdateTime(1_780_295_445), 1_780_295_445_000);
  assert.equal(parsePushPlusUpdateTime(1_780_295_445_000), 1_780_295_445_000);
});
