import {
  PUSHPLUS_BASE_URL,
  WORKFLOW_LEASED_PRESETS,
  buildTelegramText,
  findInterceptRule,
  htmlToText,
  interceptPresetRules,
  interceptShouldSilence,
  interceptShouldStore,
  isTruthy,
  loadInterceptRules,
  messageSourceIds,
  parsePushPlusUpdateTime,
  parseSmsFields,
  pickField,
  pushPlusAccessKeyRequest,
  pushPlusUrl as pushPlusUrlWithBase,
  sha256Hex,
  splitTelegramText,
} from './src/pipeline.js';

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
const RECOVERY_CRON = '3,13,23,33,43,53 * * * *';
const CLEANUP_CRON = '17 3 * * *';
const PUSHPLUS_ACCESS_KEY_REFRESH_MARGIN_SECONDS = 5 * 60;
const INTERCEPT_LEASE_STORAGE_PREFIX = 'lease:';
const DEFAULT_INTERCEPT_LEASE_TTL_SECONDS = 60 * 60;
const MAX_INTERCEPT_LEASE_TTL_SECONDS = 2 * 60 * 60;
const DEFAULT_SMSFORWARDER_MAX_CLOCK_SKEW_SECONDS = 60 * 60;
const DEFAULT_TELEGRAM_RETRY_ATTEMPTS = 3;
const DEFAULT_TELEGRAM_RETRY_DELAY_MS = 500;
const DEFAULT_TELEGRAM_TIMEOUT_MS = 8_000;
let pushPlusAccessKeyCache = null;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export class InterceptLeaseCoordinator {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.deliveryTail = Promise.resolve();
  }

  async deliver(request) {
    const { keys, chunks } = await request.json();
    if (!Array.isArray(keys) || !keys.length || keys.length > 4
      || !keys.every(key => /^pushplus:[0-9a-f]{64}$/.test(key))
      || !Array.isArray(chunks) || !chunks.length
      || !chunks.every(chunk => typeof chunk === 'string' && chunk.length <= 4096)) {
      return jsonResponse({ state: 'invalid' }, 400);
    }
    const storageKeys = [...new Set(keys)].map(key => `delivery:${key}`);
    const now = Date.now();
    const initial = { state: 'submitted', confirmedChunks: 0, totalChunks: chunks.length };
    const claim = await this.ctx.storage.transaction(async txn => {
      const records = await Promise.all(storageKeys.map(key => txn.get(key)));
      const unresolved = records.find(record => record && record.state !== 'completed');
      const completed = records.find(record => record?.state === 'completed' && record.expiresAt > now);
      const value = unresolved || completed || initial;
      for (const key of storageKeys) await txn.put(key, value);
      return unresolved ? 'unknown' : completed ? 'duplicates' : 'claimed';
    });
    if (claim === 'unknown') return jsonResponse({ state: 'unknown' }, 409);
    if (claim === 'duplicates') return jsonResponse({ state: 'duplicates' });

    let confirmedChunks = 0;
    const persist = async state => {
      const record = { state, confirmedChunks, totalChunks: chunks.length };
      if (state === 'completed') record.expiresAt = now + FORWARDED_TTL_SECONDS * 1000;
      await this.ctx.storage.transaction(async txn => {
        for (const key of storageKeys) await txn.put(key, record);
      });
    };
    try {
      // The durable reservation precedes external I/O. Never put fetch inside
      // a storage transaction: retries of a transaction must not send messages.
      for (const text of chunks) {
        await sendTelegram({ env: this.env, text });
        confirmedChunks += 1;
        await persist('submitted');
      }
      await persist('completed');
      return jsonResponse({ state: 'forwarded' });
    } catch (error) {
      const rejected = error instanceof TelegramDeliveryError && !error.uncertain && confirmedChunks === 0;
      try {
        if (rejected) {
          await this.ctx.storage.transaction(async txn => {
            await txn.delete(storageKeys);
          });
        } else {
          await persist('unknown');
        }
      } catch {
        // Even if recording the outcome fails, the pre-send reservation stays
        // durable and blocks another send after this object is reconstructed.
      }
      return jsonResponse({ state: rejected ? 'rejected' : 'unknown' }, 503);
    }
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
    if (request.method === 'POST' && url.pathname === '/deliver') {
      // In-process ordering is only an optimization; the durable claim above
      // is the safety boundary across restarts and overlapping aliases.
      const result = this.deliveryTail.then(() => this.deliver(request))
        .catch(() => jsonResponse({ state: 'unavailable' }, 503));
      this.deliveryTail = result.then(() => {});
      return result;
    }
    const now = Date.now();
    const leases = await this.pruneExpired(now);
    if (request.method === 'GET' && url.pathname === '/active') {
      const presets = new Set();
      for (const [key, value] of leases) {
        if (Number(value?.expiresAt) <= now) continue;
        const suffix = String(key).slice(INTERCEPT_LEASE_STORAGE_PREFIX.length);
        const separator = suffix.indexOf(':');
        const preset = separator === -1 ? '' : suffix.slice(0, separator);
        if (WORKFLOW_LEASED_PRESETS.has(preset)) presets.add(preset);
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

function numberEnv(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric env ${name}: ${raw}`);
  return Math.max(min, Math.min(Math.floor(parsed), max));
}

function interceptLeaseCoordinator(env, name = 'global') {
  if (!env.INTERCEPT_LEASES) throw new Error('Missing Durable Object binding: INTERCEPT_LEASES');
  if (typeof env.INTERCEPT_LEASES.getByName === 'function') {
    return env.INTERCEPT_LEASES.getByName(name);
  }
  const id = env.INTERCEPT_LEASES.idFromName(name);
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
  const staticRule = findInterceptRule(message, loadInterceptRules(env));
  if (staticRule) return staticRule;
  const leasedPresets = await activeInterceptLeasePresets(env);
  if (!leasedPresets.length) return null;
  const leasedRules = leasedPresets.flatMap(preset => interceptPresetRules(preset, env));
  return findInterceptRule(message, leasedRules);
}

async function dedupeKey(sourceId, env) {
  return `pushplus:${await sha256Hex(`${env.STATE_SECRET || ''}:${sourceId}`)}`;
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
  return pushPlusUrlWithBase(env.PUSHPLUS_BASE_URL || PUSHPLUS_BASE_URL, pathname);
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
  const request = pushPlusAccessKeyRequest(env.PUSHPLUS_BASE_URL, {
    token: env.PUSHPLUS_TOKEN,
    secretKey: env.PUSHPLUS_SECRET_KEY,
  });
  const data = await pushPlusJson(request.url, request.options);
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

  const recoveryMode = String(env.PUSHPLUS_RECOVERY_MODE || 'failed-only').trim().toLowerCase();
  if (!['failed-only', 'unhandled'].includes(recoveryMode)) {
    throw new Error(`Invalid PUSHPLUS_RECOVERY_MODE: ${recoveryMode}`);
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
      if (recoveryMode === 'failed-only') {
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
    mode: recoveryMode,
    scanned,
    candidates: candidates.length,
    processed,
    ...counts,
  };
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

class TelegramDeliveryError extends Error {
  constructor(uncertain) {
    super(uncertain ? 'Telegram delivery outcome unknown' : 'Telegram delivery rejected');
    this.uncertain = uncertain;
  }
}

async function sendTelegram({ env, text }) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const attempts = numberEnv(env, 'TELEGRAM_RETRY_ATTEMPTS', DEFAULT_TELEGRAM_RETRY_ATTEMPTS, { min: 1, max: 4 });
  const baseDelayMs = numberEnv(env, 'TELEGRAM_RETRY_DELAY_MS', DEFAULT_TELEGRAM_RETRY_DELAY_MS, { min: 0, max: 5_000 });
  const timeoutMs = numberEnv(env, 'TELEGRAM_TIMEOUT_MS', DEFAULT_TELEGRAM_TIMEOUT_MS, { min: 1_000, max: 10_000 });
  let lastError = new TelegramDeliveryError(false);

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
      if (res.ok && data.ok === true && Number.isInteger(data.result?.message_id)) return data.result;
      if (data.ok !== false) throw new TelegramDeliveryError(true);
      lastError = new TelegramDeliveryError(false);
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= attempts) throw lastError;
    } catch (error) {
      // Network errors and malformed/ambiguous responses are not safe to retry.
      if (!(error instanceof TelegramDeliveryError) || error.uncertain) {
        throw new TelegramDeliveryError(true);
      }
      lastError = error;
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
  if (!WORKFLOW_LEASED_PRESETS.has(preset)) return { error: 'unsupported preset' };
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
  inboxSnapshots.delete(env.FORWARDED_KV);
  try { await env.FORWARDED_KV.put(await inboxKey(sourceId, receivedAt, env), JSON.stringify({
    id: sourceId,
    sender: fields.sender || '',
    text,
    receivedAt,
    title: message.title || '',
  }), { expirationTtl: INBOX_TTL_SECONDS }); }
  finally { inboxSnapshots.delete(env.FORWARDED_KV); }
}

const inboxSnapshots = new WeakMap();

async function inboxMessages(store) {
  let entry = inboxSnapshots.get(store);
  if (!entry || entry.until <= Date.now()) {
    entry = { until: Date.now() + 5000, promise: (async () => {
      const list = await store.list({ prefix: 'inbox:' });
      const messages = [];
      for (const key of list.keys) {
        const raw = await store.get(key.name);
        if (raw) messages.push(JSON.parse(raw));
      }
      return messages;
    })() };
    inboxSnapshots.set(store, entry);
    entry.promise.catch(() => { if (inboxSnapshots.get(store) === entry) inboxSnapshots.delete(store); });
  }
  return entry.promise;
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
  const messages = [];
  for (const msg of await inboxMessages(env.FORWARDED_KV)) {
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
  const response = await interceptLeaseCoordinator(env, 'sms-delivery').fetch(new Request(
    'https://intercept-leases.internal/deliver', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys, chunks: splitTelegramText(buildTelegramText(telegramMessage)) }),
    },
  ));
  const result = await response.json();
  if (!response.ok || !['forwarded', 'duplicates'].includes(result.state)) {
    throw new Error('Telegram delivery not confirmed; durable review may be required');
  }
  await putDedupeKeys(keys, new Date().toISOString(), env);
  return result.state;
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

function hardwareWebhookToken(request, url) {
  const auth = request.headers.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const pathPrefix = '/device/webhook/';
  if (url.pathname.startsWith(pathPrefix)) {
    return decodeURIComponent(url.pathname.slice(pathPrefix.length));
  }
  return url.searchParams.get('token') || '';
}

async function tokensEqual(candidate, expected) {
  const encoder = new TextEncoder();
  const [candidateHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(candidate || ''))),
    crypto.subtle.digest('SHA-256', encoder.encode(String(expected || ''))),
  ]);
  const left = new Uint8Array(candidateHash);
  const right = new Uint8Array(expectedHash);
  let mismatch = String(candidate || '').length ^ String(expected || '').length;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
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

let smsVerificationKey;
function smsKey(secret) {
  if (!smsVerificationKey || smsVerificationKey.secret !== secret) {
    const entry = { secret, promise: crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']) };
    smsVerificationKey = entry;
    entry.promise.catch(() => { if (smsVerificationKey === entry) smsVerificationKey = undefined; });
  }
  return smsVerificationKey.promise;
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
  const key = await smsKey(secret);
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

async function processHardwareWebhook(request, env, url) {
  if (request.method !== 'POST') {
    return jsonResponse({ code: 405, msg: 'method not allowed' }, 405);
  }
  const secret = String(env.HARDWARE_WEBHOOK_TOKEN || '');
  if (!secret) throw new Error('Missing env: HARDWARE_WEBHOOK_TOKEN');
  if (!await tokensEqual(hardwareWebhookToken(request, url), secret)) {
    return jsonResponse({ code: 401, msg: 'unauthorized' }, 401);
  }

  let payload;
  try {
    payload = await parseWebhookPayload(request);
  } catch {
    return jsonResponse({ code: 400, msg: 'invalid payload' }, 400);
  }
  const sourceId = String(payload.sourceId || payload.source_id || '').trim();
  const sender = String(payload.sender || payload.from || '').trim();
  const sentAt = String(
    payload.sentAt || payload.sent_at || payload.timestamp || payload.time || '',
  ).trim();
  const content = String(
    payload.content || payload.message || payload.text || '',
  ).trim();
  if (!content || sourceId.length > 256 || sender.length > 256 || sentAt.length > 128 || content.length > 64_000) {
    return jsonResponse({ code: 400, msg: 'invalid SMS payload' }, 400);
  }

  await forwardPushPlusMessage(env, {
    sourceId: sourceId ? `hardware:${sourceId}` : '',
    sourceLabel: 'SMS',
    title: '短信转发',
    text: smsForwarderText({ content, sender, sentAt }),
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
    if (url.pathname === '/device/webhook' || url.pathname.startsWith('/device/webhook/')) {
      try {
        return await processHardwareWebhook(request, env, url);
      } catch (err) {
        console.error(`Hardware webhook failed: ${err.message}`);
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
