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

test('scheduled cleanup deletes only old forwarded PushPlus messages', async () => {
  const { default: worker } = await loadWorker();
  const originalFetch = globalThis.fetch;
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const originalNow = Date.now;
  const deleted = [];
  const stateSecret = 'test-state-secret';
  const forwardedKey = await workerDedupeKey(stateSecret, 'old-forwarded');

  Date.now = () => Date.UTC(2026, 5, 6, 0, 0, 0);
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/common/openApi/getAccessKey') {
      return Response.json({ code: 200, msg: 'ok', data: { accessKey: 'access-key' } });
    }
    if (parsed.pathname === '/api/open/message/list') {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['access-key'], 'access-key');
      return Response.json({
        code: 200,
        msg: 'ok',
        data: {
          pages: 1,
          list: [
            { shortCode: 'old-forwarded', title: '短信转发', updateTime: '2026-02-01 00:00:00' },
            { shortCode: 'new-forwarded', title: '短信转发', updateTime: '2026-06-01 00:00:00' },
            { shortCode: 'old-unforwarded', title: '短信转发', updateTime: '2026-02-01 00:00:00' },
            { shortCode: 'old-other-title', title: 'other', updateTime: '2026-02-01 00:00:00' },
          ],
        },
      });
    }
    if (parsed.pathname === '/api/open/message/deleteMessage') {
      assert.equal(options.method, 'DELETE');
      assert.equal(options.headers['access-key'], 'access-key');
      deleted.push(parsed.searchParams.get('shortCode'));
      return Response.json({ code: 200, msg: 'ok' });
    }
    throw new Error(`unexpected fetch ${parsed.pathname}`);
  };

  try {
    const pending = [];
    await worker.scheduled({}, {
      PUSHPLUS_CLEANUP_ENABLED: 'true',
      PUSHPLUS_CLEANUP_RETENTION_DAYS: '90',
      PUSHPLUS_CLEANUP_TITLE_KEYWORD: '短信转发',
      PUSHPLUS_TOKEN: 'token',
      PUSHPLUS_SECRET_KEY: 'secret-key',
      STATE_SECRET: stateSecret,
      FORWARDED_KV: {
        get: async key => (key === forwardedKey ? '2026-02-01T00:00:00.000Z' : null),
      },
    }, {
      waitUntil: promise => pending.push(promise),
    });
    await Promise.all(pending);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCrypto) {
      Object.defineProperty(globalThis, 'crypto', originalCrypto);
    } else {
      delete globalThis.crypto;
    }
    Date.now = originalNow;
  }

  assert.deepEqual(deleted, ['old-forwarded']);
});

test('scheduled cleanup is disabled by default', async () => {
  const { default: worker } = await loadWorker();
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error('cleanup should not fetch when disabled');
  };

  try {
    const pending = [];
    await worker.scheduled({}, {}, {
      waitUntil: promise => pending.push(promise),
    });
    await Promise.all(pending);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetched, false);
});
