# Configuration

Keep account-specific values in Cloudflare secrets, GitHub Actions secrets, or
an untracked local `wrangler.toml`. The repository's
[`wrangler.example.toml`](../wrangler.example.toml) contains only placeholders
and non-sensitive defaults.

## Worker secrets

| Secret | Required | Purpose |
| --- | --- | --- |
| `CALLBACK_TOKEN` | yes | Authenticates Worker webhook and callback paths |
| `TELEGRAM_BOT_TOKEN` | for Telegram delivery | Telegram Bot API credential |
| `TELEGRAM_CHAT_ID` | for Telegram delivery | Destination chat |
| `STATE_SECRET` | yes | Salts HMAC-style KV keys used for deduplication |
| `INBOX_TOKEN` | for `/messages` | Bearer token for the short-lived protected inbox |
| `PUSHPLUS_TOKEN` | for cleanup | PushPlus user token |
| `PUSHPLUS_SECRET_KEY` | for cleanup | PushPlus Open API secret key |

Use independent random values for callback, inbox, and state secrets. Rotating
`STATE_SECRET` changes deduplication keys and may allow old messages to be
handled again.

The local webhook helper and GitHub Actions backfill also use
`PUSHPLUS_TOKEN` and `PUSHPLUS_SECRET_KEY` as process environment variables.
Those values are separate from secrets stored in a Worker deployment.

## Pages relay settings

| Setting | Required | Purpose |
| --- | --- | --- |
| `RELAY_TOKEN` | yes | Authenticates requests accepted by the relay |
| `WORKER_ORIGIN` | yes for forks | Origin of the destination Worker |

The bundled relay falls back to a maintainer deployment when `WORKER_ORIGIN` is
absent. Every fork or independent deployment must override it with its own
Worker origin.

## Message filters

| Variable | Default | Purpose |
| --- | --- | --- |
| `MESSAGE_TITLE_KEYWORD` | empty | Accept only messages whose title contains this text |
| `MESSAGE_BODY_KEYWORD` | empty | Accept only messages whose normalized body contains this text |

Filters run after intercept rules. A filtered message receives a short-lived KV
marker so repeated callbacks do not cause repeated work.

## Intercept rules

Intercept rules can suppress Telegram delivery, store a message in the
protected inbox, or do both.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SMS_INTERCEPT_PRESETS` | empty | Comma-separated built-in preset IDs |
| `SMS_INTERCEPT_RULES` | empty | JSON object or array of custom rules |
| `TELECOM_SMS_SENDER` | `10001` | Verification-code sender for the telecom preset |
| `TELECOM_SUCCESS_SMS_SENDER` | `10000` | Success-receipt sender for the telecom preset |
| `TELECOM_CONFIRM_PRODUCT_KEYWORD` | empty | Optional product match for confirmation and success SMS |
| `TELECOM_CONFIRM_PLAN_ID` | empty | Optional plan ID match for confirmation and success SMS |

Custom example:

```json
[
  {
    "name": "bank-otp",
    "action": "silence-store",
    "senderIncludes": "95588",
    "textIncludesAll": ["验证码"]
  }
]
```

Supported match fields:

- `sender`, `senderIncludes`
- `titleIncludes`, `titleIncludesAll`, `titleIncludesAny`
- `textIncludes`, `textIncludesAll`, `textIncludesAny`
- `bodyIncludes`, `bodyIncludesAll`, `bodyIncludesAny`

Actions:

- `silence` suppresses Telegram delivery;
- `store` keeps the Telegram notification and writes the protected inbox;
- `silence-store` does both;
- `store: true` may be added to a rule independently of its action.

`SMS_INTERCEPT_PRESETS=telecom-claim-silent` stores and silences recognized
Beijing Telecom verification and success messages. It is disabled by default.

## Protected inbox

Stored entries live in the `FORWARDED_KV` namespace for six hours. Requests must
use the configured bearer token:

```bash
curl -H "Authorization: Bearer $INBOX_TOKEN" \
  'https://your-worker.example.com/messages?since=0&sender=10001'
```

The equivalent `/pushplus/messages` path is also accepted. Do not place the
token in query strings, logs, or repository variables.

## PushPlus record cleanup

The example Wrangler configuration includes a daily Cron trigger, but cleanup
does nothing until explicitly enabled.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUSHPLUS_CLEANUP_ENABLED` | `false` | Enable scheduled deletion |
| `PUSHPLUS_CLEANUP_RETENTION_DAYS` | `90` | Minimum record age |
| `PUSHPLUS_CLEANUP_PAGE_SIZE` | `50` | Records read per page; maximum 50 |
| `PUSHPLUS_CLEANUP_MAX_PAGES` | `10` | Maximum pages scanned per run |
| `PUSHPLUS_CLEANUP_MAX_DELETES` | `20` | Maximum records deleted per run |
| `PUSHPLUS_CLEANUP_TITLE_KEYWORD` | message title filter | Limit cleanup to matching titles |
| `PUSHPLUS_CLEANUP_REQUIRE_FORWARDED` | `true` | Delete only records with a current deduplication marker |
| `PUSHPLUS_BASE_URL` | `https://www.pushplus.plus` | PushPlus API origin override |

PushPlus deletion is irreversible and affects all receivers of the deleted
message. Keep `PUSHPLUS_CLEANUP_REQUIRE_FORWARDED=true`, set a narrow title
keyword when the account contains unrelated messages, and test with cleanup
disabled before opting in.

Keep `{url}` in the custom webhook body so the Worker can derive the short code
used by cleanup. The deduplication marker TTL is longer than the default cleanup
retention window.
