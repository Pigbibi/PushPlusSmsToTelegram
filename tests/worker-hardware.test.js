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

function hardwareRequest(token, payload) {
  return new Request(`https://worker.example.test/device/webhook/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

test('hardware SIM gateway POST JSON forwards through the shared SMS pipeline', async () => {
  const { default: worker } = await loadWorker();
  const originalFetch = globalThis.fetch;
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const { stored, binding } = memoryKv();
  const telegramMessages = [];
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(new URL(String(url)).hostname, 'api.telegram.org');
    telegramMessages.push(JSON.parse(options.body).text);
    return Response.json({ ok: true, result: { message_id: 1 } });
  };

  try {
    const response = await worker.fetch(hardwareRequest('hardware-secret', {
      sender: '19201314985',
      message: '硬件网关收到的普通短信',
      timestamp: '2026-08-28 12:30:00',
    }), {
      HARDWARE_WEBHOOK_TOKEN: 'hardware-secret',
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
  assert.match(telegramMessages[0], /硬件网关收到的普通短信/);
  assert.equal(stored.size >= 2, true);
});

test('hardware webhook rejects an invalid path token before delivery', async () => {
  const { default: worker } = await loadWorker();
  const originalFetch = globalThis.fetch;
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  let telegramCalls = 0;
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  globalThis.fetch = async () => {
    telegramCalls += 1;
    return Response.json({ ok: true });
  };

  try {
    const response = await worker.fetch(hardwareRequest('wrong-secret', {
      sender: '10086',
      message: '不应转发',
      timestamp: '2026-08-28 12:31:00',
    }), {
      HARDWARE_WEBHOOK_TOKEN: 'hardware-secret',
      STATE_SECRET: 'state-secret',
      FORWARDED_KV: memoryKv().binding,
    }, {});
    assert.equal(response.status, 401);
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

test('hardware and PushPlus copies share a fingerprint with gateway field labels', async () => {
  const { default: worker } = await loadWorker();
  const originalFetch = globalThis.fetch;
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const { stored, binding } = memoryKv();
  let telegramCalls = 0;
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  globalThis.fetch = async () => {
    telegramCalls += 1;
    return Response.json({ ok: true, result: { message_id: telegramCalls } });
  };
  const env = {
    CALLBACK_TOKEN: 'callback-token',
    HARDWARE_WEBHOOK_TOKEN: 'hardware-secret',
    STATE_SECRET: 'state-secret',
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    TELEGRAM_CHAT_ID: 'chat-id',
    MESSAGE_BODY_KEYWORD: '#SMS',
    FORWARDED_KV: binding,
  };

  try {
    const direct = await worker.fetch(hardwareRequest('hardware-secret', {
      sender: '10086',
      message: '您的余额为100元',
      timestamp: '2026-08-28 12:32:00',
    }), env, {});
    assert.equal(direct.status, 200);

    const pushPlus = await worker.fetch(new Request(
      'https://worker.example.test/pushplus/webhook/callback-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          shortCode: 'pushplus-hardware-copy',
          title: '短信转发',
          content: [
            '您的余额为100元',
            '发送者: 10086',
            '时间: 2026-08-28 12:32:00',
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
