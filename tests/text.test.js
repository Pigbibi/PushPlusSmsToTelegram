const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractSmsContent,
  htmlToText,
  parseSmsFields,
  buildTelegramText,
  splitTelegramText,
} = require('../src/text');
const {
  findInterceptRule,
  interceptShouldSilence,
  interceptShouldStore,
  loadInterceptRules,
  messageMatchesRule,
} = require('../src/interceptors');

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

test('matches Beijing Telecom login SMS with optional preset interceptor', () => {
  const text = [
    '验证码：123456。尊敬的用户，感谢使用北京电信掌上营业厅。',
    '发件号码: 10001',
    '发件时间: 2026/06/01 08:00:01',
  ].join('\n');

  const rule = findInterceptRule({ title: '短信转发', text }, loadInterceptRules({
    SMS_INTERCEPT_PRESETS: 'telecom-claim-silent',
  }));
  assert.equal(rule.name, 'telecom-claim-login');
  assert.equal(rule.action, 'silence');
  assert.equal(interceptShouldSilence(rule), true);
  assert.equal(interceptShouldStore(rule), true);
});

test('matches Beijing Telecom confirmation SMS with preset product and plan checks', () => {
  const text = [
    '【办理提醒】尊敬的客户，您的验证码是：654321，号码18500000000于2026年06月01日在中国电信北京公司wap电子渠道办理互联网卡网龄享200分钟国内语音（方案编号：24BJ102053），立即生效，当月有效',
    '发件号码: 10001',
  ].join('\n');

  const matchingRule = findInterceptRule({ title: '短信转发', text }, loadInterceptRules({
    SMS_INTERCEPT_PRESETS: 'telecom-claim-silent',
    TELECOM_CONFIRM_PRODUCT_KEYWORD: '互联网卡网龄享200分钟国内语音',
    TELECOM_CONFIRM_PLAN_ID: '24BJ102053',
  }));
  const mismatchedRule = findInterceptRule({ title: '短信转发', text }, loadInterceptRules({
    SMS_INTERCEPT_PRESETS: 'telecom-claim-silent',
    TELECOM_CONFIRM_PLAN_ID: '24BJ999999',
  }));

  assert.equal(matchingRule.name, 'telecom-claim-confirm');
  assert.equal(mismatchedRule, null);
});

test('does not match unrelated SMS with preset interceptor', () => {
  const text = '验证码：111111。您正在登录其他服务。\n发件号码: 10001';

  assert.equal(findInterceptRule({ title: '短信转发', text }, loadInterceptRules({
    SMS_INTERCEPT_PRESETS: 'telecom-claim-silent',
  })), null);
});

test('matches custom JSON intercept rule', () => {
  const rule = {
    name: 'bank-otp',
    action: 'silence',
    senderIncludes: '95588',
    textIncludesAll: ['验证码'],
  };

  assert.equal(messageMatchesRule('验证码：111111\n发件号码: 95588', rule), true);
  assert.equal(messageMatchesRule('余额变动提醒\n发件号码: 95588', rule), false);
  assert.equal(interceptShouldSilence(rule), true);
  assert.equal(interceptShouldStore(rule), false);
  assert.equal(interceptShouldSilence({ action: 'store' }), false);
  assert.equal(interceptShouldStore({ action: 'silence-store' }), true);
});
