import {
  PUSHPLUS_BASE_URL,
  htmlToText,
  pushPlusAccessKeyRequest,
  pushPlusUrl as pushPlusUrlWithBase,
} from './pipeline.js';

const PUSHPLUS_ACCESS_KEY_REFRESH_MARGIN_SECONDS = 5 * 60;

export function pushPlusUrl(env, pathname) {
  return pushPlusUrlWithBase(env.PUSHPLUS_BASE_URL || PUSHPLUS_BASE_URL, pathname);
}

export async function fetchPushPlusDetail(env, shortCode) {
  const url = pushPlusUrl(env, `/shortMessage/${encodeURIComponent(shortCode)}`);
  const res = await fetch(url, { headers: { accept: 'text/html, text/plain;q=0.9, */*;q=0.8' } });
  if (!res.ok) throw new Error(`PushPlus detail HTTP ${res.status}`);
  return htmlToText(await res.text());
}

export async function pushPlusJson(url, options = {}) {
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

export async function listPushPlusMessages(env, accessKey, current, pageSize) {
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

export async function getPushPlusMessageResult(env, accessKey, shortCode) {
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

export async function deletePushPlusMessage(env, accessKey, shortCode) {
  const url = pushPlusUrl(env, '/api/open/message/deleteMessage');
  url.searchParams.set('shortCode', shortCode);
  await pushPlusJson(url, {
    method: 'DELETE',
    headers: { accept: 'application/json', 'access-key': accessKey },
  });
}

// Each Worker module load keeps an isolated in-memory access-key cache so
// cached credentials do not leak across test module reloads.
export function createPushPlusClient() {
  let pushPlusAccessKeyCache = null;

  async function getPushPlusAccessKey(env, forceRefresh = false) {
    if (!env.PUSHPLUS_TOKEN) throw new Error('Missing env: PUSHPLUS_TOKEN');
    if (!env.PUSHPLUS_SECRET_KEY) throw new Error('Missing env: PUSHPLUS_SECRET_KEY');
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

  return {
    getPushPlusAccessKey,
    withPushPlusAccessKey,
    listPushPlusMessages,
    getPushPlusMessageResult,
    deletePushPlusMessage,
    fetchPushPlusDetail,
    pushPlusUrl,
    pushPlusJson,
  };
}
