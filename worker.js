const PUSHPLUS_BASE_URL = 'https://www.pushplus.plus';
const TELEGRAM_MAX_LENGTH = 3900;
const DEFAULT_POLL_PAGE_SIZE = 20;
const DEFAULT_POLL_LOOKBACK_MINUTES = 60;
const FORWARDED_TTL_SECONDS = 60 * 60 * 24 * 180;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function pushPlusSuccessResponse() {
  return new Response('{"code": 200, "msg": "success"}', {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
    },
  });
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&');
}

function htmlToText(html) {
  return decodeHtmlEntities(String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<\/div\s*>/gi, '\n')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pickField(text, labels) {
  const source = String(text || '');
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = source.match(new RegExp(`${escaped}\\s*[:：]\\s*([^\\n\\r]+)`));
    if (match) return match[1].trim();
  }
  return '';
}

function parseSmsFields(text) {
  return {
    sender: pickField(text, ['发件号码', '发信号码', '发送号码', 'sender', 'from']),
    sentAt: pickField(text, ['发件时间', '发信时间', '发送时间', 'sentAt', 'time']),
  };
}

function escapeTelegramHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildTelegramText(message) {
  const fields = parseSmsFields(message.text);
  return [
    '📩 <b>PushPlus SMS</b>',
    `标题：${escapeTelegramHtml(message.title || '-')}`,
    `发件人：${escapeTelegramHtml(fields.sender || '-')}`,
    `短信时间：${escapeTelegramHtml(fields.sentAt || '-')}`,
    '',
    '<b>完整内容：</b>',
    escapeTelegramHtml(message.text || ''),
  ].join('\n');
}

function splitTelegramText(text, maxLength = TELEGRAM_MAX_LENGTH) {
  const source = String(text || '');
  if (source.length <= maxLength) return [source];
  const chunks = [];
  let rest = source;
  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf('\n', maxLength);
    if (cut < Math.floor(maxLength * 0.6)) cut = maxLength;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input || ''));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function dedupeKey(shortCode, env) {
  return `pushplus:${await sha256Hex(`${env.STATE_SECRET || ''}:${shortCode}`)}`;
}

function pushPlusUrl(env, pathname) {
  const baseUrl = env.PUSHPLUS_BASE_URL || PUSHPLUS_BASE_URL;
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(pathname, base);
}

function numericEnv(env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePushPlusUpdateTime(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    const timestamp = Number(text);
    return timestamp < 1e12 ? timestamp * 1000 : timestamp;
  }
  if (/([zZ]|[+-]\d\d:?\d\d)$/.test(text)) {
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (match) {
    const [, year, month, day, hour, minute, second = '0'] = match;
    return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute), Number(second));
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function fetchPushPlusDetail(env, shortCode) {
  const url = pushPlusUrl(env, `/shortMessage/${encodeURIComponent(shortCode)}`);
  const res = await fetch(url, { headers: { accept: 'text/html, text/plain;q=0.9, */*;q=0.8' } });
  if (!res.ok) throw new Error(`PushPlus detail HTTP ${res.status}`);
  return htmlToText(await res.text());
}

async function getPushPlusAccessKey(env) {
  requireEnv(env, 'PUSHPLUS_TOKEN');
  requireEnv(env, 'PUSHPLUS_SECRET_KEY');
  const res = await fetch(pushPlusUrl(env, '/api/common/openApi/getAccessKey'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      token: env.PUSHPLUS_TOKEN,
      secretKey: env.PUSHPLUS_SECRET_KEY,
    }),
  });
  if (!res.ok) throw new Error(`PushPlus access key HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));
  const accessKey = data?.data?.accessKey;
  if (data?.code !== 200 || !accessKey) {
    throw new Error(`PushPlus access key request failed: ${data?.msg || 'unknown error'}`);
  }
  return accessKey;
}

async function listPushPlusMessages(env, accessKey) {
  const pageSize = Math.max(1, Math.min(numericEnv(env, 'PUSHPLUS_PAGE_SIZE', DEFAULT_POLL_PAGE_SIZE), 50));
  const res = await fetch(pushPlusUrl(env, '/api/open/message/list'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'access-key': accessKey,
    },
    body: JSON.stringify({ current: 1, pageSize }),
  });
  if (!res.ok) throw new Error(`PushPlus message list HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));
  if (data?.code !== 200) throw new Error(`PushPlus message list failed: ${data?.msg || 'unknown error'}`);
  return data?.data?.list || [];
}

async function getPushPlusSendResult(env, accessKey, shortCode) {
  const url = pushPlusUrl(env, '/api/open/message/sendMessageResult');
  url.searchParams.set('shortCode', shortCode);
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'access-key': accessKey,
    },
  });
  if (!res.ok) throw new Error(`PushPlus send result HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));
  if (data?.code !== 200) throw new Error(`PushPlus send result failed: ${data?.msg || 'unknown error'}`);
  return data?.data || {};
}

async function sendTelegram({ env, text }) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`Telegram sendMessage failed: ${data.description || res.status}`);
  }
}

function requireEnv(env, name) {
  if (!env[name]) throw new Error(`Missing env: ${name}`);
}

async function forwardPushPlusMessage(env, message) {
  requireEnv(env, 'TELEGRAM_BOT_TOKEN');
  requireEnv(env, 'TELEGRAM_CHAT_ID');
  requireEnv(env, 'STATE_SECRET');
  if (!env.FORWARDED_KV) throw new Error('Missing KV binding: FORWARDED_KV');

  const shortCode = message.shortCode || '';
  if (!shortCode) return false;
  const key = await dedupeKey(shortCode, env);
  if (await env.FORWARDED_KV.get(key)) return false;

  const text = await fetchPushPlusDetail(env, shortCode);
  if (env.MESSAGE_BODY_KEYWORD && !text.includes(env.MESSAGE_BODY_KEYWORD)) {
    await env.FORWARDED_KV.put(key, 'ignored', { expirationTtl: 60 * 60 * 24 * 30 });
    return false;
  }

  const telegramMessage = { title: message.title || '短信转发', text };
  for (const chunk of splitTelegramText(buildTelegramText(telegramMessage))) {
    await sendTelegram({ env, text: chunk });
  }
  await env.FORWARDED_KV.put(key, new Date().toISOString(), { expirationTtl: FORWARDED_TTL_SECONDS });
  return true;
}

async function pollPushPlusMessages(env) {
  requireEnv(env, 'PUSHPLUS_TOKEN');
  requireEnv(env, 'PUSHPLUS_SECRET_KEY');
  const accessKey = await getPushPlusAccessKey(env);
  const items = await listPushPlusMessages(env, accessKey);
  const lookbackMinutes = numericEnv(env, 'POLL_LOOKBACK_MINUTES', DEFAULT_POLL_LOOKBACK_MINUTES);
  const cutoff = lookbackMinutes > 0 ? Date.now() - lookbackMinutes * 60 * 1000 : 0;
  let matched = 0;
  let forwarded = 0;

  for (const item of items) {
    if (!item?.shortCode) continue;
    if (env.MESSAGE_TITLE_KEYWORD && !String(item.title || '').includes(env.MESSAGE_TITLE_KEYWORD)) continue;
    const receivedAt = parsePushPlusUpdateTime(item.updateTime);
    if (cutoff && receivedAt && receivedAt < cutoff) continue;
    const result = await getPushPlusSendResult(env, accessKey, item.shortCode);
    if (Number(result.status ?? 2) !== 2) continue;

    matched += 1;
    if (await forwardPushPlusMessage(env, item)) forwarded += 1;
  }

  return { scanned: items.length, matched, forwarded };
}

function callbackToken(request, url) {
  const auth = request.headers.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const pathPrefix = '/pushplus/callback/';
  if (url.pathname.startsWith(pathPrefix)) {
    return decodeURIComponent(url.pathname.slice(pathPrefix.length));
  }
  return url.searchParams.get('token') || '';
}

async function processCallback(request, env, url) {
  requireEnv(env, 'CALLBACK_TOKEN');
  requireEnv(env, 'TELEGRAM_BOT_TOKEN');
  requireEnv(env, 'TELEGRAM_CHAT_ID');
  requireEnv(env, 'STATE_SECRET');
  if (!env.FORWARDED_KV) throw new Error('Missing KV binding: FORWARDED_KV');

  const payload = await request.json().catch(() => ({}));
  const messageInfo = payload.messageInfo || {};
  const shortCode = messageInfo.shortCode || payload.shortCode || '';
  const sendStatus = Number(messageInfo.sendStatus ?? payload.sendStatus ?? 2);
  if (!shortCode) return;
  if (sendStatus !== 2) return;
  if (callbackToken(request, url) !== env.CALLBACK_TOKEN) {
    console.warn('PushPlus callback token mismatch; skipped');
    return;
  }
  await forwardPushPlusMessage(env, { shortCode, title: payload.title || '短信转发' });
}

function handleCallback(request, env, ctx) {
  const url = new URL(request.url);
  console.log(JSON.stringify({
    event: 'pushplus_callback_request',
    method: request.method,
    pathKind: url.pathname.startsWith('/pushplus/callback/') ? 'path-token' : 'base',
    hasQueryToken: url.searchParams.has('token'),
    contentType: request.headers.get('content-type') || '',
    userAgent: request.headers.get('user-agent') || '',
  }));
  if (request.method === 'POST') {
    ctx.waitUntil(processCallback(request.clone(), env, url).catch(err => {
      console.error(`PushPlus callback processing failed: ${err.message}`);
    }));
  }
  return pushPlusSuccessResponse();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse({ code: 200, msg: 'ok' });
    }
    if (url.pathname === '/') {
      return pushPlusSuccessResponse();
    }
    if (url.pathname === '/poll') {
      if (callbackToken(request, url) !== env.CALLBACK_TOKEN) {
        return jsonResponse({ code: 401, msg: 'unauthorized' }, 401);
      }
      try {
        return jsonResponse({ code: 200, msg: 'success', data: await pollPushPlusMessages(env) });
      } catch (err) {
        console.error(err.message);
        return jsonResponse({ code: 500, msg: 'internal error' }, 500);
      }
    }
    if (url.pathname === '/pushplus/callback' || url.pathname.startsWith('/pushplus/callback/')) {
      try {
        return handleCallback(request, env, ctx);
      } catch (err) {
        console.error(err.message);
        return jsonResponse({ code: 500, msg: 'internal error' }, 500);
      }
    }
    return jsonResponse({ code: 404, msg: 'not found' }, 404);
  },
  scheduled(event, env, ctx) {
    ctx.waitUntil(pollPushPlusMessages(env).then(result => {
      console.log(JSON.stringify({ event: 'pushplus_poll', ...result }));
    }).catch(err => {
      console.error(`PushPlus poll failed: ${err.message}`);
    }));
  },
};
