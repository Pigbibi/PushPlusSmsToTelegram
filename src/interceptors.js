const { parseSmsFields } = require('./text');

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

function telecomClaimPresetRules(env = {}) {
  const sender = env.TELECOM_SMS_SENDER || '10001';
  const confirmTextIncludes = ['【办理提醒】', '验证码是', '中国电信北京公司', '办理'];
  if (env.TELECOM_CONFIRM_PRODUCT_KEYWORD) confirmTextIncludes.push(env.TELECOM_CONFIRM_PRODUCT_KEYWORD);
  if (env.TELECOM_CONFIRM_PLAN_ID) confirmTextIncludes.push(env.TELECOM_CONFIRM_PLAN_ID);

  return [
    {
      name: 'telecom-claim-login',
      action: 'silence',
      senderIncludes: sender,
      textIncludesAll: ['验证码', '感谢使用北京电信掌上营业厅'],
    },
    {
      name: 'telecom-claim-confirm',
      action: 'silence',
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

function loadInterceptRules(env = process.env) {
  const presets = splitCsv(env.SMS_INTERCEPT_PRESETS);
  if (/^(1|true|yes)$/i.test(String(env.TELECOM_CLAIM_SILENT || ''))) {
    presets.push('telecom-claim-silent');
  }

  const rules = [];
  for (const preset of presets) {
    if (preset === 'telecom-claim-silent') {
      rules.push(...telecomClaimPresetRules(env));
    }
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

module.exports = {
  compactText,
  findInterceptRule,
  interceptAction,
  loadInterceptRules,
  messageMatchesRule,
  telecomClaimPresetRules,
};
