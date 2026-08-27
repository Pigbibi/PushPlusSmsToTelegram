const PUSHPLUS_BASE_URL = 'https://www.pushplus.plus';
const TELEGRAM_MAX_LENGTH = 3900;
const FORWARDED_TTL_SECONDS = 60 * 60 * 24 * 180;
const INBOX_TTL_SECONDS = 60 * 60 * 6;
const DEFAULT_CLEANUP_RETENTION_DAYS = 90;
const DEFAULT_CLEANUP_PAGE_SIZE = 50;
const DEFAULT_CLEANUP_MAX_PAGES = 10;
const DEFAULT_CLEANUP_MAX_DELETES = 20;
const DEFAULT_RECOVERY_LOOKBACK_HOURS = 48;
const DEFAULT_RECOVERY_MIN_AGE_MINUTES = 10;
const DEFAULT_RECOVERY_PAGE_SIZE = 50;
const DEFAULT_RECOVERY_MAX_PAGES = 2;
const DEFAULT_RECOVERY_MAX_MESSAGES = 20;
const RECOVERY_CRON = '31 * * * *';
const CLEANUP_CRON = '17 3 * * *';
const PUSHPLUS_ACCESS_KEY_REFRESH_MARGIN_SECONDS = 5 * 60;
const INTERCEPT_LEASE_STORAGE_PREFIX = 'lease:';
const DEFAULT_INTERCEPT_LEASE_TTL_SECONDS = 60 * 60;
const MAX_INTERCEPT_LEASE_TTL_SECONDS = 2 * 60 * 60;
const DEFAULT_SMSFORWARDER_MAX_CLOCK_SKEW_SECONDS = 60 * 60;
const DEFAULT_TELEGRAM_RETRY_ATTEMPTS = 3;
const DEFAULT_TELEGRAM_RETRY_DELAY_MS = 500;
const DEFAULT_TELEGRAM_TIMEOUT_MS = 8_000;
const LEASED_INTERCEPT_PRESETS = new Set([
  'telecom-claim-silent',
  'guangdong-sso-auth',
]);
let pushPlusAccessKeyCache = null;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export class InterceptLeaseCoordinator {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async pruneExpired(now = Date.now()) {
    const leases = await this.ctx.storage.list({ prefix: INTERCEPT_LEASE_STORAGE_PREFIX });
    const expired = [];
    for (const [key, value] of leases) {
      if (!Number(value?.expiresAt) || Number(value.expiresAt) <= now) expired.push(key);
    }
    if (expired.length) await this.ctx.storage.delete(expired);
    return leases;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    const leases = await this.pruneExpired(now);
    if (request.method === 'GET' && url.pathname === '/active') {
      const presets = new Set();
      for (const [key, value] of leases) {
        if (Number(value?.expiresAt) <= now) continue;
        const suffix = String(key).slice(INTERCEPT_LEASE_STORAGE_PREFIX.length);
        const separator = suffix.indexOf(':');
        const preset = separator === -1 ? '' : suffix.slice(0, separator);
        if (LEASED_INTERCEPT_PRESETS.has(preset)) presets.add(preset);
      }
      return jsonResponse({ code: 200, presets: [...presets] });
    }

    const parsed = parseInterceptLeasePath(url.pathname.replace(/^\/leases/, '/intercepts/leases'));
    if (!parsed) return jsonResponse({ code: 404, msg: 'not found' }, 404);
    if (parsed.error) return jsonResponse({ code: 400, msg: parsed.error }, 400);
    const key = `${INTERCEPT_LEASE_STORAGE_PREFIX}${parsed.preset}:${parsed.leaseId}`;
    if (request.method === 'PUT') {
      const body = await request.json().catch(() => ({}));
      const requestedTtl = body.ttlSeconds === undefined
        ? DEFAULT_INTERCEPT_LEASE_TTL_SECONDS
        : Number(body.ttlSeconds);
      if (!Number.isFinite(requestedTtl) || requestedTtl < 60) {
        return jsonResponse({ code: 400, msg: 'invalid ttlSeconds' }, 400);
      }
      const ttlSeconds = Math.min(Math.floor(requestedTtl), MAX_INTERCEPT_LEASE_TTL_SECONDS);
      const expiresAtMs = now + ttlSeconds * 1000;
      await this.ctx.storage.put(key, { expiresAt: expiresAtMs });
      return jsonResponse({
        code: 200,
        msg: 'ok',
        preset: parsed.preset,
        active: true,
        expiresAt: new Date(expiresAtMs).toISOString(),
      });
    }
    if (request.method === 'DELETE') {
      await this.ctx.storage.delete(key);
      return jsonResponse({ code: 200, msg: 'ok', preset: parsed.preset, active: false });
    }
    return jsonResponse({ code: 405, msg: 'method not allowed' }, 405);
  }
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

function numberEnv(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric env ${name}: ${raw}`);
  return Math.max(min, Math.min(Math.floor(parsed), max));
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
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const [, year, month, day, hour, minute, second = '0'] = m;
    return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute), Number(second));
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? 0 : parsed;
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
  const successSender = env.TELECOM_SUCCESS_SMS_SENDER || '10000';
  const confirmTextIncludes = ['【办理提醒】', '验证码是', '中国电信北京公司', '办理'];
  const successTextIncludes = ['【办理提醒】', 'wap电子渠道', '成功办理', '方案编号'];
  if (env.TELECOM_CONFIRM_PRODUCT_KEYWORD) confirmTextIncludes.push(env.TELECOM_CONFIRM_PRODUCT_KEYWORD);
  if (env.TELECOM_CONFIRM_PLAN_ID) confirmTextIncludes.push(env.TELECOM_CONFIRM_PLAN_ID);
  if (env.TELECOM_CONFIRM_PRODUCT_KEYWORD) successTextIncludes.push(env.TELECOM_CONFIRM_PRODUCT_KEYWORD);
  if (env.TELECOM_CONFIRM_PLAN_ID) successTextIncludes.push(env.TELECOM_CONFIRM_PLAN_ID);

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
    {
      name: 'telecom-claim-success',
      action: 'silence',
      store: true,
      senderIncludes: successSender,
      textIncludesAll: successTextIncludes,
    },
  ];
}

function guangdongSsoPresetRules(env) {
  const rule = {
    name: 'guangdong-sso-auth',
    action: 'silence-store',
    textIncludesAll: ['验证码'],
    textIncludesAny: ['统一身份认证', '广东政务服务', '粤省事', '政务服务网'],
  };
  if (env.GUANGDONG_SMS_SENDER) rule.senderIncludes = env.GUANGDONG_SMS_SENDER;
  if (env.GUANGDONG_SMS_KEYWORD) rule.textIncludesAny = [env.GUANGDONG_SMS_KEYWORD];
  return [rule];
}

function interceptPresetRules(preset, env) {
  if (preset === 'telecom-claim-silent') return telecomClaimPresetRules(env);
  if (preset === 'guangdong-sso-auth') return guangdongSsoPresetRules(env);
  return [];
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
  for (const preset of new Set(presets)) {
    rules.push(...interceptPresetRules(preset, env));
  }
  rules.push(...parseCustomRules(env.SMS_INTERCEPT_RULES));
  return rules;
}

function findInterceptRule(message, env) {
  return loadInterceptRules(env).find(rule => messageMatchesRule(message, rule)) || null;
}

function interceptLeaseCoordinator(env) {
  if (!env.INTERCEPT_LEASES) throw new Error('Missing Durable Object binding: INTERCEPT_LEASES');
  if (typeof env.INTERCEPT_LEASES.getByName === 'function') {
    return env.INTERCEPT_LEASES.getByName('global');
  }
  const id = env.INTERCEPT_LEASES.idFromName('global');
  return env.INTERCEPT_LEASES.get(id);
}

async function activeInterceptLeasePresets(env) {
  if (!env.INTERCEPT_LEASES) return [];
  const response = await interceptLeaseCoordinator(env).fetch('https://intercept-leases.internal/active');
  if (!response.ok) throw new Error(`Intercept lease lookup failed: HTTP ${response.status}`);
  const data = await response.json();
  return Array.isArray(data.presets) ? data.presets : [];
}

async function findEffectiveInterceptRule(message, env) {
  const staticRule = findInterceptRule(message, env);
  if (staticRule) return staticRule;
  const leasedPresets = await activeInterceptLeasePresets(env);
  if (!leasedPresets.length) return null;
  const leasedRules = leasedPresets.flatMap(preset => interceptPresetRules(preset, env));
  return leasedRules.find(rule => messageMatchesRule(message, rule)) || null;
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
    `📩 <b>${escapeTelegramHtml(message.sourceLabel || 'PushPlus SMS')}</b>`,
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

async function messageSourceIds(message, text) {
  const sourceIds = new Set();
  const explicitSourceId = message.sourceId || message.shortCode || message.url || '';
  if (explicitSourceId) sourceIds.add(String(explicitSourceId));
  if (message.shortCode) sourceIds.add(String(message.shortCode));
  if (!sourceIds.size && text) {
    sourceIds.add(`content:${await sha256Hex(`${message.title || ''}\n${text}`)}`);
  }

  const fields = parseSmsFields(text);
  const content = extractSmsContent(text).trim();
  const sender = String(fields.sender || '').replace(/\s+/g, '');
  const sentAtDigits = String(fields.sentAt || '').replace(/\D/g, '').slice(0, 14);
  if (sender && sentAtDigits.length >= 12 && content) {
    const fingerprint = await sha256Hex([
      'sms-fingerprint-v1',
      sender,
      sentAtDigits,
      content.replace(/\r\n/g, '\n'),
    ].join('\n'));
    sourceIds.add(`sms-fingerprint:${fingerprint}`);
  }
  return [...sourceIds];
}

async function dedupeKeys(sourceIds, env) {
  return Promise.all(sourceIds.map(sourceId => dedupeKey(sourceId, env)));
}

async function existingDedupeValue(keys, env) {
  for (const key of keys) {
    const value = await env.FORWARDED_KV.get(key);
    if (value) return value;
  }
  return '';
}

async function putDedupeKeys(keys, value, env, expirationTtl = FORWARDED_TTL_SECONDS) {
  await Promise.all(keys.map(key => env.FORWARDED_KV.put(key, value, { expirationTtl })));
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

async function pushPlusJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(`PushPlus HTTP ${res.status} ${new URL(url).pathname}`);
  if (data?.code !== 200) throw new Error(`PushPlus API failed: ${data?.msg || 'unknown error'}`);
  return data;
}

async function getPushPlusAccessKey(env, forceRefresh = false) {
  requireEnv(env, 'PUSHPLUS_TOKEN');
  requireEnv(env, 'PUSHPLUS_SECRET_KEY');
  const baseUrl = String(env.PUSHPLUS_BASE_URL || PUSHPLUS_BASE_URL);
  if (
    !forceRefresh
    && pushPlusAccessKeyCache?.token === env.PUSHPLUS_TOKEN
    && pushPlusAccessKeyCache?.baseUrl === baseUrl
    && pushPlusAccessKeyCache?.expiresAt > Date.now()
  ) {
    return pushPlusAccessKeyCache.accessKey;
  }
  const data = await pushPlusJson(pushPlusUrl(env, '/api/common/openApi/getAccessKey'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ token: env.PUSHPLUS_TOKEN, secretKey: env.PUSHPLUS_SECRET_KEY }),
  });
  const accessKey = data?.data?.accessKey;
  if (!accessKey) throw new Error('PushPlus access key response missing accessKey');
  const rawExpiresIn = Number(data?.data?.expiresIn);
  const expiresIn = Number.isFinite(rawExpiresIn) && rawExpiresIn > 0
    ? rawExpiresIn
    : 2 * 60 * 60;
  const cacheSeconds = Math.max(60, expiresIn - PUSHPLUS_ACCESS_KEY_REFRESH_MARGIN_SECONDS);
  pushPlusAccessKeyCache = {
    accessKey,
    baseUrl,
    expiresAt: Date.now() + cacheSeconds * 1000,
    token: env.PUSHPLUS_TOKEN,
  };
  return accessKey;
}

async function withPushPlusAccessKey(env, operation) {
  const accessKey = await getPushPlusAccessKey(env);
  try {
    return await operation(accessKey);
  } catch (firstError) {
    const refreshedAccessKey = await getPushPlusAccessKey(env, true);
    try {
      return await operation(refreshedAccessKey);
    } catch (retryError) {
      throw new Error(`${retryError.message}; retry after access-key refresh failed`, { cause: firstError });
    }
  }
}

async function listPushPlusMessages(env, accessKey, current, pageSize) {
  const data = await pushPlusJson(pushPlusUrl(env, '/api/open/message/list'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'access-key': accessKey,
    },
    body: JSON.stringify({ current, pageSize }),
  });
  return {
    items: data?.data?.list || [],
    pages: Number(data?.data?.pages || 0),
  };
}

async function getPushPlusMessageResult(env, accessKey, shortCode) {
  const url = pushPlusUrl(env, '/api/open/message/sendMessageResult');
  url.searchParams.set('shortCode', shortCode);
  const data = await pushPlusJson(url, {
    headers: { accept: 'application/json', 'access-key': accessKey },
  });
  return {
    errorMessage: String(data?.data?.errorMessage || ''),
    status: Number(data?.data?.status),
  };
}

async function deletePushPlusMessage(env, accessKey, shortCode) {
  const url = pushPlusUrl(env, '/api/open/message/deleteMessage');
  url.searchParams.set('shortCode', shortCode);
  await pushPlusJson(url, {
    method: 'DELETE',
    headers: { accept: 'application/json', 'access-key': accessKey },
  });
}

async function alreadyForwarded(shortCode, env) {
  requireEnv(env, 'STATE_SECRET');
  if (!env.FORWARDED_KV) throw new Error('Missing KV binding: FORWARDED_KV');
  return Boolean(await env.FORWARDED_KV.get(await dedupeKey(shortCode, env)));
}

async function cleanupPushPlusMessages(env) {
  if (!isTruthy(env.PUSHPLUS_CLEANUP_ENABLED)) {
    return { enabled: false, scanned: 0, candidates: 0, deleted: 0, failed: 0 };
  }

  const retentionDays = numberEnv(env, 'PUSHPLUS_CLEANUP_RETENTION_DAYS', DEFAULT_CLEANUP_RETENTION_DAYS, { min: 1, max: 3650 });
  const pageSize = numberEnv(env, 'PUSHPLUS_CLEANUP_PAGE_SIZE', DEFAULT_CLEANUP_PAGE_SIZE, { min: 1, max: 50 });
  const maxPages = numberEnv(env, 'PUSHPLUS_CLEANUP_MAX_PAGES', DEFAULT_CLEANUP_MAX_PAGES, { min: 1, max: 100 });
  const maxDeletes = numberEnv(env, 'PUSHPLUS_CLEANUP_MAX_DELETES', DEFAULT_CLEANUP_MAX_DELETES, { min: 1, max: 50 });
  const requireForwarded = env.PUSHPLUS_CLEANUP_REQUIRE_FORWARDED === undefined
    ? true
    : isTruthy(env.PUSHPLUS_CLEANUP_REQUIRE_FORWARDED);
  const titleKeyword = env.PUSHPLUS_CLEANUP_TITLE_KEYWORD || env.MESSAGE_TITLE_KEYWORD || '';
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const candidates = [];
  let scanned = 0;
  for (let current = 1; current <= maxPages && candidates.length < maxDeletes; current += 1) {
    const { items, pages } = await withPushPlusAccessKey(
      env,
      accessKey => listPushPlusMessages(env, accessKey, current, pageSize),
    );
    if (!items.length) break;
    scanned += items.length;

    for (const item of items) {
      if (candidates.length >= maxDeletes) break;
      const shortCode = item?.shortCode || '';
      if (!shortCode) continue;
      if (titleKeyword && !String(item.title || '').includes(titleKeyword)) continue;
      const updatedAt = parsePushPlusUpdateTime(item.updateTime);
      if (!updatedAt || updatedAt >= cutoff) continue;
      if (requireForwarded && !await alreadyForwarded(shortCode, env)) continue;
      candidates.push({
        shortCode,
        title: item.title || '',
        updateTime: item.updateTime || '',
      });
    }

    if (pages && current >= pages) break;
  }

  let deleted = 0;
  let failed = 0;
  for (const item of candidates) {
    try {
      await withPushPlusAccessKey(
        env,
        accessKey => deletePushPlusMessage(env, accessKey, item.shortCode),
      );
      deleted += 1;
    } catch (err) {
      failed += 1;
      console.error(`PushPlus cleanup delete failed: ${err.message}`);
    }
  }

  return { enabled: true, scanned, candidates: candidates.length, deleted, failed };
}

async function recoverPushPlusMessages(env) {
  if (!isTruthy(env.PUSHPLUS_RECOVERY_ENABLED)) {
    return {
      enabled: false,
      scanned: 0,
      candidates: 0,
      processed: 0,
      forwarded: 0,
      intercepted: 0,
      filtered: 0,
      duplicates: 0,
      empty: 0,
      upstreamDelivered: 0,
      upstreamPending: 0,
      failed: 0,
    };
  }

  const notBefore = Date.parse(String(env.PUSHPLUS_RECOVERY_NOT_BEFORE || ''));
  if (!Number.isFinite(notBefore)) {
    console.warn('PushPlus recovery skipped: missing or invalid PUSHPLUS_RECOVERY_NOT_BEFORE');
    return {
      enabled: true,
      skipped: 'invalid_activation_baseline',
      scanned: 0,
      candidates: 0,
      processed: 0,
      forwarded: 0,
      intercepted: 0,
      filtered: 0,
      duplicates: 0,
      empty: 0,
      upstreamDelivered: 0,
      upstreamPending: 0,
      failed: 0,
    };
  }

  const lookbackHours = numberEnv(
    env,
    'PUSHPLUS_RECOVERY_LOOKBACK_HOURS',
    DEFAULT_RECOVERY_LOOKBACK_HOURS,
    { min: 1, max: 24 * 30 },
  );
  const minAgeMinutes = numberEnv(
    env,
    'PUSHPLUS_RECOVERY_MIN_AGE_MINUTES',
    DEFAULT_RECOVERY_MIN_AGE_MINUTES,
    { min: 0, max: 24 * 60 },
  );
  const pageSize = numberEnv(
    env,
    'PUSHPLUS_RECOVERY_PAGE_SIZE',
    DEFAULT_RECOVERY_PAGE_SIZE,
    { min: 1, max: 50 },
  );
  const maxPages = numberEnv(
    env,
    'PUSHPLUS_RECOVERY_MAX_PAGES',
    DEFAULT_RECOVERY_MAX_PAGES,
    { min: 1, max: 20 },
  );
  const maxMessages = numberEnv(
    env,
    'PUSHPLUS_RECOVERY_MAX_MESSAGES',
    DEFAULT_RECOVERY_MAX_MESSAGES,
    { min: 1, max: 50 },
  );
  const titleKeyword = env.PUSHPLUS_RECOVERY_TITLE_KEYWORD || env.MESSAGE_TITLE_KEYWORD || '';
  const now = Date.now();
  const oldestAllowed = Math.max(notBefore, now - lookbackHours * 60 * 60 * 1000);
  const newestAllowed = now - minAgeMinutes * 60 * 1000;
  const candidates = [];
  const seen = new Set();
  let scanned = 0;

  for (let current = 1; current <= maxPages; current += 1) {
    const { items, pages } = await withPushPlusAccessKey(
      env,
      accessKey => listPushPlusMessages(env, accessKey, current, pageSize),
    );
    if (!items.length) break;
    scanned += items.length;

    for (const item of items) {
      const shortCode = item?.shortCode || '';
      if (!shortCode || seen.has(shortCode)) continue;
      seen.add(shortCode);
      if (titleKeyword && !String(item.title || '').includes(titleKeyword)) continue;
      const updatedAt = parsePushPlusUpdateTime(item.updateTime);
      if (!updatedAt || updatedAt < oldestAllowed || updatedAt > newestAllowed) continue;
      if (await alreadyForwarded(shortCode, env)) continue;
      candidates.push({
        shortCode,
        title: item.title || '',
        updatedAt,
      });
    }

    if (pages && current >= pages) break;
  }

  candidates.sort((a, b) => a.updatedAt - b.updatedAt);
  const counts = {
    forwarded: 0,
    intercepted: 0,
    filtered: 0,
    duplicates: 0,
    empty: 0,
    upstreamDelivered: 0,
    upstreamPending: 0,
    failed: 0,
  };
  for (const item of candidates.slice(0, maxMessages)) {
    try {
      const delivery = await withPushPlusAccessKey(
        env,
        accessKey => getPushPlusMessageResult(env, accessKey, item.shortCode),
      );
      if (delivery.status === 2) {
        counts.upstreamDelivered += 1;
        continue;
      }
      if (delivery.status !== 3) {
        counts.upstreamPending += 1;
        continue;
      }
      const outcome = await forwardPushPlusMessage(env, item);
      if (!Object.hasOwn(counts, outcome)) throw new Error(`Unexpected forwarding outcome: ${outcome}`);
      counts[outcome] += 1;
    } catch (err) {
      counts.failed += 1;
      console.error(`PushPlus recovery failed: ${err.message}`);
    }
  }

  const processed = counts.forwarded + counts.intercepted + counts.filtered;
  const alertEnabled = env.PUSHPLUS_RECOVERY_ALERT_ENABLED === undefined
    ? true
    : isTruthy(env.PUSHPLUS_RECOVERY_ALERT_ENABLED);
  if (alertEnabled && counts.forwarded > 0) {
    try {
      await sendTelegram({
        env,
        text: [
          '⚠️ PushPlus realtime delivery missed messages',
          `Recovered ${counts.forwarded} message(s)`,
          `Processed ${processed}; failed ${counts.failed}`,
        ].join('\n'),
      });
    } catch (err) {
      console.error(`PushPlus recovery alert failed: ${err.message}`);
    }
  }

  return {
    enabled: true,
    scanned,
    candidates: candidates.length,
    processed,
    ...counts,
  };
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function sendTelegram({ env, text }) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const attempts = numberEnv(env, 'TELEGRAM_RETRY_ATTEMPTS', DEFAULT_TELEGRAM_RETRY_ATTEMPTS, { min: 1, max: 4 });
  const baseDelayMs = numberEnv(env, 'TELEGRAM_RETRY_DELAY_MS', DEFAULT_TELEGRAM_RETRY_DELAY_MS, { min: 0, max: 5_000 });
  const timeoutMs = numberEnv(env, 'TELEGRAM_TIMEOUT_MS', DEFAULT_TELEGRAM_TIMEOUT_MS, { min: 1_000, max: 10_000 });
  let lastError = new Error('Telegram sendMessage failed');

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
      data = await res.json().catch(() => ({}));
      if (res.ok && data.ok !== false) return data?.result || null;
      lastError = new Error(`Telegram sendMessage failed: ${data.description || res.status}`);
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= attempts) throw lastError;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (res && res.status !== 408 && res.status !== 429 && res.status < 500) throw lastError;
      if (attempt >= attempts) throw lastError;
    }

    const retryAfterMs = Number(data?.parameters?.retry_after || 0) * 1000;
    const delayMs = Math.min(5_000, retryAfterMs || baseDelayMs * (2 ** (attempt - 1)));
    if (delayMs > 0) await sleep(delayMs);
  }
  throw lastError;
}

function requireEnv(env, name) {
  if (!env[name]) throw new Error(`Missing env: ${name}`);
}

function inboxAuthToken(env) {
  return env.INBOX_TOKEN || '';
}

function authorizeInboxRequest(request, env, url) {
  const expected = inboxAuthToken(env);
  if (!expected) return false;
  const auth = request.headers.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ') && auth.slice(7).trim() === expected) return true;
  return url.searchParams.get('token') === expected;
}

function authorizeInterceptLeaseRequest(request, env) {
  const expected = inboxAuthToken(env);
  if (!expected) return false;
  const auth = request.headers.get('authorization') || '';
  return auth.toLowerCase().startsWith('bearer ') && auth.slice(7).trim() === expected;
}

function parseInterceptLeasePath(pathname) {
  const match = pathname.match(/^\/intercepts\/leases\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  const preset = decodeURIComponent(match[1]);
  const leaseId = decodeURIComponent(match[2]);
  if (!LEASED_INTERCEPT_PRESETS.has(preset)) return { error: 'unsupported preset' };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(leaseId)) return { error: 'invalid lease id' };
  return { preset, leaseId };
}

async function processInterceptLease(request, env, url) {
  if (!authorizeInterceptLeaseRequest(request, env)) {
    return jsonResponse({ code: 401, msg: 'unauthorized' }, 401);
  }
  const parsed = parseInterceptLeasePath(url.pathname);
  if (!parsed) return jsonResponse({ code: 404, msg: 'not found' }, 404);
  if (parsed.error) return jsonResponse({ code: 400, msg: parsed.error }, 400);
  const body = request.method === 'PUT' ? await request.text() : undefined;
  return interceptLeaseCoordinator(env).fetch(new Request(
    `https://intercept-leases.internal/leases/${encodeURIComponent(parsed.preset)}/${encodeURIComponent(parsed.leaseId)}`,
    {
      method: request.method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body,
    },
  ));
}

async function storeInboxMessage(env, message) {
  if (!env.FORWARDED_KV) throw new Error('Missing KV binding: FORWARDED_KV');
  const text = message.text || '';
  if (!text) return;
  const fields = parseSmsFields(text);
  const timestamp = Number(message.receivedAt);
  const receivedAt = Number.isFinite(timestamp) ? timestamp : Date.now();
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

async function processHandledDiagnostic(request, env) {
  requireEnv(env, 'STATE_SECRET');
  if (!env.FORWARDED_KV) throw new Error('Missing KV binding: FORWARDED_KV');
  if (!authorizeInterceptLeaseRequest(request, env)) {
    return jsonResponse({ code: 401, msg: 'unauthorized' }, 401);
  }
  if (request.method !== 'POST') {
    return jsonResponse({ code: 405, msg: 'method not allowed' }, 405);
  }
  const body = await request.json().catch(() => ({}));
  const sourceId = body?.sourceId;
  if (typeof sourceId !== 'string' || !sourceId || sourceId.length > 256) {
    return jsonResponse({ code: 400, msg: 'invalid sourceId' }, 400);
  }
  const handled = Boolean(await env.FORWARDED_KV.get(await dedupeKey(sourceId, env)));
  return jsonResponse({ code: 200, handled });
}

async function processTelegramDiagnostic(request, env) {
  if (!authorizeInterceptLeaseRequest(request, env)) {
    return jsonResponse({ code: 401, msg: 'unauthorized' }, 401);
  }
  if (request.method !== 'POST') {
    return jsonResponse({ code: 405, msg: 'method not allowed' }, 405);
  }
  requireEnv(env, 'TELEGRAM_BOT_TOKEN');
  requireEnv(env, 'TELEGRAM_CHAT_ID');
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChat?chat_id=${encodeURIComponent(env.TELEGRAM_CHAT_ID)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(DEFAULT_TELEGRAM_TIMEOUT_MS) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) {
    throw new Error(`Telegram destination check failed: ${data.description || response.status}`);
  }
  return jsonResponse({ code: 200, reachable: true });
}

async function forwardPushPlusMessage(env, message) {
  requireEnv(env, 'STATE_SECRET');
  if (!env.FORWARDED_KV) throw new Error('Missing KV binding: FORWARDED_KV');

  let text = message.text || '';
  if (!text && message.shortCode) {
    text = await fetchPushPlusDetail(env, message.shortCode);
  }
  if (!text) return 'empty';
  const sourceIds = await messageSourceIds(message, text);
  if (!sourceIds.length) return 'empty';
  const keys = await dedupeKeys(sourceIds, env);
  const existingValue = await existingDedupeValue(keys, env);
  if (existingValue) {
    await putDedupeKeys(keys, `duplicate:${String(existingValue).slice(0, 128)}`, env);
    return 'duplicates';
  }
  const interceptRule = await findEffectiveInterceptRule({ ...message, text }, env);
  if (interceptRule) {
    if (interceptShouldStore(interceptRule)) {
      await storeInboxMessage(env, { ...message, text });
    }
    if (interceptShouldSilence(interceptRule)) {
      await putDedupeKeys(keys, `intercept:${interceptRule.name || 'silence'}`, env);
      return 'intercepted';
    }
  }

  if (env.MESSAGE_TITLE_KEYWORD && !String(message.title || '').includes(env.MESSAGE_TITLE_KEYWORD)) {
    await putDedupeKeys(keys, 'ignored', env, 60 * 60 * 24 * 30);
    return 'filtered';
  }
  if (env.MESSAGE_BODY_KEYWORD && !text.includes(env.MESSAGE_BODY_KEYWORD)) {
    await putDedupeKeys(keys, 'ignored', env, 60 * 60 * 24 * 30);
    return 'filtered';
  }

  requireEnv(env, 'TELEGRAM_BOT_TOKEN');
  requireEnv(env, 'TELEGRAM_CHAT_ID');
  const telegramMessage = { title: message.title || '短信转发', sourceLabel: message.sourceLabel, text };
  for (const chunk of splitTelegramText(buildTelegramText(telegramMessage))) {
    await sendTelegram({ env, text: chunk });
  }
  await putDedupeKeys(keys, new Date().toISOString(), env);
  return 'forwarded';
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

function decodeBase64Signature(value) {
  let normalized = String(value || '').trim().replace(/ /g, '+');
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    return null;
  }
  try {
    return Uint8Array.from(atob(normalized), character => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function authorizeSmsForwarderPayload(payload, env) {
  const secret = String(env.SMSFORWARDER_WEBHOOK_SECRET || '');
  if (!secret) throw new Error('Missing env: SMSFORWARDER_WEBHOOK_SECRET');
  const timestamp = Number(payload.timestamp);
  const signature = decodeBase64Signature(payload.sign || payload.signature);
  if (!Number.isFinite(timestamp) || !signature?.length) return false;
  const maxClockSkewSeconds = numberEnv(
    env,
    'SMSFORWARDER_MAX_CLOCK_SKEW_SECONDS',
    DEFAULT_SMSFORWARDER_MAX_CLOCK_SKEW_SECONDS,
    { min: 60, max: 24 * 60 * 60 },
  );
  if (Math.abs(Date.now() - timestamp) > maxClockSkewSeconds * 1000) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    new TextEncoder().encode(`${timestamp}\n${secret}`),
  );
}

function smsForwarderText(payload) {
  const content = htmlToText(
    payload.content || payload.message || payload.orgContent || payload.org_content || payload.text || '',
  );
  const sender = String(payload.sender || payload.from || '').trim();
  const sentAt = String(
    payload.sentAt || payload.sent_at || payload.receiveTime || payload.receive_time || '',
  ).trim();
  const fields = parseSmsFields(content);
  const lines = [content];
  if (sender && !fields.sender) lines.push(`发件号码: ${sender}`);
  if (sentAt && !fields.sentAt) lines.push(`发件时间: ${sentAt}`);
  if (!/(?:^|\n)\s*#SMS\b/i.test(content)) lines.push('#SMS');
  return lines.filter(Boolean).join('\n');
}

async function processSmsForwarderWebhook(request, env) {
  if (request.method !== 'POST') {
    return jsonResponse({ code: 405, msg: 'method not allowed' }, 405);
  }
  const payload = await parseWebhookPayload(request);
  if (!await authorizeSmsForwarderPayload(payload, env)) {
    return jsonResponse({ code: 401, msg: 'unauthorized' }, 401);
  }
  const sourceId = String(payload.sourceId || payload.source_id || '').trim();
  if (sourceId.length > 256) {
    return jsonResponse({ code: 400, msg: 'invalid sourceId' }, 400);
  }
  await forwardPushPlusMessage(env, {
    sourceId: sourceId ? `smsforwarder:${sourceId}` : '',
    sourceLabel: 'SMS',
    title: '短信转发',
    text: smsForwarderText(payload),
  });
  return pushPlusSuccessResponse();
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
  async scheduled(event, env, ctx) {
    const cron = event?.cron || '';
    if (cron === RECOVERY_CRON) {
      ctx.waitUntil(recoverPushPlusMessages(env)
        .then(result => {
          console.log(JSON.stringify({ event: 'pushplus_recovery', ...result }));
        })
        .catch(err => {
          console.error(`PushPlus recovery failed: ${err.message}`);
        }));
      return;
    }
    if (!cron || cron === CLEANUP_CRON) {
      ctx.waitUntil(cleanupPushPlusMessages(env)
        .then(result => {
          console.log(JSON.stringify({ event: 'pushplus_cleanup', ...result }));
        })
        .catch(err => {
          console.error(`PushPlus cleanup failed: ${err.message}`);
        }));
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse({ code: 200, msg: 'ok' });
    }
    if (url.pathname === '/') {
      return pushPlusSuccessResponse();
    }
    if (url.pathname === '/smsforwarder/webhook') {
      try {
        return await processSmsForwarderWebhook(request, env);
      } catch (err) {
        console.error(`SmsForwarder webhook failed: ${err.message}`);
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
    if (url.pathname === '/diagnostics/handled') {
      try {
        return await processHandledDiagnostic(request, env);
      } catch (err) {
        console.error(err.message);
        return jsonResponse({ code: 500, msg: 'internal error' }, 500);
      }
    }
    if (url.pathname === '/diagnostics/telegram') {
      try {
        return await processTelegramDiagnostic(request, env);
      } catch (err) {
        console.error(err.message);
        return jsonResponse({ code: 500, msg: 'internal error' }, 500);
      }
    }
    if (url.pathname.startsWith('/intercepts/leases/')) {
      try {
        return await processInterceptLease(request, env, url);
      } catch (err) {
        console.error(err.message);
        return jsonResponse({ code: 500, msg: 'internal error' }, 500);
      }
    }
    return jsonResponse({ code: 404, msg: 'not found' }, 404);
  },
};
