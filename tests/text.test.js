const test = require('node:test');
const assert = require('node:assert/strict');
const { htmlToText, parseSmsFields, buildTelegramText, splitTelegramText } = require('../src/text');

test('converts PushPlus html to text', () => {
  const text = htmlToText('<p>验证码&#65306;406560&nbsp;</p><script>ignore()</script><div>发件号码:10001</div>');
  assert.equal(text.includes('验证码：406560'), true);
  assert.equal(text.includes('发件号码:10001'), true);
  assert.equal(text.includes('ignore'), false);
});

test('extracts sender and sent time', () => {
  const fields = parseSmsFields('发件号码: 10001\n发件时间: 2026/06/01 02:51:43');
  assert.deepEqual(fields, { sender: '10001', sentAt: '2026/06/01 02:51:43' });
});

test('builds Telegram HTML message with full content', () => {
  const text = buildTelegramText({
    title: '短信转发',
    updateTime: '2026-06-01 02:51:44',
    text: '验证码：406560。\n发件号码: 10001\n发件时间: 2026/06/01 02:51:43',
  });
  assert.equal(text.includes('发件人：10001'), true);
  assert.equal(text.includes('短信时间：2026/06/01 02:51:43'), true);
  assert.equal(text.includes('验证码：406560。'), true);
});

test('splits long Telegram messages', () => {
  const chunks = splitTelegramText('a'.repeat(8001), 3900);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.every(chunk => chunk.length <= 3900), true);
});
