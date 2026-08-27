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

async function smsForwarderSignature(secret, timestamp) {
  const key = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await webcrypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}\n${secret}`),
  );
  return encodeURIComponent(Buffer.from(signature).toString('base64'));
}

function memoryKv() {
  const stored = new Map();
  return {
    stored,
    binding: {
      get: async key => stored.get(key) || null,
      put: async (key, value) => stored.set(key, value),
    },
  };
}

function smsForwarderRequest(payload) {
  return new Request('https://worker.example.test/smsforwarder/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

test('signed SmsForwarder webhook forwards an ordinary SMS through the shared pipeline', async () => {
  const { default: worker } = await loadWorker();
  const originalFetch = globalThis.fetch;
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const secret = 'smsforwarder-secret';
  const timestamp = Date.now();
  const { stored, binding } = memoryKv();
  const telegramMessages = [];
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(new URL(String(url)).hostname, 'api.telegram.org');
    telegramMessages.push(JSON.parse(options.body).text);
    return Response.json({ ok: true, result: { message_id: 1 } });
  };

  try {
    const response = await worker.fetch(smsForwarderRequest({
      sourceId: 'phone-message-1',
      sender: '19201314985',
      sentAt: '2026/08/28 02:30:00',
      content: '普通短信也必须正常转发',
      timestamp,
      sign: await smsForwarderSignature(secret, timestamp),
    }), {
      SMSFORWARDER_WEBHOOK_SECRET: secret,
      STATE_SECRET: 'state-secret',
      TELEGRAM_BOT_TOKEN: 'telegram-token',
      TELEGRAM_CHAT_ID: 'chat-id',
      MESSAGE_BODY_KEYWORD: '#SMS',
      FORWARDED_KV: binding,
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

  assert.equal(telegramMessages.length, 1);
  assert.match(telegramMessages[0], /发件人：19201314985/);
  assert.match(telegramMessages[0], /普通短信也必须正常转发/);
  assert.equal(stored.size >= 2, true);
});

test('SmsForwarder webhook rejects missing and stale signatures without forwarding', async () => {
  const { default: worker } = await loadWorker();
  const originalFetch = globalThis.fetch;
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const secret = 'smsforwarder-secret';
  let telegramCalls = 0;
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  globalThis.fetch = async () => {
    telegramCalls += 1;
    return Response.json({ ok: true });
  };
  const env = {
    SMSFORWARDER_WEBHOOK_SECRET: secret,
    STATE_SECRET: 'state-secret',
    FORWARDED_KV: memoryKv().binding,
  };

  try {
    const unsigned = await worker.fetch(smsForwarderRequest({
      sender: '10086',
      content: 'unsigned',
      timestamp: Date.now(),
    }), env, {});
    assert.equal(unsigned.status, 401);

    const staleTimestamp = Date.now() - 2 * 60 * 60 * 1000;
    const stale = await worker.fetch(smsForwarderRequest({
      sender: '10086',
      content: 'stale',
      timestamp: staleTimestamp,
      sign: await smsForwarderSignature(secret, staleTimestamp),
    }), env, {});
    assert.equal(stale.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCrypto) {
      Object.defineProperty(globalThis, 'crypto', originalCrypto);
    } else {
      delete globalThis.crypto;
    }
  }

  assert.equal(telegramCalls, 0);
});

test('direct and PushPlus copies of one SMS share a content fingerprint', async () => {
  const { default: worker } = await loadWorker();
  const originalFetch = globalThis.fetch;
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const secret = 'smsforwarder-secret';
  const timestamp = Date.now();
  const { stored, binding } = memoryKv();
  let telegramCalls = 0;
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  globalThis.fetch = async () => {
    telegramCalls += 1;
    return Response.json({ ok: true, result: { message_id: telegramCalls } });
  };
  const env = {
    CALLBACK_TOKEN: 'callback-token',
    SMSFORWARDER_WEBHOOK_SECRET: secret,
    STATE_SECRET: 'state-secret',
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    TELEGRAM_CHAT_ID: 'chat-id',
    MESSAGE_BODY_KEYWORD: '#SMS',
    FORWARDED_KV: binding,
  };

  try {
    const direct = await worker.fetch(smsForwarderRequest({
      sourceId: 'phone-message-2',
      sender: '10086',
      sentAt: '2026/08/28 03:00:00',
      content: '您的余额为100元',
      timestamp,
      sign: await smsForwarderSignature(secret, timestamp),
    }), env, {});
    assert.equal(direct.status, 200);

    const pushPlus = await worker.fetch(new Request(
      'https://worker.example.test/pushplus/webhook/callback-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shortCode: 'pushplus-copy',
          title: '短信转发',
          content: [
            '您的余额为100元',
            '发件号码: 10086',
            '发件时间: 2026/08/28 03:00:00',
            '#SMS',
          ].join('\n'),
        }),
      },
    ), env, {});
    assert.equal(pushPlus.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCrypto) {
      Object.defineProperty(globalThis, 'crypto', originalCrypto);
    } else {
      delete globalThis.crypto;
    }
  }

  assert.equal(telegramCalls, 1);
  assert.equal([...stored.values()].some(value => String(value).startsWith('duplicate:')), true);
});

test('Telegram delivery retries transient failures but does not mark permanent failures', async () => {
  const { default: worker } = await loadWorker();
  const originalFetch = globalThis.fetch;
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const secret = 'smsforwarder-secret';
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

  try {
    const retryKv = memoryKv();
    let retryCalls = 0;
    globalThis.fetch = async () => {
      retryCalls += 1;
      if (retryCalls < 3) return Response.json({ ok: false, description: 'temporary' }, { status: 502 });
      return Response.json({ ok: true, result: { message_id: 3 } });
    };
    const retryTimestamp = Date.now();
    const retryResponse = await worker.fetch(smsForwarderRequest({
      sourceId: 'retry-success',
      sender: '10010',
      sentAt: '2026/08/28 03:10:00',
      content: '重试成功',
      timestamp: retryTimestamp,
      sign: await smsForwarderSignature(secret, retryTimestamp),
    }), {
      SMSFORWARDER_WEBHOOK_SECRET: secret,
      STATE_SECRET: 'state-secret',
      TELEGRAM_BOT_TOKEN: 'telegram-token',
      TELEGRAM_CHAT_ID: 'chat-id',
      TELEGRAM_RETRY_DELAY_MS: '0',
      FORWARDED_KV: retryKv.binding,
    }, {});
    assert.equal(retryResponse.status, 200);
    assert.equal(retryCalls, 3);
    assert.equal(retryKv.stored.size > 0, true);

    const failureKv = memoryKv();
    let failureCalls = 0;
    globalThis.fetch = async () => {
      failureCalls += 1;
      return Response.json({ ok: false, description: 'bad request' }, { status: 400 });
    };
    const failureTimestamp = Date.now();
    const failureResponse = await worker.fetch(smsForwarderRequest({
      sourceId: 'permanent-failure',
      sender: '10000',
      sentAt: '2026/08/28 03:20:00',
      content: '永久失败不应写去重标记',
      timestamp: failureTimestamp,
      sign: await smsForwarderSignature(secret, failureTimestamp),
    }), {
      SMSFORWARDER_WEBHOOK_SECRET: secret,
      STATE_SECRET: 'state-secret',
      TELEGRAM_BOT_TOKEN: 'telegram-token',
      TELEGRAM_CHAT_ID: 'chat-id',
      TELEGRAM_RETRY_DELAY_MS: '0',
      FORWARDED_KV: failureKv.binding,
    }, {});
    assert.equal(failureResponse.status, 500);
    assert.equal(failureCalls, 1);
    assert.equal(failureKv.stored.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCrypto) {
      Object.defineProperty(globalThis, 'crypto', originalCrypto);
    } else {
      delete globalThis.crypto;
    }
  }
});
