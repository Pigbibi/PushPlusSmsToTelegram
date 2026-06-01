const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractSmsContent,
  htmlToText,
  parseSmsFields,
  buildTelegramText,
  splitTelegramText,
} = require('../src/text');

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

test('extracts SMS content without PushPlus and device metadata', () => {
  const content = extractSmsContent([
    '标题：短信转发',
    '链接：https://www.pushplus.plus/shortMessage/example',
    '1',
    '发件号码: 18620803085',
    '发件时间: 2026/06/01 14:50:51',
    '#SMS',
    '本机号码: +8618519200015',
    '开机时长: 12:01:31',
    '运营商: 中国电信',
    '信号: -85dBm',
  ].join('\n'));
  assert.equal(content, '1');
});

test('builds concise Telegram HTML message with SMS content only', () => {
  const text = buildTelegramText({
    title: '短信转发',
    updateTime: '2026-06-01 02:51:44',
    text: [
      '标题：短信转发',
      '链接：https://www.pushplus.plus/shortMessage/example',
      '验证码：406560。',
      '发件号码: 10001',
      '发件时间: 2026/06/01 02:51:43',
      '#SMS',
      '本机号码: +8618519200015',
      '运营商: 中国电信',
    ].join('\n'),
  });
  assert.equal(text.includes('发件人：10001'), true);
  assert.equal(text.includes('发件时间：2026/06/01 02:51:43'), true);
  assert.equal(text.includes('发件时间：2026/06/01 02:51:43\n\n<b>短信内容：</b>'), true);
  assert.equal(text.includes('<b>短信内容：</b>'), true);
  assert.equal(text.includes('验证码：406560。'), true);
  assert.equal(text.includes('标题：'), false);
  assert.equal(text.includes('链接：'), false);
  assert.equal(text.includes('#SMS'), false);
  assert.equal(text.includes('本机号码'), false);
  assert.equal(text.includes('运营商'), false);
  assert.equal(text.includes('完整内容'), false);
  assert.equal(text.includes('短信时间：'), false);
});

test('splits long Telegram messages', () => {
  const chunks = splitTelegramText('a'.repeat(8001), 3900);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.every(chunk => chunk.length <= 3900), true);
});
