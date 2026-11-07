import {
  htmlToText,
  parsePushPlusUpdateTime,
  pushPlusAccessKeyRequest,
  pushPlusUrl,
} from './pipeline.js';

async function getAccessKey({ token, secretKey, baseUrl }) {
  const request = pushPlusAccessKeyRequest(baseUrl, { token, secretKey });
  const res = await fetch(request.url, request.options);
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

export { fetchRecentMessages };
