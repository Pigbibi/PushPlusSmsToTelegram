const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');

async function loadWorker() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
  const encoded = Buffer.from(source).toString('base64');
  return import(`data:text/javascript;base64,${encoded}#${Date.now()}-${Math.random()}`);
}

test('worker stores and silences a successful Telecom claim receipt', async () => {
  const { default: worker } = await loadWorker();
  const originalFetch = globalThis.fetch;
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const stored = new Map();
  let fetchCalls = 0;
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('Telegram must not receive an intercepted receipt');
  };

  try {
    const response = await worker.fetch(new Request(
      'https://worker.example.test/pushplus/webhook/callback-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shortCode: 'receipt-test',
          title: '短信转发',
          content: [
            '【办理提醒】尊敬的客户，您已通过wap电子渠道成功办理测试语音包（方案编号TEST-PLAN），本月有效',
            '发件号码: 10000',
          ].join('\n'),
        }),
      },
    ), {
      CALLBACK_TOKEN: 'callback-token',
      STATE_SECRET: 'state-secret',
      TELEGRAM_BOT_TOKEN: 'telegram-token',
      TELEGRAM_CHAT_ID: 'chat-id',
      SMS_INTERCEPT_PRESETS: 'telecom-claim-silent',
      TELECOM_CONFIRM_PRODUCT_KEYWORD: '测试语音包',
      TELECOM_CONFIRM_PLAN_ID: 'TEST-PLAN',
      FORWARDED_KV: {
        get: async key => stored.get(key) || null,
        put: async (key, value) => stored.set(key, value),
      },
    }, {});

    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCrypto) {
      Object.defineProperty(globalThis, 'crypto', originalCrypto);
    } else {
      delete globalThis.crypto;
    }
  }

  assert.equal(fetchCalls, 0);
  assert.equal([...stored.values()].some(value => value === 'intercept:telecom-claim-success'), true);
  const inboxEntry = [...stored.entries()].find(([key]) => key.startsWith('inbox:'));
  assert.equal(JSON.parse(inboxEntry?.[1] || '{}').sender, '10000');
});
