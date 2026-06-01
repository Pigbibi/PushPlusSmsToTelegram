# PushPlusSmsToTelegram

English | [简体中文](README.md)

Actively forward SMS messages received by PushPlus to a Telegram bot. This is useful when an SMS forwarding device can only send to PushPlus, but you want to receive SMS content or verification codes in Telegram in near real time.

Recommended flow:

```text
SMS forwarder -> PushPlus -> Cloudflare Pages Relay -> Cloudflare Worker -> Telegram
```

This is event-driven: **Cloudflare is called only when PushPlus receives a new message**. There is no Cloudflare Cron and no scheduled GitHub Actions polling.

## Features

- Active webhook forwarding without fixed polling delay;
- Telegram messages show only sender, SMS sent time, and SMS content;
- Optional title/body keyword filters;
- KV-based deduplication to avoid forwarding the same PushPlus message twice;
- Manual GitHub Actions fallback for backfill/debugging, disabled by default for schedules;
- Manual GitHub Actions deployment workflow.

## Why a Pages Relay?

In testing, PushPlus could fail to reach `workers.dev`, while `pages.dev` was reachable. This repository therefore uses a very small Pages Relay by default:

```text
PushPlus -> pages.dev Relay -> workers.dev Worker -> Telegram
```

The relay only does two things:

1. Validate the `RELAY_TOKEN` in the URL;
2. Forward the original request to the Worker.

The relay does not store SMS content and does not need the Telegram token.

If you use a custom Worker domain that PushPlus can reach, you can skip the relay and point PushPlus directly to `/pushplus/webhook/<CALLBACK_TOKEN>` on the Worker.

## Telegram message format

The Telegram message contains:

- sender, for example `10001`;
- SMS sent time;
- SMS content, without redaction.

PushPlus title, short links, `#SMS`, local phone number, uptime, carrier, signal strength, and other device metadata are hidden automatically.

## Deploy the Cloudflare Worker

```bash
cp wrangler.example.toml wrangler.toml
npx wrangler kv namespace create FORWARDED_KV
# Put the returned id into wrangler.toml

npx wrangler secret put CALLBACK_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put STATE_SECRET

npx wrangler deploy
```

Use long random strings for `CALLBACK_TOKEN` and `STATE_SECRET`:

```bash
openssl rand -hex 32
```

Health check:

```text
https://your-worker.workers.dev/health
```

## Deploy the Cloudflare Pages Relay

```bash
cd pages-relay
npx wrangler pages project create pushplus-sms-to-telegram --production-branch main --compatibility-date 2026-05-31
npx wrangler pages secret put RELAY_TOKEN --project-name pushplus-sms-to-telegram
npx wrangler pages deploy dist --project-name pushplus-sms-to-telegram --branch main
```

`RELAY_TOKEN` can be the same value as `CALLBACK_TOKEN`. The webhook URL will look like this:

```text
https://pushplus-sms-to-telegram.pages.dev/pushplus/webhook/YOUR_RELAY_TOKEN
```

Relay health check:

```text
https://pushplus-sms-to-telegram.pages.dev/health
```

## Configure PushPlus active webhook

Use a plain-text body for the PushPlus custom webhook. This avoids breaking JSON when SMS content contains newlines or quotes:

```text
标题：{title}
链接：{url}

{content}
```

You can create/update the PushPlus custom webhook and switch the user token's default channel to that webhook with:

```bash
PUSHPLUS_TOKEN=... \
PUSHPLUS_SECRET_KEY=... \
PUSHPLUS_WEBHOOK_URL=https://pushplus-sms-to-telegram.pages.dev/pushplus/webhook/YOUR_RELAY_TOKEN \
npm run configure:pushplus
```

The script prints only a redacted webhook URL and never prints token values.

## GitHub Secrets

To use `.github/workflows/deploy.yml`, configure these repository Secrets:

| Secret | Description |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers, KV, and Pages edit permissions. |
| `CALLBACK_TOKEN` | Token that protects the Worker webhook/callback endpoint. |
| `RELAY_TOKEN` | Token that protects the Pages Relay endpoint. Usually the same as `CALLBACK_TOKEN`. |
| `PUSHPLUS_TOKEN` | PushPlus user token. |
| `PUSHPLUS_SECRET_KEY` | PushPlus Open API secretKey. |

The Worker itself also needs these Cloudflare Secrets:

| Secret | Description |
| --- | --- |
| `CALLBACK_TOKEN` | Protects the Worker endpoint. |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from BotFather. |
| `TELEGRAM_CHAT_ID` | Telegram chat id that receives forwarded messages. |
| `STATE_SECRET` | Random string used to generate KV deduplication keys. |

## Worker Variables

| Variable | Default | Description |
| --- | --- | --- |
| `MESSAGE_BODY_KEYWORD` | empty | Body filter. Use `#SMS` to forward only SMS messages. |
| `MESSAGE_TITLE_KEYWORD` | empty | Title filter. Use `短信转发` if your device always uses that title. |

## GitHub Actions

### Deploy active PushPlus relay

`.github/workflows/deploy.yml` is a manual deployment workflow. It runs:

1. tests and lint;
2. Worker deployment;
3. Pages Relay deployment;
4. PushPlus webhook configuration.

It does not run on a schedule.

### Forward PushPlus SMS to Telegram

`.github/workflows/forward.yml` is a manual fallback/backfill workflow. It reads recent messages from PushPlus Open API and forwards them. It is intended for debugging or historical backfill only. It has no schedule and will not poll automatically.

## Local manual backfill

```bash
npm ci
PUSHPLUS_TOKEN=... \
PUSHPLUS_SECRET_KEY=... \
TELEGRAM_BOT_TOKEN=... \
TELEGRAM_CHAT_ID=... \
STATE_SECRET=local-dev-secret \
DRY_RUN=true \
npm run forward
```

After checking the logs, run again with `DRY_RUN=false` to send messages for real.

## Compatibility: PushPlus delivery callback

The Worker still supports the official PushPlus delivery callback:

```text
https://your-worker.workers.dev/pushplus/callback/YOUR_CALLBACK_TOKEN
```

This callback contains `shortCode` and delivery status only. It does not include the full body, so the Worker fetches `/shortMessage/{shortCode}` to read the content. The custom webhook mode is preferred in production because it pushes `{content}` directly to the Worker.

## Security notes

- Never commit tokens, secretKeys, Telegram bot tokens, chat ids, or cookies;
- The public `state` branch stores only HMAC deduplication ids, not SMS bodies or PushPlus `shortCode` values;
- Telegram receives SMS content, including verification codes. Make sure the bot and chat are trusted;
- If any credential was exposed in chat, logs, or screenshots, rotate it and update the corresponding platform configuration.
