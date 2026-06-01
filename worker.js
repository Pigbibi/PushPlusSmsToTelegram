const PUSHPLUS_BASE_URL = 'https://www.pushplus.plus';
const TELEGRAM_MAX_LENGTH = 3900;
const FORWARDED_TTL_SECONDS = 60 * 60 * 24 * 180;
const INBOX_TTL_SECONDS = 60 * 60 * 6;

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

function compactText(text) {
  return String(text || '').replace(/\s+/g, '');
}

function listValue(value) {
  if (Array.isArray(value)) return value.filter(item => item !== undefined && item !== null && item !== '');
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function collectValues(rule, keys) {
  return keys.flatMap(key => listValue(rule[key]));
}

function includesAll(source, expected) {
  const normalized = compactText(source);
  return expected.every(item => normalized.includes(compactText(item)));
}

function includesAny(source, expected) {
  if (!expected.length) return true;
  const normalized = compactText(source);
  return expected.some(item => normalized.includes(compactText(item)));
}

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value || ''));
}

function messageMatchesRule(message, rule) {
  const text = typeof message === 'string' ? message : message?.text || '';
  const title = typeof message === 'string' ? '' : message?.title || '';
  const fields = parseSmsFields(text);
  const sender = fields.sender || (typeof message === 'string' ? '' : message?.sender || '');

  const senderIncludes = collectValues(rule, ['sender', 'senderIncludes']);
  if (senderIncludes.length && !includesAny(sender || text, senderIncludes)) return false;

  const titleIncludesAll = collectValues(rule, ['titleIncludes', 'titleIncludesAll']);
  if (titleIncludesAll.length && !includesAll(title, titleIncludesAll)) return false;

  const titleIncludesAny = collectValues(rule, ['titleIncludesAny']);
  if (titleIncludesAny.length && !includesAny(title, titleIncludesAny)) return false;

  const textIncludesAll = collectValues(rule, ['textIncludes', 'textIncludesAll', 'bodyIncludes', 'bodyIncludesAll']);
  if (textIncludesAll.length && !includesAll(text, textIncludesAll)) return false;

  const textIncludesAny = collectValues(rule, ['textIncludesAny', 'bodyIncludesAny']);
  if (textIncludesAny.length && !includesAny(text, textIncludesAny)) return false;

  return true;
}

function telecomClaimPresetRules(env) {
  const sender = env.TELECOM_SMS_SENDER || '10001';
  const confirmTextIncludes = ['【办理提醒】', '验证码是', '中国电信北京公司', '办理'];
  if (env.TELECOM_CONFIRM_PRODUCT_KEYWORD) confirmTextIncludes.push(env.TELECOM_CONFIRM_PRODUCT_KEYWORD);
  if (env.TELECOM_CONFIRM_PLAN_ID) confirmTextIncludes.push(env.TELECOM_CONFIRM_PLAN_ID);

  return [
    {
      name: 'telecom-claim-login',
      action: 'silence',
      store: true,
      senderIncludes: sender,
      textIncludesAll: ['验证码', '感谢使用北京电信掌上营业厅'],
    },
    {
      name: 'telecom-claim-confirm',
      action: 'silence',
      store: true,
      senderIncludes: sender,
      textIncludesAll: confirmTextIncludes,
    },
  ];
}

function parseCustomRules(value) {
  if (!value) return [];
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function loadInterceptRules(env) {
  const presets = splitCsv(env.SMS_INTERCEPT_PRESETS);
  if (isTruthy(env.TELECOM_CLAIM_SILENT)) presets.push('telecom-claim-silent');

  const rules = [];
  for (const preset of presets) {
    if (preset === 'telecom-claim-silent') {
      rules.push(...telecomClaimPresetRules(env));
    }
  }
  rules.push(...parseCustomRules(env.SMS_INTERCEPT_RULES));
  return rules;
}

function findInterceptRule(message, env) {
  return loadInterceptRules(env).find(rule => messageMatchesRule(message, rule)) || null;
}

function interceptAction(rule) {
  return String(rule?.action || 'silence').toLowerCase();
}

function interceptShouldStore(rule) {
  return rule?.store === true || /store/.test(interceptAction(rule));
}

function interceptShouldSilence(rule) {
  return /silence/.test(interceptAction(rule));
}

function isLabeledLine(line, labels) {
  return labels.some(label => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped}\\s*[:：]`).test(line);
  });
}

function extractSmsContent(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const metadataLabels = [
    '标题',
    '链接',
    '发件号码',
    '发信号码',
    '发送号码',
    '发件时间',
    '发信时间',
    '发送时间',
    '本机号码',
    '开机时长',
    '运营商',
    '信号',
    'sender',
    'from',
    'sentAt',
    'time',
  ];
  const contentLines = [];
  for (const line of lines) {
    if (/^#SMS\b/i.test(line)) {
      if (contentLines.length) break;
      continue;
    }
    if (isLabeledLine(line, metadataLabels)) {
      if (contentLines.length) break;
      continue;
    }
    contentLines.push(line);
  }
  return contentLines.join('\n');
}

function escapeTelegramHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildTelegramText(message) {
  const fields = parseSmsFields(message.text);
  const smsContent = extractSmsContent(message.text);
  return [
    '📩 <b>PushPlus SMS</b>',
    `发件人：${escapeTelegramHtml(fields.sender || '-')}`,
    `发件时间：${escapeTelegramHtml(fields.sentAt || '-')}`,
    '',
    '<b>短信内容：</b>',
    escapeTelegramHtml(smsContent || '-'),
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

async function inboxKey(sourceId, receivedAt, env) {
  return `inbox:${String(receivedAt || Date.now()).padStart(13, '0')}:${await sha256Hex(`${env.STATE_SECRET || ''}:${sourceId}`)}`;
}

function pushPlusUrl(env, pathname) {
  const baseUrl = env.PUSHPLUS_BASE_URL || PUSHPLUS_BASE_URL;
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(pathname, base);
}

async function fetchPushPlusDetail(env, shortCode) {
  const url = pushPlusUrl(env, `/shortMessage/${encodeURIComponent(shortCode)}`);
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

function inboxAuthToken(env) {
  return env.INBOX_TOKEN || env.CALLBACK_TOKEN || '';
}

function authorizeInboxRequest(request, env, url) {
  const expected = inboxAuthToken(env);
  if (!expected) return false;
  const auth = request.headers.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ') && auth.slice(7).trim() === expected) return true;
  return url.searchParams.get('token') === expected;
}

async function storeInboxMessage(env, message) {
  if (!env.FORWARDED_KV) throw new Error('Missing KV binding: FORWARDED_KV');
  const text = message.text || '';
  if (!text) return;
  const fields = parseSmsFields(text);
  const receivedAt = Number(message.receivedAt || Date.now());
  const sourceId = message.sourceId || message.shortCode || message.url || await sha256Hex(`${message.title || ''}\n${text}`);
  await env.FORWARDED_KV.put(await inboxKey(sourceId, receivedAt, env), JSON.stringify({
    id: sourceId,
    sender: fields.sender || '',
    text,
    receivedAt,
    title: message.title || '',
  }), { expirationTtl: INBOX_TTL_SECONDS });
}

async function processMessages(request, env, url) {
  requireEnv(env, 'STATE_SECRET');
  if (!env.FORWARDED_KV) throw new Error('Missing KV binding: FORWARDED_KV');
  if (!authorizeInboxRequest(request, env, url)) {
    return jsonResponse({ code: 401, msg: 'unauthorized' }, 401);
  }

  const since = Number(url.searchParams.get('since') || 0);
  const sender = url.searchParams.get('sender') || '';
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 30), 100));
  const list = await env.FORWARDED_KV.list({ prefix: 'inbox:' });
  const messages = [];
  for (const key of list.keys) {
    const raw = await env.FORWARDED_KV.get(key.name);
    if (!raw) continue;
    const msg = JSON.parse(raw);
    if (since && Number(msg.receivedAt || 0) < since) continue;
    if (sender && !String(msg.sender || msg.text || '').includes(sender)) continue;
    messages.push(msg);
  }
  messages.sort((a, b) => Number(b.receivedAt || 0) - Number(a.receivedAt || 0));
  return jsonResponse({ messages: messages.slice(0, limit) });
}

async function forwardPushPlusMessage(env, message) {
  requireEnv(env, 'STATE_SECRET');
  if (!env.FORWARDED_KV) throw new Error('Missing KV binding: FORWARDED_KV');

  const sourceId = message.sourceId || message.shortCode || message.url || await sha256Hex(`${message.title || ''}\n${message.text || ''}`);
  if (!sourceId) return false;
  const key = await dedupeKey(sourceId, env);
  if (await env.FORWARDED_KV.get(key)) return false;

  let text = message.text || '';
  if (!text && message.shortCode) {
    text = await fetchPushPlusDetail(env, message.shortCode);
  }
  if (!text) return false;
  const interceptRule = findInterceptRule({ ...message, text }, env);
  if (interceptRule) {
    if (interceptShouldStore(interceptRule)) {
      await storeInboxMessage(env, { ...message, text });
    }
    if (interceptShouldSilence(interceptRule)) {
      await env.FORWARDED_KV.put(key, `intercept:${interceptRule.name || 'silence'}`, { expirationTtl: FORWARDED_TTL_SECONDS });
      return false;
    }
  }

  if (env.MESSAGE_TITLE_KEYWORD && !String(message.title || '').includes(env.MESSAGE_TITLE_KEYWORD)) {
    await env.FORWARDED_KV.put(key, 'ignored', { expirationTtl: 60 * 60 * 24 * 30 });
    return false;
  }
  if (env.MESSAGE_BODY_KEYWORD && !text.includes(env.MESSAGE_BODY_KEYWORD)) {
    await env.FORWARDED_KV.put(key, 'ignored', { expirationTtl: 60 * 60 * 24 * 30 });
    return false;
  }

  requireEnv(env, 'TELEGRAM_BOT_TOKEN');
  requireEnv(env, 'TELEGRAM_CHAT_ID');
  const telegramMessage = { title: message.title || '短信转发', text };
  for (const chunk of splitTelegramText(buildTelegramText(telegramMessage))) {
    await sendTelegram({ env, text: chunk });
  }
  await env.FORWARDED_KV.put(key, new Date().toISOString(), { expirationTtl: FORWARDED_TTL_SECONDS });
  return true;
}

function callbackToken(request, url) {
  const auth = request.headers.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  for (const pathPrefix of ['/pushplus/callback/', '/pushplus/webhook/']) {
    if (url.pathname.startsWith(pathPrefix)) {
      return decodeURIComponent(url.pathname.slice(pathPrefix.length));
    }
  }
  return url.searchParams.get('token') || '';
}

function shortCodeFromUrl(url) {
  const match = String(url || '').match(/\/shortMessage\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

async function parseWebhookPayload(request) {
  const contentType = request.headers.get('content-type') || '';
  const raw = await request.text();
  if (contentType.includes('application/json')) {
    return JSON.parse(raw || '{}');
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return { content: raw };
}

async function processCallback(request, env, url) {
  requireEnv(env, 'CALLBACK_TOKEN');
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

async function processWebhook(request, env, url) {
  requireEnv(env, 'CALLBACK_TOKEN');
  if (callbackToken(request, url) !== env.CALLBACK_TOKEN) {
    return jsonResponse({ code: 401, msg: 'unauthorized' }, 401);
  }
  if (request.method !== 'POST') return pushPlusSuccessResponse();

  const payload = await parseWebhookPayload(request);
  const content = payload.content || payload.text || payload.message || '';
  const title = payload.title || payload.messageTitle || pickField(content, ['标题', 'title']) || '短信转发';
  const urlValue = payload.url || payload.messageUrl || pickField(content, ['链接', 'url']) || '';
  const text = htmlToText(content);
  await forwardPushPlusMessage(env, {
    sourceId: payload.shortCode || shortCodeFromUrl(urlValue) || urlValue,
    shortCode: payload.shortCode || shortCodeFromUrl(urlValue),
    title,
    text,
    url: urlValue,
  });
  return pushPlusSuccessResponse();
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
    if (url.pathname === '/pushplus/webhook' || url.pathname.startsWith('/pushplus/webhook/')) {
      try {
        return await processWebhook(request, env, url);
      } catch (err) {
        console.error(err.message);
        return jsonResponse({ code: 500, msg: 'internal error' }, 500);
      }
    }
    if (url.pathname === '/messages' || url.pathname === '/pushplus/messages') {
      try {
        return await processMessages(request, env, url);
      } catch (err) {
        console.error(err.message);
        return jsonResponse({ code: 500, msg: 'internal error' }, 500);
      }
    }
    return jsonResponse({ code: 404, msg: 'not found' }, 404);
  },
};
