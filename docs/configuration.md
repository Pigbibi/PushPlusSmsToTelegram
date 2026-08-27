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

`guangdong-sso-auth` is also available as a built-in preset for Guangdong SSO
verification messages. Static presets remain active until the next deployment
removes them, so workflow automation should use a lease instead.

## Workflow-scoped intercept leases

An authenticated workflow can activate a supported intercept preset for a
bounded period without changing repository variables or redeploying the
Worker:

```http
PUT /intercepts/leases/<preset>/<lease-id>
Authorization: Bearer <INBOX_TOKEN>
Content-Type: application/json

{"ttlSeconds":3600}
```

Release the same lease in an always-run cleanup step:

```http
DELETE /intercepts/leases/<preset>/<lease-id>
Authorization: Bearer <INBOX_TOKEN>
```

Supported presets are `telecom-claim-silent` and `guangdong-sso-auth`. Lease
IDs may contain letters, numbers, dots, underscores, and hyphens. Each lease is
stored independently in a strongly consistent Durable Object, so activation is
visible before the acquire request returns and one workflow cannot release
another workflow's lease. TTL is clamped to two hours and protects against
cancelled workflows whose cleanup does not run. A preset remains active while
any of its leases exists.

Lease writes accept only a bearer token; query-string authentication is not
accepted. Reading `/messages` keeps its existing authentication behavior.

## Protected inbox

Stored entries live in the `FORWARDED_KV` namespace for six hours. Requests must
use the configured bearer token:

```bash
curl -H "Authorization: Bearer $INBOX_TOKEN" \
  'https://your-worker.example.com/messages?since=0&sender=10001'
```

The equivalent `/pushplus/messages` path is also accepted. Do not place the
token in query strings, logs, or repository variables.

## Missed-message recovery

The Worker can poll the PushPlus Open API once a minute for recent messages.
It queries each candidate's final PushPlus delivery status and recovers only
messages whose realtime webhook is explicitly marked failed. Recovered messages
use the normal filters, intercept rules, Telegram delivery, and KV
deduplication path.

Recovery is off by default and fails closed without an activation timestamp:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUSHPLUS_RECOVERY_ENABLED` | `false` | Enable the minute-level recovery job |
| `PUSHPLUS_RECOVERY_NOT_BEFORE` | required when enabled | ISO-8601 timestamp; never consider an older record |
| `PUSHPLUS_RECOVERY_LOOKBACK_HOURS` | `48` | Maximum age of records considered; maximum 720 hours |
| `PUSHPLUS_RECOVERY_MIN_AGE_MINUTES` | `0` | Minimum message age before checking final delivery status |
| `PUSHPLUS_RECOVERY_PAGE_SIZE` | `50` | Records read per page; maximum 50 |
| `PUSHPLUS_RECOVERY_MAX_PAGES` | `2` | Maximum pages scanned per run; maximum 20 |
| `PUSHPLUS_RECOVERY_MAX_MESSAGES` | `20` | Maximum candidates processed per run; maximum 50 |
| `PUSHPLUS_RECOVERY_TITLE_KEYWORD` | message title filter | Limit recovery to matching titles |
| `PUSHPLUS_RECOVERY_ALERT_ENABLED` | `true` | Send a summary only when recovery forwards a message |

Set `PUSHPLUS_TOKEN`, `PUSHPLUS_SECRET_KEY`, `STATE_SECRET`, and the Telegram
delivery secrets before enabling recovery. Use a current timestamp with an
explicit timezone for `PUSHPLUS_RECOVERY_NOT_BEFORE`; this prevents the first
run from replaying older account history.

The default trigger runs once a minute. Status `0`/`1` messages remain pending,
status `2` messages are left to the realtime path, and only status `3` messages
are recovered. The Worker rechecks KV immediately before processing each failed
candidate. Access keys are cached in memory until shortly before expiry and are
refreshed once when an Open API call fails, keeping the polling loop bounded.

With alerts enabled, only a run that actually forwards at least one message
sends a Telegram summary. Set `PUSHPLUS_RECOVERY_ALERT_ENABLED=false` to keep
all recovery reporting in Worker logs. Filtered, intercepted, duplicate, empty,
and failed outcomes never produce a summary alert.

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
