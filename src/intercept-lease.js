import {
  WORKFLOW_LEASED_PRESETS,
  findInterceptRule,
  interceptPresetRules,
  loadInterceptRules,
} from './pipeline.js';
import { TelegramDeliveryError, sendTelegram } from './telegram.js';

export const FORWARDED_TTL_SECONDS = 60 * 60 * 24 * 180;
export const INTERCEPT_LEASE_STORAGE_PREFIX = 'lease:';
export const DEFAULT_INTERCEPT_LEASE_TTL_SECONDS = 60 * 60;
export const MAX_INTERCEPT_LEASE_TTL_SECONDS = 2 * 60 * 60;
export const DEDUPE_KEY_PREFIX = 'pushplus:';
// Same shape the dedupe writer produces; the delivery object rejects anything
// else so a caller cannot reserve a key the Worker never reads back.
export const DEDUPE_KEY_PATTERN = new RegExp(`^${DEDUPE_KEY_PREFIX}[0-9a-f]{64}$`);

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// One protected token gates the inbox, the diagnostics and the workflow
// leases; the workflows that use them are configured with INBOX_TOKEN.
export function inboxToken(env) {
  return env.INBOX_TOKEN || '';
}

export function bearerToken(request) {
  const auth = request.headers.get('authorization') || '';
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
}

// Lease writes stay on the header so a token cannot end up in a URL that gets
// logged by an intermediate proxy.
export function authorizeInterceptLeaseRequest(request, env) {
  const expected = inboxToken(env);
  return Boolean(expected) && bearerToken(request) === expected;
}

// The lease id and the preset both live in the storage key, so the writer and
// the `/active` reader have to derive them the same way.
export function leaseStorageKey(preset, leaseId) {
  return `${INTERCEPT_LEASE_STORAGE_PREFIX}${preset}:${leaseId}`;
}

export function leasePreset(key) {
  const suffix = String(key).slice(INTERCEPT_LEASE_STORAGE_PREFIX.length);
  const separator = suffix.indexOf(':');
  return separator === -1 ? '' : suffix.slice(0, separator);
}

export function parseInterceptLeasePath(pathname) {
  const match = pathname.match(/^\/intercepts\/leases\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  const preset = decodeURIComponent(match[1]);
  const leaseId = decodeURIComponent(match[2]);
  if (!WORKFLOW_LEASED_PRESETS.has(preset)) return { error: 'unsupported preset' };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(leaseId)) return { error: 'invalid lease id' };
  return { preset, leaseId };
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
      || !keys.every(key => DEDUPE_KEY_PATTERN.test(key))
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
    const active = new Map();
    const expired = [];
    for (const [key, value] of leases) {
      if (!Number(value?.expiresAt) || Number(value.expiresAt) <= now) expired.push(key);
      else active.set(key, value);
    }
    if (expired.length) await this.ctx.storage.delete(expired);
    return active;
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
      for (const key of leases.keys()) {
        const preset = leasePreset(key);
        if (WORKFLOW_LEASED_PRESETS.has(preset)) presets.add(preset);
      }
      return jsonResponse({ code: 200, presets: [...presets] });
    }

    const parsed = parseInterceptLeasePath(url.pathname);
    if (!parsed) return jsonResponse({ code: 404, msg: 'not found' }, 404);
    if (parsed.error) return jsonResponse({ code: 400, msg: parsed.error }, 400);
    const key = leaseStorageKey(parsed.preset, parsed.leaseId);
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

export function interceptLeaseCoordinator(env, name = 'global') {
  if (!env.INTERCEPT_LEASES) throw new Error('Missing Durable Object binding: INTERCEPT_LEASES');
  if (typeof env.INTERCEPT_LEASES.getByName === 'function') {
    return env.INTERCEPT_LEASES.getByName(name);
  }
  const id = env.INTERCEPT_LEASES.idFromName(name);
  return env.INTERCEPT_LEASES.get(id);
}

export async function activeInterceptLeasePresets(env) {
  if (!env.INTERCEPT_LEASES) return [];
  const response = await interceptLeaseCoordinator(env).fetch('https://intercept-leases.internal/active');
  if (!response.ok) throw new Error(`Intercept lease lookup failed: HTTP ${response.status}`);
  const data = await response.json();
  return Array.isArray(data.presets) ? data.presets : [];
}

export async function findEffectiveInterceptRule(message, env) {
  const staticRule = findInterceptRule(message, loadInterceptRules(env));
  if (staticRule) return { rule: staticRule, leased: false, presets: [] };
  const leasedPresets = await activeInterceptLeasePresets(env);
  if (!leasedPresets.length) return { rule: null, leased: false, presets: [] };
  const leasedRules = leasedPresets.flatMap(preset => interceptPresetRules(preset, env, { leased: true }));
  return { rule: findInterceptRule(message, leasedRules), leased: true, presets: leasedPresets };
}

export async function processInterceptLease(request, env, url) {
  if (!authorizeInterceptLeaseRequest(request, env)) {
    return jsonResponse({ code: 401, msg: 'unauthorized' }, 401);
  }
  const parsed = parseInterceptLeasePath(url.pathname);
  if (!parsed) return jsonResponse({ code: 404, msg: 'not found' }, 404);
  if (parsed.error) return jsonResponse({ code: 400, msg: parsed.error }, 400);
  const body = request.method === 'PUT' ? await request.text() : undefined;
  return interceptLeaseCoordinator(env).fetch(new Request(
    `https://intercept-leases.internal/intercepts/leases/${encodeURIComponent(parsed.preset)}/${encodeURIComponent(parsed.leaseId)}`,
    {
      method: request.method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body,
    },
  ));
}
