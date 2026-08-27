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

test('handled diagnostic requires bearer auth and returns only handled state', async () => {
  const { default: worker } = await loadWorker();
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const stateSecret = 'diagnostic-state-secret';
  const sourceId = 'diagnostic-source-id';
  const expectedKey = await workerDedupeKey(stateSecret, sourceId);
  let requestedKey = '';
  const env = {
    INBOX_TOKEN: 'inbox-token',
    STATE_SECRET: stateSecret,
    FORWARDED_KV: {
      get: async key => {
        requestedKey = key;
        return 'forwarded-at-private-value';
      },
    },
  };
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

  try {
    const unauthorized = await worker.fetch(new Request('https://worker.test/diagnostics/handled', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId }),
    }), env, {});
    assert.equal(unauthorized.status, 401);

    const response = await worker.fetch(new Request('https://worker.test/diagnostics/handled', {
      method: 'POST',
      headers: {
        authorization: 'Bearer inbox-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sourceId }),
    }), env, {});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { code: 200, handled: true });
    assert.equal(requestedKey, expectedKey);
  } finally {
    if (originalCrypto) {
      Object.defineProperty(globalThis, 'crypto', originalCrypto);
    } else {
      delete globalThis.crypto;
    }
  }
});

test('handled diagnostic rejects invalid identifiers and unsupported methods', async () => {
  const { default: worker } = await loadWorker();
  const env = {
    INBOX_TOKEN: 'inbox-token',
    STATE_SECRET: 'diagnostic-state-secret',
    FORWARDED_KV: { get: async () => null },
  };
  const headers = { authorization: 'Bearer inbox-token', 'content-type': 'application/json' };

  const invalid = await worker.fetch(new Request('https://worker.test/diagnostics/handled', {
    method: 'POST',
    headers,
    body: JSON.stringify({ sourceId: 'x'.repeat(257) }),
  }), env, {});
  assert.equal(invalid.status, 400);

  const unsupported = await worker.fetch(new Request('https://worker.test/diagnostics/handled', {
    method: 'GET',
    headers,
  }), env, {});
  assert.equal(unsupported.status, 405);
});

test('Telegram diagnostic uses Worker-held credentials and returns no chat metadata', async () => {
  const { default: worker } = await loadWorker();
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = async url => {
    requestedUrl = String(url);
    return Response.json({
      ok: true,
      result: { id: 'private-chat-id', title: 'private-chat-title' },
    });
  };
  const env = {
    INBOX_TOKEN: 'inbox-token',
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    TELEGRAM_CHAT_ID: 'chat-id',
  };

  try {
    const unauthorized = await worker.fetch(new Request(
      'https://worker.test/diagnostics/telegram',
      { method: 'POST' },
    ), env, {});
    assert.equal(unauthorized.status, 401);

    const response = await worker.fetch(new Request(
      'https://worker.test/diagnostics/telegram',
      { method: 'POST', headers: { authorization: 'Bearer inbox-token' } },
    ), env, {});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { code: 200, reachable: true });
    assert.match(requestedUrl, /\/bottelegram-token\/getChat\?chat_id=chat-id$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
