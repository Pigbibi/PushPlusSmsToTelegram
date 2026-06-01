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
  const lines = [
    '📩 <b>PushPlus SMS</b>',
    `发件人：${escapeTelegramHtml(fields.sender || '-')}`,
    `发件时间：${escapeTelegramHtml(fields.sentAt || '-')}`,
    '<b>短信内容：</b>',
    escapeTelegramHtml(smsContent || '-'),
  ];
  return lines.join('\n');
}

function splitTelegramText(text, maxLength = 3900) {
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

module.exports = {
  decodeHtmlEntities,
  extractSmsContent,
  htmlToText,
  parseSmsFields,
  buildTelegramText,
  splitTelegramText,
};
