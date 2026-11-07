// Shared SMS message pipeline.
//
// SMS arrives as PushPlus HTML, as a signed SmsForwarder payload and as JSON
// from a hardware gateway. All three converge on one text shape: sender, sent
// time and body. Field labels, intercept rules, dedupe identities and Telegram
// rendering have to agree across those ingresses, so they live here.

const TELEGRAM_MAX_LENGTH = 3900;
const PUSHPLUS_BASE_URL = 'https://www.pushplus.plus';

// The same value arrives under different labels depending on the sender, so
// every known spelling is searched and the first match wins.
const SENDER_LABELS = ['发件号码', '发信号码', '发送号码', '发送者', 'sender', 'from'];
const SENT_AT_LABELS = ['发件时间', '发信时间', '发送时间', '时间', 'sentAt', 'time'];
const METADATA_LABELS = [
  '标题',
  '链接',
  ...SENDER_LABELS,
  ...SENT_AT_LABELS,
  '本机号码',
  '开机时长',
  '运营商',
  '信号',
];

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
    sender: pickField(text, SENDER_LABELS),
    sentAt: pickField(text, SENT_AT_LABELS),
  };
}

function isLabeledLine(line, labels) {
  return labels.some(label => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped}\\s*[:：]`).test(line);
  });
}

// PushPlus detail pages and device payloads append metadata around the body.
// The body is whatever precedes the first metadata block or the `#SMS` marker.
function extractSmsContent(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const contentLines = [];
  for (const line of lines) {
    if (/^#SMS\b/i.test(line)) {
      if (contentLines.length) break;
      continue;
    }
    if (isLabeledLine(line, METADATA_LABELS)) {
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

// Telegram rejects messages over 4096 characters; chunks are cut on a newline
// when one exists in the last 40% of the window.
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

function compactText(text) {
  return String(text || '').replace(/\s+/g, '');
}

function listValue(value) {
  if (Array.isArray(value)) return value.filter(item => item !== undefined && item !== null && item !== '');
  if (value === undefined || value === null || value === '') return [];
  return [value];
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
  const successSender = env.TELECOM_SUCCESS_SMS_SENDER || '10000';
  const confirmTextIncludes = ['【办理提醒】', '验证码是', '中国电信北京公司', '办理'];
  const successTextIncludes = ['【办理提醒】', 'wap电子渠道', '成功办理', '方案编号'];
  for (const value of [env.TELECOM_CONFIRM_PRODUCT_KEYWORD, env.TELECOM_CONFIRM_PLAN_ID]) {
    if (!value) continue;
    confirmTextIncludes.push(value);
    successTextIncludes.push(value);
  }

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
    textIncludesAny: ['统一身份认证', '广东政务服务', '粤省事', '政务服务网', '深圳社保局'],
  };
  if (env.GUANGDONG_SMS_SENDER) rule.senderIncludes = env.GUANGDONG_SMS_SENDER;
  if (env.GUANGDONG_SMS_KEYWORD) rule.textIncludesAny = [env.GUANGDONG_SMS_KEYWORD];
  return [rule];
}

// One registry so a preset that can be leased and its rules cannot drift apart.
const PRESET_RULES = {
  'telecom-claim-silent': telecomClaimPresetRules,
  'guangdong-sso-auth': guangdongSsoPresetRules,
};

export const WORKFLOW_LEASED_PRESETS = new Set(Object.keys(PRESET_RULES));

function interceptPresetRules(preset, env) {
  const build = PRESET_RULES[preset];
  return build ? build(env) : [];
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function parseCustomRules(value) {
  if (!value) return [];
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function loadInterceptRules(env = {}) {
  const presets = splitCsv(env.SMS_INTERCEPT_PRESETS);
  if (isTruthy(env.TELECOM_CLAIM_SILENT)) presets.push('telecom-claim-silent');

  const rules = [];
  for (const preset of new Set(presets)) {
    rules.push(...interceptPresetRules(preset, env));
  }
  rules.push(...parseCustomRules(env.SMS_INTERCEPT_RULES));
  return rules;
}

function findInterceptRule(message, rules) {
  return (rules || []).find(rule => messageMatchesRule(message, rule)) || null;
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

// PushPlus reports local time without an offset, or a numeric epoch in seconds
// or milliseconds; local time is interpreted as UTC+8.
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

function pushPlusUrl(baseUrl, pathname) {
  const base = String(baseUrl || PUSHPLUS_BASE_URL);
  return new URL(pathname, base.endsWith('/') ? base : `${base}/`);
}

function pushPlusAccessKeyRequest(baseUrl, { token, secretKey }) {
  return {
    url: pushPlusUrl(baseUrl, '/api/common/openApi/getAccessKey'),
    options: {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ token, secretKey }),
    },
  };
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input || ''));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function messageSourceIds(message, text) {
  const sourceIds = new Set();
  const explicitSourceId = message.sourceId || message.shortCode || message.url || '';
  if (explicitSourceId) sourceIds.add(String(explicitSourceId));
  if (message.shortCode) sourceIds.add(String(message.shortCode));
  if (!sourceIds.size && text) {
    sourceIds.add(`content:${await sha256Hex(`${message.title || ''}\n${text}`)}`);
  }

  // The same SMS reaches the Worker through more than one ingress with
  // different identifiers, so sender, sent time and body form a fingerprint.
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

export {
  PUSHPLUS_BASE_URL,
  buildTelegramText,
  extractSmsContent,
  findInterceptRule,
  htmlToText,
  interceptPresetRules,
  interceptShouldSilence,
  interceptShouldStore,
  isTruthy,
  loadInterceptRules,
  messageMatchesRule,
  parseSmsFields,
  parsePushPlusUpdateTime,
  pickField,
  pushPlusAccessKeyRequest,
  pushPlusUrl,
  sha256Hex,
  splitTelegramText,
};
