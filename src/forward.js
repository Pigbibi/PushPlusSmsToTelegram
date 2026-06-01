#!/usr/bin/env node
const { fetchRecentMessages } = require('./pushplus');
const { loadState, saveState, messageId, hasForwarded, markForwarded } = require('./state');
const { findInterceptRule, interceptShouldSilence, loadInterceptRules } = require('./interceptors');
const { buildTelegramText, splitTelegramText, parseSmsFields } = require('./text');
const { sendTelegramMessage } = require('./telegram');

function env(name, fallback = '') {
  return process.env[name] || fallback;
}

function requireEnv(name) {
  const value = env(name);
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function numberEnv(name, fallback) {
  const value = env(name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric env ${name}: ${value}`);
  return parsed;
}

function loadConfig() {
  return {
    pushPlus: {
      token: requireEnv('PUSHPLUS_TOKEN'),
      secretKey: requireEnv('PUSHPLUS_SECRET_KEY'),
      baseUrl: env('PUSHPLUS_BASE_URL', 'https://www.pushplus.plus'),
      pageSize: Math.max(1, Math.min(numberEnv('PUSHPLUS_PAGE_SIZE', 20), 50)),
      titleKeyword: env('MESSAGE_TITLE_KEYWORD', ''),
      bodyKeyword: env('MESSAGE_BODY_KEYWORD', ''),
      lookbackMinutes: numberEnv('POLL_LOOKBACK_MINUTES', 60),
    },
    telegram: {
      botToken: requireEnv('TELEGRAM_BOT_TOKEN'),
      chatId: requireEnv('TELEGRAM_CHAT_ID'),
    },
    stateFile: env('STATE_FILE', '.state/forwarded.json'),
    stateSecret: requireEnv('STATE_SECRET'),
    dryRun: env('DRY_RUN', 'false').toLowerCase() === 'true',
    interceptRules: loadInterceptRules(process.env),
  };
}

async function main() {
  const config = loadConfig();
  const state = loadState(config.stateFile);
  const messages = await fetchRecentMessages(config.pushPlus);
  console.log(`Fetched ${messages.length} PushPlus message(s) after filters.`);

  let forwarded = 0;
  let silenced = 0;
  for (const message of messages) {
    const id = messageId(message, config.stateSecret);
    if (hasForwarded(state, id)) continue;

    const fields = parseSmsFields(message.text);
    const interceptRule = findInterceptRule(message, config.interceptRules);
    if (interceptRule && interceptShouldSilence(interceptRule)) {
      console.log(`Silencing message by intercept rule ${JSON.stringify({
        rule: interceptRule.name || 'unnamed',
        title: message.title,
        updateTime: message.updateTime,
        sender: fields.sender || '',
        sentAt: fields.sentAt || '',
        textLength: message.text.length,
      })}`);
      markForwarded(state, id);
      silenced += 1;
      continue;
    }

    console.log(`Forwarding message ${JSON.stringify({
      title: message.title,
      updateTime: message.updateTime,
      sender: fields.sender || '',
      sentAt: fields.sentAt || '',
      textLength: message.text.length,
      dryRun: config.dryRun,
    })}`);

    if (!config.dryRun) {
      for (const chunk of splitTelegramText(buildTelegramText(message))) {
        await sendTelegramMessage({ ...config.telegram, text: chunk });
      }
    }
    markForwarded(state, id);
    forwarded += 1;
  }

  saveState(config.stateFile, state);
  console.log(`Forwarded ${forwarded} new message(s), silenced ${silenced} intercepted message(s).`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
