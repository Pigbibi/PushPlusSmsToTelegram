const { htmlToText } = require('./text');

const DEFAULT_BASE_URL = 'https://www.pushplus.plus';

function pushPlusUrl(baseUrl, pathname) {
  const base = baseUrl || DEFAULT_BASE_URL;
  return new URL(pathname, base.endsWith('/') ? base : `${base}/`);
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

async function getAccessKey({ token, secretKey, baseUrl }) {
  const res = await fetch(pushPlusUrl(baseUrl, '/api/common/openApi/getAccessKey'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ token, secretKey }),
  });
  if (!res.ok) throw new Error(`PushPlus access key HTTP ${res.status}`);
  const data = await res.json();
  const accessKey = data?.data?.accessKey;
  if (data?.code !== 200 || !accessKey) {
    throw new Error(`PushPlus access key request failed: ${data?.msg || 'unknown error'}`);
  }
  return accessKey;
}

async function listMessages({ accessKey, baseUrl, pageSize }) {
  const res = await fetch(pushPlusUrl(baseUrl, '/api/open/message/list'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'access-key': accessKey,
    },
    body: JSON.stringify({ current: 1, pageSize }),
  });
  if (!res.ok) throw new Error(`PushPlus message list HTTP ${res.status}`);
  const data = await res.json();
  if (data?.code !== 200) throw new Error(`PushPlus message list failed: ${data?.msg || 'unknown error'}`);
  return data?.data?.list || [];
}

async function getMessageDetail({ shortCode, baseUrl }) {
  const res = await fetch(pushPlusUrl(baseUrl, `/shortMessage/${encodeURIComponent(shortCode)}`), {
    headers: { accept: 'text/html, text/plain;q=0.9, */*;q=0.8' },
  });
  if (!res.ok) throw new Error(`PushPlus message detail HTTP ${res.status}`);
  return htmlToText(await res.text());
}

async function fetchRecentMessages(config) {
  const accessKey = await getAccessKey(config);
  const items = await listMessages({
    accessKey,
    baseUrl: config.baseUrl,
    pageSize: config.pageSize,
  });
  const cutoff = config.lookbackMinutes > 0 ? Date.now() - config.lookbackMinutes * 60 * 1000 : 0;
  const messages = [];
  for (const item of items) {
    if (!item?.shortCode) continue;
    if (config.titleKeyword && !String(item.title || '').includes(config.titleKeyword)) continue;
    const receivedAt = parsePushPlusUpdateTime(item.updateTime);
    if (cutoff && receivedAt && receivedAt < cutoff) continue;
    const text = await getMessageDetail({ shortCode: item.shortCode, baseUrl: config.baseUrl });
    if (config.bodyKeyword && !text.includes(config.bodyKeyword)) continue;
    messages.push({
      shortCode: item.shortCode,
      title: item.title || '',
      updateTime: item.updateTime || '',
      receivedAt,
      text,
    });
  }
  return messages.sort((a, b) => Number(a.receivedAt || 0) - Number(b.receivedAt || 0));
}

module.exports = {
  fetchRecentMessages,
  getAccessKey,
  getMessageDetail,
  listMessages,
  parsePushPlusUpdateTime,
  pushPlusUrl,
};
