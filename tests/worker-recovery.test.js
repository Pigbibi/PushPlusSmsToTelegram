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

async function workerDedupeKey(secret, sourceId) {
  const input = new TextEncoder().encode(`${secret}:${sourceId}`);
  const digest = await webcrypto.subtle.digest('SHA-256', input);
  const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `pushplus:${hex}`;
}

async function runScheduled(worker, event, env) {
  const pending = [];
  await worker.scheduled(event, env, {
    waitUntil: promise => pending.push(promise),
  });
  await Promise.all(pending);
}

test('scheduled recovery forwards the oldest visible failed webhook delivery within its cap', async () => {
  const { default: worker } = await loadWorker();
  const originalFetch = globalThis.fetch;
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const originalNow = Date.now;
  const stateSecret = 'test-state-secret';
  const handledKey = await workerDedupeKey(stateSecret, 'already-handled');
  const recoveredKey = await workerDedupeKey(stateSecret, 'older-unhandled');
  const stored = new Map([[handledKey, '2026-06-06T11:00:00.000Z']]);
  const telegramMessages = [];
  let accessKeyCalls = 0;

  Date.now = () => Date.UTC(2026, 5, 6, 12, 0, 0);
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/common/openApi/getAccessKey') {
      accessKeyCalls += 1;
      return Response.json({ code: 200, msg: 'ok', data: { accessKey: 'access-key', expiresIn: 7200 } });
    }
    if (parsed.pathname === '/api/open/message/list') {
      assert.equal(options.method, 'POST');
      return Response.json({
        code: 200,
        msg: 'ok',
        data: {
          pages: 1,
          list: [
            { shortCode: 'newer-unhandled', title: '短信转发', updateTime: '2026-06-06 19:40:00' },
            { shortCode: 'older-unhandled', title: '短信转发', updateTime: '2026-06-06 19:20:00' },
            { shortCode: 'too-recent', title: '短信转发', updateTime: '2026-06-06 19:55:00' },
            { shortCode: 'already-handled', title: '短信转发', updateTime: '2026-06-06 19:00:00' },
            { shortCode: 'before-baseline', title: '短信转发', updateTime: '2026-06-06 17:00:00' },
            { shortCode: 'other-title', title: 'other', updateTime: '2026-06-06 19:30:00' },
          ],
        },
      });
    }
    if (parsed.pathname === '/api/open/message/sendMessageResult') {
      assert.equal(parsed.searchParams.get('shortCode'), 'older-unhandled');
      return Response.json({ code: 200, msg: 'ok', data: { status: 3, errorMessage: 'connect timed out' } });
    }
    if (parsed.pathname === '/shortMessage/older-unhandled') {
      return new Response('#SMS\n发件号码: 10086\n发件时间: 2026-06-06 19:20:00\n恢复测试');
    }
    if (parsed.hostname === 'api.telegram.org') {
      telegramMessages.push(JSON.parse(options.body).text);
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected fetch ${parsed.pathname}`);
  };

  try {
    await runScheduled(worker, { cron: '3,13,23,33,43,53 * * * *' }, {
      PUSHPLUS_RECOVERY_ENABLED: 'true',
      PUSHPLUS_RECOVERY_NOT_BEFORE: '2026-06-06T10:00:00.000Z',
      PUSHPLUS_RECOVERY_MIN_AGE_MINUTES: '0',
      PUSHPLUS_RECOVERY_MAX_MESSAGES: '1',
      PUSHPLUS_RECOVERY_TITLE_KEYWORD: '短信转发',
      MESSAGE_BODY_KEYWORD: '#SMS',
      PUSHPLUS_TOKEN: 'token',
      PUSHPLUS_SECRET_KEY: 'secret-key',
      STATE_SECRET: stateSecret,
      TELEGRAM_BOT_TOKEN: 'telegram-token',
      TELEGRAM_CHAT_ID: 'chat-id',
      FORWARDED_KV: {
        get: async key => stored.get(key) || null,
        put: async (key, value) => stored.set(key, value),
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCrypto) {
      Object.defineProperty(globalThis, 'crypto', originalCrypto);
    } else {
      delete globalThis.crypto;
    }
    Date.now = originalNow;
  }

  assert.equal(telegramMessages.length, 2);
  assert.match(telegramMessages[0], /恢复测试/);
  assert.match(telegramMessages[1], /Recovered 1 message/);
  assert.equal(stored.has(recoveredKey), true);
  assert.equal(accessKeyCalls, 1);
});

test('scheduled recovery is fail-closed without an activation baseline', async () => {
  const { default: worker } = await loadWorker();
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error('recovery must not fetch without a baseline');
  };

  try {
    await runScheduled(worker, { cron: '3,13,23,33,43,53 * * * *' }, {
      PUSHPLUS_RECOVERY_ENABLED: 'true',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetched, false);
});

test('scheduled recovery refreshes a cached PushPlus access key once after rejection', async () => {
  const { default: worker } = await loadWorker();
  const originalFetch = globalThis.fetch;
  let accessKeyCalls = 0;
  let listCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/common/openApi/getAccessKey') {
      accessKeyCalls += 1;
      return Response.json({
        code: 200,
        msg: 'ok',
        data: { accessKey: `access-key-${accessKeyCalls}`, expiresIn: 7200 },
      });
    }
    if (parsed.pathname === '/api/open/message/list') {
      listCalls += 1;
      if (listCalls === 2) return Response.json({ code: 401, msg: 'expired access key' });
      assert.equal(options.headers['access-key'], `access-key-${accessKeyCalls}`);
      return Response.json({ code: 200, msg: 'ok', data: { pages: 1, list: [] } });
    }
    throw new Error(`unexpected fetch ${parsed.pathname}`);
  };

  const env = {
    PUSHPLUS_RECOVERY_ENABLED: 'true',
    PUSHPLUS_RECOVERY_NOT_BEFORE: '2026-06-06T10:00:00.000Z',
    PUSHPLUS_TOKEN: 'token',
    PUSHPLUS_SECRET_KEY: 'secret-key',
    FORWARDED_KV: { get: async () => null, put: async () => {} },
  };
  try {
    await runScheduled(worker, { cron: '3,13,23,33,43,53 * * * *' }, env);
    await runScheduled(worker, { cron: '3,13,23,33,43,53 * * * *' }, env);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(accessKeyCalls, 2);
  assert.equal(listCalls, 3);
});

test('failed-only recovery skips messages PushPlus reports as delivered', async () => {
  const { default: worker } = await loadWorker();
  const originalFetch = globalThis.fetch;
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const originalNow = Date.now;
  const stateSecret = 'test-state-secret';
  const racingKey = await workerDedupeKey(stateSecret, 'racing-message');
  let keyReads = 0;
  let deliveryCalls = 0;

  Date.now = () => Date.UTC(2026, 5, 6, 12, 0, 0);
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/common/openApi/getAccessKey') {
      return Response.json({ code: 200, msg: 'ok', data: { accessKey: 'access-key' } });
    }
    if (parsed.pathname === '/api/open/message/list') {
      return Response.json({
        code: 200,
        msg: 'ok',
        data: {
          pages: 1,
          list: [
            { shortCode: 'racing-message', title: '短信转发', updateTime: '2026-06-06 19:30:00' },
          ],
        },
      });
    }
    if (parsed.pathname === '/api/open/message/sendMessageResult') {
      return Response.json({ code: 200, msg: 'ok', data: { status: 2, errorMessage: '' } });
    }
    deliveryCalls += 1;
    throw new Error(`unexpected delivery fetch ${parsed.pathname}`);
  };

  try {
    await runScheduled(worker, { cron: '3,13,23,33,43,53 * * * *' }, {
      PUSHPLUS_RECOVERY_ENABLED: 'true',
      PUSHPLUS_RECOVERY_NOT_BEFORE: '2026-06-06T10:00:00.000Z',
      PUSHPLUS_TOKEN: 'token',
      PUSHPLUS_SECRET_KEY: 'secret-key',
      STATE_SECRET: stateSecret,
      TELEGRAM_BOT_TOKEN: 'telegram-token',
      TELEGRAM_CHAT_ID: 'chat-id',
      FORWARDED_KV: {
        get: async key => {
          if (key !== racingKey) return null;
          keyReads += 1;
          return null;
        },
        put: async () => {},
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCrypto) {
      Object.defineProperty(globalThis, 'crypto', originalCrypto);
    } else {
      delete globalThis.crypto;
    }
    Date.now = originalNow;
  }

  assert.equal(keyReads, 1);
  assert.equal(deliveryCalls, 0);
});

test('unhandled recovery forwards a locally missing message without trusting delivered status', async () => {
  const { default: worker } = await loadWorker();
  const originalFetch = globalThis.fetch;
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const originalNow = Date.now;
  const stateSecret = 'test-state-secret';
  const recoveredKey = await workerDedupeKey(stateSecret, 'delivered-but-unhandled');
  const stored = new Map();
  let statusQueries = 0;
  let telegramCalls = 0;

  Date.now = () => Date.UTC(2026, 5, 6, 12, 0, 0);
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/common/openApi/getAccessKey') {
      return Response.json({ code: 200, msg: 'ok', data: { accessKey: 'access-key' } });
    }
    if (parsed.pathname === '/api/open/message/list') {
      return Response.json({
        code: 200,
        msg: 'ok',
        data: {
          pages: 1,
          list: [
            {
              shortCode: 'delivered-but-unhandled',
              title: '短信转发',
              updateTime: '2026-06-06 19:30:00',
            },
          ],
        },
      });
    }
    if (parsed.pathname === '/api/open/message/sendMessageResult') {
      statusQueries += 1;
      return Response.json({ code: 200, msg: 'ok', data: { status: 2, errorMessage: '' } });
    }
    if (parsed.pathname === '/shortMessage/delivered-but-unhandled') {
      return new Response('#SMS\n发件号码: 10086\n发件时间: 2026-06-06 19:30:00\n本地未处理补漏');
    }
    if (parsed.hostname === 'api.telegram.org') {
      telegramCalls += 1;
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected fetch ${parsed.pathname}`);
  };

  try {
    await runScheduled(worker, { cron: '3,13,23,33,43,53 * * * *' }, {
      PUSHPLUS_RECOVERY_ENABLED: 'true',
      PUSHPLUS_RECOVERY_MODE: 'unhandled',
      PUSHPLUS_RECOVERY_ALERT_ENABLED: 'false',
      PUSHPLUS_RECOVERY_NOT_BEFORE: '2026-06-06T10:00:00.000Z',
      PUSHPLUS_RECOVERY_TITLE_KEYWORD: '短信转发',
      MESSAGE_BODY_KEYWORD: '#SMS',
      PUSHPLUS_TOKEN: 'token',
      PUSHPLUS_SECRET_KEY: 'secret-key',
      STATE_SECRET: stateSecret,
      TELEGRAM_BOT_TOKEN: 'telegram-token',
      TELEGRAM_CHAT_ID: 'chat-id',
      FORWARDED_KV: {
        get: async key => stored.get(key) || null,
        put: async (key, value) => stored.set(key, value),
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCrypto) {
      Object.defineProperty(globalThis, 'crypto', originalCrypto);
    } else {
      delete globalThis.crypto;
    }
    Date.now = originalNow;
  }

  assert.equal(statusQueries, 0);
  assert.equal(telegramCalls, 1);
  assert.equal(stored.has(recoveredKey), true);
});

test('recovery trigger never runs record cleanup', async () => {
  const { default: worker } = await loadWorker();
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error('recovery trigger must not run cleanup');
  };

  try {
    await runScheduled(worker, { cron: '3,13,23,33,43,53 * * * *' }, {
      PUSHPLUS_CLEANUP_ENABLED: 'true',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetched, false);
});

test('recovery summary can be disabled without disabling delivery', async () => {
  const { default: worker } = await loadWorker();
  const originalFetch = globalThis.fetch;
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const originalNow = Date.now;
  let telegramCalls = 0;

  Date.now = () => Date.UTC(2026, 5, 6, 12, 0, 0);
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/common/openApi/getAccessKey') {
      return Response.json({ code: 200, msg: 'ok', data: { accessKey: 'access-key' } });
    }
    if (parsed.pathname === '/api/open/message/list') {
      return Response.json({
        code: 200,
        msg: 'ok',
        data: {
          pages: 1,
          list: [
            { shortCode: 'alert-disabled', title: '短信转发', updateTime: '2026-06-06 19:30:00' },
          ],
        },
      });
    }
    if (parsed.pathname === '/api/open/message/sendMessageResult') {
      return Response.json({ code: 200, msg: 'ok', data: { status: 3, errorMessage: 'connect timed out' } });
    }
    if (parsed.pathname === '/shortMessage/alert-disabled') {
      return new Response('#SMS\n发件号码: 10086\n关闭恢复摘要测试');
    }
    if (parsed.hostname === 'api.telegram.org') {
      telegramCalls += 1;
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected fetch ${parsed.pathname}`);
  };

  try {
    const stored = new Map();
    await runScheduled(worker, { cron: '3,13,23,33,43,53 * * * *' }, {
      PUSHPLUS_RECOVERY_ENABLED: 'true',
      PUSHPLUS_RECOVERY_ALERT_ENABLED: 'false',
      PUSHPLUS_RECOVERY_NOT_BEFORE: '2026-06-06T10:00:00.000Z',
      PUSHPLUS_TOKEN: 'token',
      PUSHPLUS_SECRET_KEY: 'secret-key',
      STATE_SECRET: 'test-state-secret',
      TELEGRAM_BOT_TOKEN: 'telegram-token',
      TELEGRAM_CHAT_ID: 'chat-id',
      FORWARDED_KV: {
        get: async key => stored.get(key) || null,
        put: async (key, value) => stored.set(key, value),
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCrypto) {
      Object.defineProperty(globalThis, 'crypto', originalCrypto);
    } else {
      delete globalThis.crypto;
    }
    Date.now = originalNow;
  }

  assert.equal(telegramCalls, 1);
});

test('deployment exposes recovery without a maintainer-specific endpoint', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'deploy.yml'), 'utf8');
  const wrangler = fs.readFileSync(path.join(__dirname, '..', 'wrangler.example.toml'), 'utf8');
  const settings = [
    'PUSHPLUS_RECOVERY_ENABLED',
    'PUSHPLUS_RECOVERY_MODE',
    'PUSHPLUS_RECOVERY_NOT_BEFORE',
    'PUSHPLUS_RECOVERY_LOOKBACK_HOURS',
    'PUSHPLUS_RECOVERY_MIN_AGE_MINUTES',
    'PUSHPLUS_RECOVERY_PAGE_SIZE',
    'PUSHPLUS_RECOVERY_MAX_PAGES',
    'PUSHPLUS_RECOVERY_MAX_MESSAGES',
    'PUSHPLUS_RECOVERY_TITLE_KEYWORD',
    'PUSHPLUS_RECOVERY_ALERT_ENABLED',
  ];

  for (const setting of settings) {
    assert.match(workflow, new RegExp(setting));
    assert.match(wrangler, new RegExp(setting));
  }
  assert.match(wrangler, /"3,13,23,33,43,53 \* \* \* \*"/);
  assert.match(wrangler, /"17 3 \* \* \*"/);
  assert.doesNotMatch(workflow, /sslip\.io|43\.156\.238\.238/);
  assert.doesNotMatch(wrangler, /sslip\.io|43\.156\.238\.238/);
});
