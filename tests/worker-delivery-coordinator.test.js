const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { loadWorker, memoryDurableObjects } = require('../test-support/worker');

async function setup(t) {
  const module = await loadWorker({ withCoordinator: false });
  const originalFetch = globalThis.fetch;
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
    else delete globalThis.crypto;
  });
  const values = new Map();
  const kv = { failWrites: false,
    get: async key => values.get(key),
    put: async (key, value) => { if (kv.failWrites) throw new Error('synthetic KV failure'); values.set(key, value); },
  };
  const env = {
    HARDWARE_WEBHOOK_TOKEN: 'synthetic-placeholder', CALLBACK_TOKEN: 'synthetic-placeholder',
    STATE_SECRET: 'synthetic-placeholder', TELEGRAM_BOT_TOKEN: 'synthetic-placeholder',
    TELEGRAM_CHAT_ID: 'synthetic-placeholder', TELEGRAM_RETRY_DELAY_MS: '0', FORWARDED_KV: kv,
  };
  const namespace = memoryDurableObjects(module.InterceptLeaseCoordinator, env);
  env.INTERCEPT_LEASES = namespace;
  const payload = { sourceId: 'synthetic-source', content: 'synthetic ordinary message', sender: 'synthetic-sender', sentAt: '2026-09-08 01:02:03' };
  const send = (overrides = {}) => module.default.fetch(new Request('https://worker.example.invalid/device/webhook', {
    method: 'POST', headers: { authorization: 'Bearer synthetic-placeholder', 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, ...overrides }),
  }), env, {});
  const records = () => [...namespace.storageFor('sms-delivery').data.values()];
  return { module, env, kv, namespace, payload, send, records };
}

function waitForBothLookups(env) {
  let release;
  const bothLookedUp = new Promise(resolve => { release = resolve; });
  const originalGet = env.FORWARDED_KV.get;
  let reads = 0;
  env.FORWARDED_KV.get = async key => {
    const result = await originalGet(key);
    reads += 1;
    if (reads === 4) release();
    return result;
  };
  return bothLookedUp;
}

test('one durable sender owns concurrent copies with the same source ID', async t => {
  const { send, env } = await setup(t);
  let calls = 0;
  const bothLookedUp = waitForBothLookups(env);
  globalThis.fetch = async () => { calls += 1; await bothLookedUp; return Response.json({ ok: true, result: { message_id: calls } }); };
  const responses = await Promise.all([send(), send()]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.equal(calls, 1);
});

test('direct and PushPlus copies serialize on their shared fingerprint', async t => {
  const { module, env, payload, send } = await setup(t);
  let calls = 0;
  const bothLookedUp = waitForBothLookups(env);
  globalThis.fetch = async () => { calls += 1; await bothLookedUp; return Response.json({ ok: true, result: { message_id: calls } }); };
  const pushplus = () => module.default.fetch(new Request('https://worker.example.invalid/pushplus/webhook', {
    method: 'POST', headers: { authorization: 'Bearer synthetic-placeholder', 'content-type': 'application/json' },
    body: JSON.stringify({ shortCode: 'synthetic-other-source', content: `${payload.content}\n发件号码: ${payload.sender}\n发件时间: ${payload.sentAt}\n#SMS` }),
  }), env, {});
  const responses = await Promise.all([send(), pushplus()]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.equal(calls, 1);
});

test('unknown transport outcome survives DO reconstruction without another send', async t => {
  const { send, namespace, records } = await setup(t);
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('synthetic transport uncertainty'); };
  assert.equal((await send()).status, 500);
  namespace.rebuild('sms-delivery');
  assert.equal((await send()).status, 500);
  assert.equal(calls, 1);
  assert.equal(records().every(record => record.state === 'unknown'), true);
  assert.equal(records().length > 0, true);
});

test('completed evidence survives KV failure and DO reconstruction', async t => {
  const { send, kv, namespace, records, payload } = await setup(t);
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({ ok: true, result: { message_id: calls } }); };
  kv.failWrites = true;
  assert.equal((await send()).status, 500);
  assert.equal(records().every(record => record.state === 'completed' && record.confirmedChunks === 1), true);
  assert.equal(records().length > 0, true);
  const persisted = JSON.stringify(records());
  for (const privateValue of [payload.content, payload.sender, 'synthetic-placeholder']) assert.equal(persisted.includes(privateValue), false);
  kv.failWrites = false;
  namespace.rebuild('sms-delivery');
  assert.equal((await send()).status, 200);
  assert.equal(calls, 1);
});

test('missing coordinator or failed durable claim never falls back to KV sending', async t => {
  const { send, env, namespace } = await setup(t);
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({ ok: true, result: { message_id: calls } }); };
  delete env.INTERCEPT_LEASES;
  assert.equal((await send()).status, 500);
  env.INTERCEPT_LEASES = namespace;
  namespace.storageFor('sms-delivery').failTransactions = true;
  assert.equal((await send()).status, 500);
  assert.equal(calls, 0);
});

test('partial multipart delivery retains confirmed count and blocks automatic resend', async t => {
  const { send, namespace, records } = await setup(t);
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls > 1) throw new Error('synthetic transport uncertainty');
    return Response.json({ ok: true, result: { message_id: 1 } });
  };
  const message = { content: 'x'.repeat(4200) };
  assert.equal((await send(message)).status, 500);
  namespace.rebuild('sms-delivery');
  assert.equal((await send(message)).status, 500);
  assert.equal(calls, 2);
  assert.equal(records().length > 0, true);
  assert.equal(records().every(record => record.state === 'unknown' && record.confirmedChunks === 1), true);
});

test('failed receipt persistence leaves a durable no-resend reservation', async t => {
  const { send, namespace } = await setup(t);
  const storage = namespace.storageFor('sms-delivery');
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    storage.failTransactions = true;
    return Response.json({ ok: true, result: { message_id: 1 } });
  };
  assert.equal((await send()).status, 500);
  storage.failTransactions = false;
  namespace.rebuild('sms-delivery');
  assert.equal((await send()).status, 500);
  assert.equal(calls, 1);
});

test('a rejected send has no completed marker and can be retried after correction', async t => {
  const { send, records } = await setup(t);
  globalThis.fetch = async () => Response.json({ ok: false }, { status: 400 });
  assert.equal((await send()).status, 500);
  assert.equal(records().some(record => record.state === 'completed'), false);
  globalThis.fetch = async () => Response.json({ ok: true, result: { message_id: 1 } });
  assert.equal((await send()).status, 200);
});
