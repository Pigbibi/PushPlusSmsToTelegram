import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorker } from '../test-support/worker.js';

test('public route table keeps its paths, methods and bodies', async () => {
  const { default: worker } = await loadWorker({ withCoordinator: false });
  const get = path => worker.fetch(new Request(`https://worker.example.test${path}`), {}, {});

  const health = await get('/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { code: 200, msg: 'ok' });

  const root = await get('/');
  assert.equal(root.status, 200);
  assert.deepEqual(await root.json(), { code: 200, msg: 'success' });
  assert.equal(root.headers.get('access-control-allow-origin'), '*');

  const healthPost = await worker.fetch(new Request('https://worker.example.test/health', { method: 'POST' }), {}, {});
  assert.equal(healthPost.status, 404, '/health answers GET only');

  const unknown = await get('/not-a-route');
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { code: 404, msg: 'not found' });
});

test('a handler that throws answers 500 without leaking the cause', async () => {
  const { default: worker } = await loadWorker({ withCoordinator: false });
  const response = await worker.fetch(new Request('https://worker.example.test/device/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'synthetic' }),
  }), {}, {});

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { code: 500, msg: 'internal error' });
});
