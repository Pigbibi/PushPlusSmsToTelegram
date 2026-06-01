#!/usr/bin/env node
const DEFAULT_BASE_URL = 'https://www.pushplus.plus';
const DEFAULT_WEBHOOK_CODE = 'sms2telegram';
const DEFAULT_WEBHOOK_NAME = '短信转发到Telegram';
const DEFAULT_WEBHOOK_BODY = '标题：{title}\n链接：{url}\n\n{content}';

function env(name, fallback = '') {
  return process.env[name] || fallback;
}

function requireEnv(name) {
  const value = env(name);
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function pushPlusUrl(baseUrl, pathname) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(pathname, base);
}

function redactUrl(value) {
  return String(value || '').replace(/\/pushplus\/webhook\/[^/?#]+/, '/pushplus/webhook/[redacted]');
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${new URL(url).pathname}`);
  return data;
}

async function getAccessKey(config) {
  const data = await requestJson(pushPlusUrl(config.baseUrl, '/api/common/openApi/getAccessKey'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ token: config.token, secretKey: config.secretKey }),
  });
  if (data.code !== 200 || !data?.data?.accessKey) {
    throw new Error(`PushPlus access key request failed: ${data.msg || 'unknown error'}`);
  }
  return data.data.accessKey;
}

async function pushPlusPost(config, accessKey, pathname, body) {
  const data = await requestJson(pushPlusUrl(config.baseUrl, pathname), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'access-key': accessKey,
    },
    body: JSON.stringify(body),
  });
  if (data.code !== 200) throw new Error(`PushPlus ${pathname} failed: ${data.msg || 'unknown error'}`);
  return data;
}

async function pushPlusGet(config, accessKey, pathname) {
  const data = await requestJson(pushPlusUrl(config.baseUrl, pathname), {
    headers: { accept: 'application/json', 'access-key': accessKey },
  });
  if (data.code !== 200) throw new Error(`PushPlus ${pathname} failed: ${data.msg || 'unknown error'}`);
  return data;
}

async function upsertWebhook(config, accessKey) {
  const list = await pushPlusPost(config, accessKey, '/api/open/webhook/list', { current: 1, pageSize: 50 });
  const existing = (list?.data?.list || []).find(item => item.webhookCode === config.webhookCode);
  const payload = {
    webhookCode: config.webhookCode,
    webhookName: config.webhookName,
    webhookType: 12,
    webhookUrl: config.webhookUrl,
    httpMethod: 'POST',
    body: config.webhookBody,
  };
  if (existing?.id) {
    await pushPlusPost(config, accessKey, '/api/open/webhook/edit', { id: existing.id, ...payload });
    return { id: existing.id, action: 'updated' };
  }
  const created = await pushPlusPost(config, accessKey, '/api/open/webhook/add', payload);
  return { id: created.data, action: 'created' };
}

async function setUserDefault(config, accessKey) {
  const list = await pushPlusPost(config, accessKey, '/api/open/setting/listUserDefault', { current: 1, pageSize: 50 });
  let currentDefault = null;
  for (const item of list?.data?.list || []) {
    const detail = await pushPlusGet(config, accessKey, `/api/open/setting/detailUserDefault?id=${encodeURIComponent(item.id)}`);
    if (Number(detail?.data?.tokenId) === 0) {
      currentDefault = detail.data;
      break;
    }
  }
  const payload = {
    channel: 'webhook',
    option: config.webhookCode,
    pre: '',
    tokenId: '0',
  };
  if (currentDefault?.id) {
    await pushPlusPost(config, accessKey, '/api/open/setting/editUserDefault', { id: String(currentDefault.id), ...payload });
    return { id: currentDefault.id, action: 'updated' };
  }
  await pushPlusPost(config, accessKey, '/api/open/setting/addUserDefault', payload);
  return { id: null, action: 'created' };
}

async function main() {
  const config = {
    token: requireEnv('PUSHPLUS_TOKEN'),
    secretKey: requireEnv('PUSHPLUS_SECRET_KEY'),
    webhookUrl: requireEnv('PUSHPLUS_WEBHOOK_URL'),
    baseUrl: env('PUSHPLUS_BASE_URL', DEFAULT_BASE_URL),
    webhookCode: env('PUSHPLUS_WEBHOOK_CODE', DEFAULT_WEBHOOK_CODE),
    webhookName: env('PUSHPLUS_WEBHOOK_NAME', DEFAULT_WEBHOOK_NAME),
    webhookBody: env('PUSHPLUS_WEBHOOK_BODY', DEFAULT_WEBHOOK_BODY),
    setUserDefault: env('PUSHPLUS_SET_USER_DEFAULT', 'true').toLowerCase() !== 'false',
  };

  const accessKey = await getAccessKey(config);
  const webhook = await upsertWebhook(config, accessKey);
  const result = {
    webhookCode: config.webhookCode,
    webhookAction: webhook.action,
    webhookUrl: redactUrl(config.webhookUrl),
  };
  if (config.setUserDefault) {
    const defaultConfig = await setUserDefault(config, accessKey);
    result.userDefaultAction = defaultConfig.action;
    result.userDefaultChannel = 'webhook';
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
