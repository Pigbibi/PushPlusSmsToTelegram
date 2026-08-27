# PushPlusSmsToTelegram

[简体中文](README_CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)](package.json)

Forward SMS notifications received by PushPlus to Telegram through a Cloudflare
Worker. The service provides deduplication, content filters, optional intercept
rules, and a short-lived protected inbox for another authorized automation.

## Architecture

Direct deployment:

```text
SMS forwarder → PushPlus → Cloudflare Worker → Telegram
```

Optional relay deployment:

```text
SMS forwarder → PushPlus → Cloudflare Pages relay → Worker → Telegram
```

Use the relay only when PushPlus cannot reach the Worker endpoint. It validates
a relay token and forwards the request without storing the body.

Recommended resilient ingress:

```text
SMS forwarder ──primary──→ signed direct Worker webhook ──→ Telegram
              └─on final failure─→ PushPlus → relay → Worker ──┘
```

SmsForwarder 3.2.0 or newer can run the direct webhook first and use PushPlus
only after the primary channel finally fails. Both paths reuse the same filters,
workflow-scoped intercepts, Telegram delivery, and content-fingerprint dedupe.

## Features

- Receives PushPlus custom webhooks and callback notifications.
- Receives HMAC-signed, timestamped direct SmsForwarder webhooks.
- Uses Cloudflare KV to deduplicate messages before Telegram delivery.
- Deduplicates equivalent direct and PushPlus copies by SMS content fingerprint.
- Filters by title or body keyword.
- Removes recognized device metadata from Telegram messages.
- Applies configurable intercept rules before notification.
- Can place selected messages in a token-protected inbox with a six-hour TTL.
- Can recover a bounded set of recent messages missed by realtime delivery.
- Can delete bounded sets of old PushPlus records on a Cloudflare Cron trigger.
- Includes manual GitHub Actions workflows for deployment and backfill.
- Quietly monitors the Worker, relay, PushPlus production webhook, and Telegram destination hourly.

## Requirements

- Node.js 20 or newer for local development
- A Cloudflare account with Workers and KV
- A PushPlus account that can send a custom webhook
- A Telegram bot and destination chat
- Wrangler for manual deployment

## Quick start

### 1. Create a KV namespace

```bash
npm ci
cp wrangler.example.toml wrangler.toml
npx wrangler kv namespace create FORWARDED_KV
```

Replace `replace-with-your-kv-namespace-id` in `wrangler.toml` with the returned
namespace ID. Keep the real `wrangler.toml` out of Git.

### 2. Add Worker secrets

```bash
npx wrangler secret put CALLBACK_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put STATE_SECRET
npx wrangler secret put SMSFORWARDER_WEBHOOK_SECRET
```

Generate long random values for callback and state secrets:

```bash
openssl rand -hex 32
```

Optional features require additional secrets:

```bash
npx wrangler secret put INBOX_TOKEN
npx wrangler secret put PUSHPLUS_TOKEN
npx wrangler secret put PUSHPLUS_SECRET_KEY
```

### 3. Deploy and test the Worker

```bash
npm test
npm run lint
npx wrangler deploy
```

Health endpoint:

```text
https://your-worker.example.com/health
```

Direct custom-webhook endpoint:

```text
https://your-worker.example.com/pushplus/webhook/YOUR_CALLBACK_TOKEN
```

Hardware SIM gateway endpoint (standard POST JSON):

```text
https://your-worker.example.com/device/webhook/YOUR_HARDWARE_WEBHOOK_TOKEN
```

Keep the existing PushPlus channel enabled and put this direct channel first;
see [Configuration](docs/configuration.md#hardware-sim-gateway-webhook).

Signed SmsForwarder endpoint:

```text
https://your-worker.example.com/smsforwarder/webhook
```

Configure the SmsForwarder channel with JSON fields for `sourceId`, `sender`,
`sentAt`, `content`, `timestamp`, and `sign`; see
[Configuration](docs/configuration.md#smsforwarder-direct-webhook). The channel
secret must match `SMSFORWARDER_WEBHOOK_SECRET`.

Prefer a Cloudflare custom domain when PushPlus cannot reach a `workers.dev`
address.

### 4. Optionally deploy the Pages relay

```bash
cd pages-relay
npx wrangler pages project create your-pages-project \
  --production-branch main
npx wrangler pages secret put RELAY_TOKEN \
  --project-name your-pages-project
npx wrangler pages secret put WORKER_ORIGIN \
  --project-name your-pages-project
npx wrangler pages deploy dist \
  --project-name your-pages-project --branch main
```

Set `WORKER_ORIGIN` to your deployed Worker origin, without a trailing path.
This is required for forks: the bundled relay has a maintainer deployment as
its fallback upstream and must not be used unchanged for another deployment.

Relay webhook endpoint:

```text
https://your-pages-project.pages.dev/pushplus/webhook/YOUR_RELAY_TOKEN
```

`RELAY_TOKEN` may use the same random value as `CALLBACK_TOKEN`.

### 5. Configure PushPlus

Use a plain-text custom webhook body:

```text
标题：{title}
链接：{url}

{content}
```

Keep `{url}` when scheduled PushPlus record cleanup is enabled; the Worker uses
its short code to correlate handled records.

The repository includes a configuration helper:

```bash
PUSHPLUS_TOKEN='replace-me' \
PUSHPLUS_SECRET_KEY='replace-me' \
PUSHPLUS_WEBHOOK_URL='https://your-endpoint/pushplus/webhook/YOUR_TOKEN' \
npm run configure:pushplus
```

The helper can change the PushPlus user's default delivery channel. Set
`PUSHPLUS_SET_USER_DEFAULT=false` when the sender selects channels explicitly
and the existing default must remain unchanged.

## Message handling

Messages pass through these stages:

1. authenticate the webhook or callback token;
2. load the message body when a callback supplies only a short code;
3. reject an already handled message using KV state;
4. apply intercept rules;
5. apply title and body filters;
6. normalize SMS metadata and send the result to Telegram;
7. store a deduplication marker with a bounded TTL.

Optional best-effort hourly recovery uses the same filters, intercept rules,
and KV state. It checks PushPlus delivery status and can recover failed messages
that remain visible in the Open API list. PushPlus may omit connection-timeout
failures from that list, so recovery is not a substitute for a reachable relay.
It is disabled until an operator sets an activation timestamp and enables it
explicitly. See [Configuration](docs/configuration.md#missed-message-recovery).

The protected inbox is available only when `INBOX_TOKEN` is configured:

```http
GET /messages?since=...&sender=10001
Authorization: Bearer <INBOX_TOKEN>
```

Only rules configured to store a match write SMS bodies to that inbox. Stored
items expire automatically after six hours.

## Documentation

- [Configuration](docs/configuration.md)
- [Deployment and operations](docs/operations.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)

## Security

This service processes personal SMS content and may forward verification codes.
Use a private Telegram chat, strong independent tokens, and a dedicated
Cloudflare deployment. Never commit Worker secrets, PushPlus credentials,
Telegram credentials, chat IDs, SMS bodies, or a real `wrangler.toml`.

Follow [SECURITY.md](SECURITY.md) for vulnerability reports.

## License

PushPlusSmsToTelegram is available under the [MIT License](LICENSE).
