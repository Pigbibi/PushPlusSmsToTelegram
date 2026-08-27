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

test('worker intercepts Guangdong OTP only while a workflow lease is active', async () => {
  const { default: worker, InterceptLeaseCoordinator } = await loadWorker();
  const originalFetch = globalThis.fetch;
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const stored = new Map();
  const leaseStorage = new Map();
  let telegramCalls = 0;
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  globalThis.fetch = async url => {
    assert.equal(new URL(String(url)).hostname, 'api.telegram.org');
    telegramCalls += 1;
    return Response.json({ ok: true });
  };

  const kv = {
    get: async key => stored.get(key) || null,
    put: async (key, value) => stored.set(key, value),
  };
  const coordinator = new InterceptLeaseCoordinator({
    storage: {
      list: async ({ prefix }) => new Map(
        [...leaseStorage].filter(([key]) => key.startsWith(prefix)),
      ),
      get: async key => leaseStorage.get(key),
      put: async (key, value) => leaseStorage.set(key, value),
      delete: async keyOrKeys => {
        for (const key of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) leaseStorage.delete(key);
      },
    },
  });
  const env = {
    CALLBACK_TOKEN: 'callback-token',
    INBOX_TOKEN: 'inbox-token',
    STATE_SECRET: 'state-secret',
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    TELEGRAM_CHAT_ID: 'chat-id',
    FORWARDED_KV: kv,
    INTERCEPT_LEASES: {
      getByName: () => ({
        fetch: request => coordinator.fetch(
          typeof request === 'string' ? new Request(request) : request,
        ),
      }),
    },
  };

  const sendWebhook = shortCode => worker.fetch(new Request(
    'https://worker.example.test/pushplus/webhook/callback-token',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        shortCode,
        title: '短信转发',
        content: '广东政务服务统一身份认证验证码是123456\n发件号码: 10690000',
      }),
    },
  ), env, {});

  try {
    const acquireResponse = await worker.fetch(new Request(
      'https://worker.example.test/intercepts/leases/guangdong-sso-auth/run-123',
      {
        method: 'PUT',
        headers: {
          authorization: 'Bearer inbox-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ttlSeconds: 3600 }),
      },
    ), env, {});
    assert.equal(acquireResponse.status, 200);
    const leaseKey = 'lease:guangdong-sso-auth:run-123';
    assert.equal(Number(leaseStorage.get(leaseKey)?.expiresAt) > Date.now(), true);

    assert.equal((await sendWebhook('leased-message')).status, 200);
    assert.equal(telegramCalls, 0);
    assert.equal([...stored.values()].some(value => value === 'intercept:guangdong-sso-auth'), true);
    assert.equal([...stored.keys()].some(key => key.startsWith('inbox:')), true);

    const releaseResponse = await worker.fetch(new Request(
      'https://worker.example.test/intercepts/leases/guangdong-sso-auth/run-123',
      {
        method: 'DELETE',
        headers: { authorization: 'Bearer inbox-token' },
      },
    ), env, {});
    assert.equal(releaseResponse.status, 200);
    assert.equal(leaseStorage.has(leaseKey), false);

    assert.equal((await sendWebhook('unleased-message')).status, 200);
    assert.equal(telegramCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCrypto) {
      Object.defineProperty(globalThis, 'crypto', originalCrypto);
    } else {
      delete globalThis.crypto;
    }
  }
});

test('intercept lease writes require the protected inbox bearer token', async () => {
  const { default: worker } = await loadWorker();
  const response = await worker.fetch(new Request(
    'https://worker.example.test/intercepts/leases/telecom-claim-silent/run-123',
    { method: 'PUT' },
  ), {
    INBOX_TOKEN: 'inbox-token',
    FORWARDED_KV: {},
  }, {});

  assert.equal(response.status, 401);
});

test('intercept coordinator keeps a preset active until every workflow lease ends', async () => {
  const { InterceptLeaseCoordinator } = await loadWorker();
  const stored = new Map();
  const coordinator = new InterceptLeaseCoordinator({
    storage: {
      list: async ({ prefix }) => new Map([...stored].filter(([key]) => key.startsWith(prefix))),
      put: async (key, value) => stored.set(key, value),
      delete: async keyOrKeys => {
        for (const key of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) stored.delete(key);
      },
    },
  });
  const put = leaseId => coordinator.fetch(new Request(
    `https://intercept-leases.internal/leases/telecom-claim-silent/${leaseId}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ttlSeconds: 60 }),
    },
  ));
  const remove = leaseId => coordinator.fetch(new Request(
    `https://intercept-leases.internal/leases/telecom-claim-silent/${leaseId}`,
    { method: 'DELETE' },
  ));
  const activePresets = async () => {
    const response = await coordinator.fetch(new Request('https://intercept-leases.internal/active'));
    return (await response.json()).presets;
  };

  await put('run-1');
  await put('run-2');
  await remove('run-1');
  assert.deepEqual(await activePresets(), ['telecom-claim-silent']);
  await remove('run-2');
  assert.deepEqual(await activePresets(), []);

  stored.set('lease:telecom-claim-silent:expired', { expiresAt: Date.now() - 1 });
  assert.deepEqual(await activePresets(), []);
  assert.equal(stored.has('lease:telecom-claim-silent:expired'), false);
});
