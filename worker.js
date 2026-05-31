const PUSHPLUS_BASE_URL = 'https://www.pushplus.plus';
const TELEGRAM_MAX_LENGTH = 3900;

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

async function fetchPushPlusDetail(shortCode) {
  const url = `${PUSHPLUS_BASE_URL}/shortMessage/${encodeURIComponent(shortCode)}`;
  const res = await fetch(url, { headers: { accept: 'text/html, text/plain;q=0.9, */*;q=0.8' } });
  if (!res.ok) throw new Error(`PushPlus detail HTTP ${res.status}`);
  return htmlToText(await res.text());
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

  const key = await dedupeKey(shortCode, env);
  if (await env.FORWARDED_KV.get(key)) return;

  const text = await fetchPushPlusDetail(shortCode);
  if (env.MESSAGE_BODY_KEYWORD && !text.includes(env.MESSAGE_BODY_KEYWORD)) {
    await env.FORWARDED_KV.put(key, 'ignored', { expirationTtl: 60 * 60 * 24 * 30 });
    return;
  }

  const message = { title: payload.title || '短信转发', text };
  for (const chunk of splitTelegramText(buildTelegramText(message))) {
    await sendTelegram({ env, text: chunk });
  }
  await env.FORWARDED_KV.put(key, new Date().toISOString(), { expirationTtl: 60 * 60 * 24 * 180 });
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
};
