const test = require('node:test');
const assert = require('node:assert/strict');
const { sendTelegramMessage } = require('../src/telegram');

const input = { botToken: 'synthetic-token', chatId: 'synthetic-chat', text: 'synthetic message' };

for (const body of ['not-json', '{}', '{"ok":"true"}', '{"ok":1}']) {
  test(`Telegram sender rejects invalid acknowledgement: ${body}`, async t => {
    const mock = t.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 200 }));
    await assert.rejects(sendTelegramMessage(input), /Telegram sendMessage failed/);
    assert.equal(mock.mock.callCount(), 1);
  });
}

test('Telegram sender returns a confirmed successful result', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true, result: { message_id: 1 } }));
  assert.deepEqual(await sendTelegramMessage(input), { message_id: 1 });
});
