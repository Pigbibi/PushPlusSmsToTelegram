# PushPlusSmsToTelegram

Forward SMS notifications received by PushPlus to a Telegram chat through Cloudflare.

This project is intended for setups where an SMS forwarding device can send messages to PushPlus, but you prefer to receive the SMS content, including verification codes, in Telegram.

## What it does

- Receives PushPlus custom webhook requests and forwards matching SMS content to Telegram.
- Uses Cloudflare Worker KV to deduplicate messages before sending them.
- Supports optional title/body filters and configurable intercept rules before Telegram notification.
- Can silence selected SMS classes, such as verification codes consumed by another automation, and optionally store only those matches in a short-lived protected inbox.
- Sends a concise Telegram message with sender, SMS time, and SMS body when no intercept rule silences the message.
- Includes a Cloudflare Pages relay for environments where PushPlus cannot reach a `workers.dev` endpoint directly.
- Keeps a manual GitHub Actions backfill workflow for debugging or one-off historical forwarding.

## Architecture

Default deployment:

```text
SMS forwarder -> PushPlus -> Cloudflare Pages Relay -> Cloudflare Worker -> Telegram
```

The Pages relay is intentionally small. It validates `RELAY_TOKEN` and forwards the original request to the Worker. It does not store SMS content and does not need the Telegram bot token.

If PushPlus can reach your Worker through a custom domain, you can skip the relay and send PushPlus webhooks directly to:

```text
https://your-worker.example.com/pushplus/webhook/YOUR_CALLBACK_TOKEN
```

## Quick deployment

### 1. Prepare Cloudflare KV

```bash
cp wrangler.example.toml wrangler.toml
npx wrangler kv namespace create FORWARDED_KV
```

Put the returned KV namespace id into `wrangler.toml`.

### 2. Set Worker secrets

```bash
npx wrangler secret put CALLBACK_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put STATE_SECRET
```

Use long random values for `CALLBACK_TOKEN` and `STATE_SECRET`:

```bash
openssl rand -hex 32
```

### 3. Deploy the Worker

```bash
npx wrangler deploy
```

Health check:

```text
https://your-worker.workers.dev/health
```

### 4. Deploy the Pages relay

```bash
cd pages-relay
npx wrangler pages project create pushplus-sms-to-telegram --production-branch main --compatibility-date 2026-05-31
npx wrangler pages secret put RELAY_TOKEN --project-name pushplus-sms-to-telegram
npx wrangler pages deploy dist --project-name pushplus-sms-to-telegram --branch main
```

`RELAY_TOKEN` can use the same value as `CALLBACK_TOKEN`.

Relay webhook URL:

```text
https://pushplus-sms-to-telegram.pages.dev/pushplus/webhook/YOUR_RELAY_TOKEN
```

Relay health check:

```text
https://pushplus-sms-to-telegram.pages.dev/health
```

### 5. Configure the PushPlus webhook

Use a plain-text PushPlus custom webhook body:

```text
标题：{title}
链接：{url}

{content}
```

Plain text is safer than JSON because SMS content may contain newlines or quotes.

You can create or update the PushPlus custom webhook with:

```bash
PUSHPLUS_TOKEN=... \
PUSHPLUS_SECRET_KEY=... \
PUSHPLUS_WEBHOOK_URL=https://pushplus-sms-to-telegram.pages.dev/pushplus/webhook/YOUR_RELAY_TOKEN \
npm run configure:pushplus
```

The script redacts the webhook URL in output and does not print token values.

By default, `npm run configure:pushplus` also sets the user-token default channel to this webhook. According to PushPlus, messages without an explicit `channel` use the configured default channel, so this may replace the normal WeChat/App PushPlus notification with webhook delivery. If your sender can explicitly choose channels and you want to keep the normal PushPlus notification, set `PUSHPLUS_SET_USER_DEFAULT=false` and send through PushPlus multi-channel delivery instead.

## Configuration

### Worker secrets

| Secret | Purpose |
| --- | --- |
| `CALLBACK_TOKEN` | Protects the Worker webhook and callback endpoints. |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from BotFather. |
| `TELEGRAM_CHAT_ID` | Telegram chat id that receives forwarded messages. |
| `STATE_SECRET` | Random string used to generate KV deduplication keys. |

### Pages relay secrets

| Secret | Purpose |
| --- | --- |
| `RELAY_TOKEN` | Protects the relay endpoint. Usually the same as `CALLBACK_TOKEN`. |

### Optional Worker variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `MESSAGE_BODY_KEYWORD` | empty | Forward only messages whose body contains this value. Use `#SMS` if your forwarder marks SMS messages that way. |
| `MESSAGE_TITLE_KEYWORD` | empty | Forward only messages whose title contains this value. For example, use `短信转发` if your device always uses that title. |
| `PUSHPLUS_BASE_URL` | `https://www.pushplus.plus` | Override the PushPlus base URL used by callback compatibility mode. |
| `SMS_INTERCEPT_PRESETS` | empty | Comma-separated built-in intercept presets. Currently supports `telecom-claim-silent`. |
| `SMS_INTERCEPT_RULES` | empty | JSON object or array of custom intercept rules. Matching rules with `action: "silence"` are marked as handled and are not sent to Telegram. |
| `TELECOM_SMS_SENDER` | `10001` | Sender used by the optional `telecom-claim-silent` preset. |
| `TELECOM_CONFIRM_PRODUCT_KEYWORD` | empty | Optional product keyword used by the optional `telecom-claim-silent` confirmation rule. |
| `TELECOM_CONFIRM_PLAN_ID` | empty | Optional plan id used by the optional `telecom-claim-silent` confirmation rule. |

### Intercept rules

Intercept rules run after a PushPlus message body is available and before Telegram notification. They are intended for cases where another automation consumes the SMS from PushPlus directly, or where selected messages should be acknowledged but not notified.

Custom rule example:

```json
[
  {
    "name": "bank-otp",
    "action": "silence",
    "senderIncludes": "95588",
    "textIncludesAll": ["验证码"]
  }
]
```

Set `action` to `silence` to suppress Telegram notification. Set `store: true` to additionally write the match into the protected inbox. If you want a custom rule to store but still notify, use `action: "store"`; if you want to store and suppress notification, use `action: "silence-store"` or `action: "silence"` with `store: true`.

Supported match fields:

- `sender` / `senderIncludes`
- `titleIncludes`, `titleIncludesAll`, `titleIncludesAny`
- `textIncludes`, `textIncludesAll`, `textIncludesAny`
- `bodyIncludes`, `bodyIncludesAll`, `bodyIncludesAny`

`SMS_INTERCEPT_PRESETS=telecom-claim-silent` is a built-in convenience preset for Beijing Telecom monthly-claim verification SMS. It is disabled by default so the open-source default remains a general PushPlus-to-Telegram forwarder.

Rules can also set `store: true` or use an action containing `store` to write matching SMS into a short-lived, token-protected inbox. The built-in `telecom-claim-silent` preset stores matches for up to 6 hours so another workflow can fetch them from:

```text
GET /messages?since=...&sender=10001
Authorization: Bearer <INBOX_TOKEN>
```

Without `store`, only the deduplication key is written. With `store`, the matching SMS body is temporarily stored in Worker KV and expires automatically.

## Telegram message format

Forwarded Telegram messages contain:

- sender, for example `10001`;
- SMS sent time;
- SMS content, without redaction.

PushPlus titles, short links, `#SMS`, local phone number, uptime, carrier, signal strength, and other device metadata are removed from the Telegram message when recognized.

## GitHub Actions

The workflows are optional. They are useful if you want manual deployment or manual backfill from GitHub.

### Manual deployment

`.github/workflows/deploy.yml` runs on `workflow_dispatch` only. It performs tests, lint checks, Worker deployment, Pages relay deployment, and PushPlus webhook configuration.

Required repository secrets:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers, KV, and Pages edit permissions. |
| `FORWARDED_KV_NAMESPACE_ID` | Cloudflare KV namespace id for `FORWARDED_KV`. |
| `CALLBACK_TOKEN` | Worker webhook token. |
| `RELAY_TOKEN` | Pages relay token. |
| `INBOX_TOKEN` | Optional token for the short-lived `/messages` inbox. Falls back to `CALLBACK_TOKEN` if omitted. |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token used by the Worker for non-silenced messages. |
| `TELEGRAM_CHAT_ID` | Telegram chat id used by the Worker for non-silenced messages. |
| `STATE_SECRET` | Random string used to generate Worker KV deduplication keys. |
| `PUSHPLUS_TOKEN` | PushPlus user token. |
| `PUSHPLUS_SECRET_KEY` | PushPlus Open API secret key. |

Optional repository variables are passed into `wrangler.toml` during deployment:

- `SMS_INTERCEPT_PRESETS`
- `SMS_INTERCEPT_RULES`
- `TELECOM_SMS_SENDER`
- `TELECOM_CONFIRM_PRODUCT_KEYWORD`
- `TELECOM_CONFIRM_PLAN_ID`
- `PUSHPLUS_SET_USER_DEFAULT`

### Manual backfill

`.github/workflows/forward.yml` also runs on `workflow_dispatch` only. It reads recent messages from the PushPlus Open API and forwards messages that have not been recorded in state.

Use it for debugging or one-off backfill. It is not scheduled and does not poll automatically.

## Local backfill

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

Review the logs first. Run again with `DRY_RUN=false` only when you are ready to send Telegram messages.

## Compatibility callback

The Worker also supports the official PushPlus delivery callback endpoint:

```text
https://your-worker.workers.dev/pushplus/callback/YOUR_CALLBACK_TOKEN
```

That callback contains `shortCode` and delivery status only. It does not include the full SMS body, so the Worker fetches `/shortMessage/{shortCode}` from PushPlus before forwarding. Prefer the custom webhook mode for normal deployments because it sends `{content}` directly to the Worker.

## Security notes

- Never commit tokens, secret keys, Telegram bot tokens, chat ids, cookies, or personal SMS content.
- Telegram receives the SMS content, including verification codes. Use a trusted bot and chat.
- The Worker normally stores only HMAC-based deduplication keys in KV, not SMS bodies or PushPlus `shortCode` values. Intercept rules with `store` enabled temporarily store matching SMS bodies in KV for the protected inbox.
- Rotate credentials if they were exposed in chat, logs, screenshots, or repository history.
- Keep `wrangler.toml` local if it contains account-specific settings. Use `wrangler.example.toml` as the shareable template.

## Development

```bash
npm ci
npm test
npm run lint
```
