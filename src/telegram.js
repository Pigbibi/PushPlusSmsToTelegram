const DEFAULT_TELEGRAM_RETRY_ATTEMPTS = 3;
const DEFAULT_TELEGRAM_RETRY_DELAY_MS = 500;
const DEFAULT_TELEGRAM_TIMEOUT_MS = 8_000;

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function numberSetting(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric env ${name}: ${raw}`);
  return Math.max(min, Math.min(Math.floor(parsed), max));
}

class TelegramDeliveryError extends Error {
  constructor(uncertain) {
    super(uncertain ? 'Telegram delivery outcome unknown' : 'Telegram delivery rejected');
    this.uncertain = uncertain;
  }
}

async function sendTelegramMessage({ botToken, chatId, text }) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok !== true) {
    throw new Error(`Telegram sendMessage failed: ${data.description || res.status}`);
  }
  return data.result;
}

async function sendTelegram({ env, text }) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const attempts = numberSetting(env, 'TELEGRAM_RETRY_ATTEMPTS', DEFAULT_TELEGRAM_RETRY_ATTEMPTS, { min: 1, max: 4 });
  const baseDelayMs = numberSetting(env, 'TELEGRAM_RETRY_DELAY_MS', DEFAULT_TELEGRAM_RETRY_DELAY_MS, { min: 0, max: 5_000 });
  const timeoutMs = numberSetting(env, 'TELEGRAM_TIMEOUT_MS', DEFAULT_TELEGRAM_TIMEOUT_MS, { min: 1_000, max: 10_000 });

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let res;
    let data = {};
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      data = await res.json();
    } catch {
      // A transport failure or an unreadable body leaves the outcome unknown;
      // retrying could duplicate a message Telegram already accepted.
      throw new TelegramDeliveryError(true);
    }
    if (res.ok && data.ok === true && Number.isInteger(data.result?.message_id)) return data.result;
    if (data.ok !== false) throw new TelegramDeliveryError(true);

    const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
    if (!retryable) throw new TelegramDeliveryError(false);
    if (attempt >= attempts) break;

    const retryAfterMs = Number(data?.parameters?.retry_after || 0) * 1000;
    const delayMs = Math.min(5_000, retryAfterMs || baseDelayMs * (2 ** (attempt - 1)));
    if (delayMs > 0) await sleep(delayMs);
  }
  throw new TelegramDeliveryError(false);
}

export {
  DEFAULT_TELEGRAM_TIMEOUT_MS,
  TelegramDeliveryError,
  numberSetting,
  sendTelegram,
  sendTelegramMessage,
};
