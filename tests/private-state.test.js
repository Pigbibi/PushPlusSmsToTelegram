const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncState, validateState } = require('../scripts/private-state');
const { saveState } = require('../src/state');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'private-forward-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = { PRIVATE_STATE_BUCKET: 'synthetic-private-state', STATE_FILE: path.join(directory, 'state.json') };
  return { env, file: env.STATE_FILE };
}

test('private state round trip pins reads and writes to the restored generation', t => {
  const { env, file } = fixture(t);
  const state = { forwarded: [{ id: 'a'.repeat(64), forwardedAt: '2026-01-01T00:00:00Z' }] };
  const calls = [];
  const runStorage = args => {
    calls.push(args);
    if (args[0] === 'objects') return '42';
    if (args[0] === 'cat') return JSON.stringify(state);
    assert.ok(args.includes('--if-generation-match=42'));
    assert.deepEqual(JSON.parse(fs.readFileSync(args[1])), state);
    return '';
  };
  syncState('restore', { env, runStorage });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), state);
  assert.match(calls[1][1], /#42$/);
  syncState('persist', { env, runStorage });
});

test('missing, unreadable and corrupt state cannot initialize a new forwarding ledger', t => {
  const { env, file } = fixture(t);
  for (const state of ['', '{}', '{broken', '{"forwarded":[{}]}']) {
    assert.throws(() => syncState('restore', { env,
      runStorage: args => args[0] === 'objects' ? '42' : state }));
    assert.equal(fs.existsSync(file), false);
  }
  assert.throws(() => syncState('restore', { env,
    runStorage: () => { throw new Error('synthetic storage denied'); } }));
  assert.equal(fs.existsSync(file), false);
});

test('conditional write rejection stays a failure and retains restored state', t => {
  const { env, file } = fixture(t);
  syncState('restore', { env, runStorage: args => args[0] === 'objects' ? '42' : '{"forwarded":[]}' });
  assert.throws(() => syncState('persist', { env,
    runStorage: () => { throw new Error('synthetic precondition failure'); } }));
  assert.equal(fs.existsSync(file), true);
});

test('report serialization has no secrets', t => {
  const { file } = fixture(t);
  const token = String(123456789) + ':' + 'A'.repeat(35);
  const chatId = 'synthetic-private-chat';
  const item = { id: 'a'.repeat(64), forwardedAt: '2026-01-01T00:00:00Z', token, chat_id: chatId };
  saveState(file, { token, secret: token, password: token, api_key: token, chat_id: chatId,
    forwarded: [item] });
  const serialized = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(serialized, /\d{6,12}:A[\w-]{34}/);
  assert.equal(serialized.includes(chatId), false);
  function check(value) {
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (['token', 'secret', 'password', 'api_key'].includes(key.toLowerCase())) assert.ok(!item);
        check(item);
      }
    }
  }
  check(JSON.parse(serialized));
  assert.deepEqual(validateState(serialized).forwarded.map(i => i.id), ['a'.repeat(64)]);
});
