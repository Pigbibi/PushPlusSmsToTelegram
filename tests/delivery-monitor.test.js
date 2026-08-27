const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('scheduled monitor checks production ingress quietly', () => {
  const workflow = read('.github/workflows/delivery-monitor.yml');
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /13 \* \* \* \*/);
  assert.match(workflow, /PUSHPLUS_VPS_RELAY_BASE_URL/);
  assert.match(workflow, /sendMessageResult/);
  assert.match(workflow, /getChat/);
  assert.match(workflow, /Relay health monitor/);
  assert.doesNotMatch(workflow, /#SMS/);
  assert.doesNotMatch(workflow, /api\.telegram\.org[^\n]*sendMessage/);
});

test('deployment exposes direct-ingress auth and bounded Telegram retry settings', () => {
  const workflow = read('.github/workflows/deploy.yml');
  const wrangler = read('wrangler.example.toml');
  assert.match(workflow, /secrets\.SMSFORWARDER_WEBHOOK_SECRET/);
  assert.match(workflow, /wrangler secret put SMSFORWARDER_WEBHOOK_SECRET/);
  for (const setting of [
    'SMSFORWARDER_MAX_CLOCK_SKEW_SECONDS',
    'TELEGRAM_RETRY_ATTEMPTS',
    'TELEGRAM_RETRY_DELAY_MS',
    'TELEGRAM_TIMEOUT_MS',
  ]) {
    assert.match(workflow, new RegExp(setting));
    assert.match(wrangler, new RegExp(setting));
  }
});
