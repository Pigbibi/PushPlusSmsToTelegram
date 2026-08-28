# Deployment and operations

## Manual deployment

Install dependencies and validate the checkout:

```bash
npm ci
npm test
npm run lint
```

Create a KV namespace, copy `wrangler.example.toml` to the ignored
`wrangler.toml`, insert the namespace ID, set Worker secrets, and deploy:

```bash
npx wrangler deploy
```

Verify `/health` before configuring PushPlus. Then send a test message that does
not contain a real one-time code.

## GitHub Actions deployment

`.github/workflows/deploy.yml` is manual-only. It runs tests and lint, deploys
the Worker and Pages relay, and runs the PushPlus webhook helper. Its Pages
project name and webhook URL target the maintainer deployment. A fork must
replace those values with its own Cloudflare Pages project and endpoint before
running the workflow.

Required repository secrets depend on enabled features:

- `CLOUDFLARE_API_TOKEN`
- `FORWARDED_KV_NAMESPACE_ID`
- `CALLBACK_TOKEN`
- `RELAY_TOKEN`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `STATE_SECRET`
- `PUSHPLUS_TOKEN`
- `PUSHPLUS_SECRET_KEY`
- `INBOX_TOKEN` when the protected inbox is used

Use a Cloudflare API token restricted to the required account and Workers,
Pages, and KV resources.

The deployment workflow sets `RELAY_TOKEN` but does not create a fork-specific
`WORKER_ORIGIN`. Before routing traffic through a fork's Pages relay, set
`WORKER_ORIGIN` to that fork's Worker origin in the Cloudflare Pages project.
The value persists across later deployments.

Optional repository variables mirror the intercept, recovery, and cleanup
settings in [Configuration](configuration.md).

Set `PUSHPLUS_WEBHOOK_BASE_URL` to an HTTPS relay base path when PushPlus cannot
reliably reach the generated `pages.dev` endpoint. The deployment appends the
secret `RELAY_TOKEN` at runtime, so the repository variable must not contain a
token, query string, or message data. If the variable is unset, deployment
keeps the bundled Pages relay as the default.

The scheduled `delivery-monitor.yml` workflow runs an hourly quiet probe. It
checks the Worker health endpoint, sends a filtered request through the VPS
relay, confirms a default-channel PushPlus message reaches final status 2, and
asks the Worker to call Telegram `getChat` without posting a message. Telegram
credentials remain only in the Worker; the monitor authenticates with the
existing inbox bearer token. The monitor title and body
do not match production SMS filters, so successful runs create no Telegram
notification. A failed run remains visible in GitHub Actions.

## PushPlus webhook helper

`npm run configure:pushplus` creates or updates a PushPlus custom webhook. By
default it also sets that webhook as the user's default channel.

Set:

```bash
PUSHPLUS_SET_USER_DEFAULT=false
```

when senders select a channel explicitly and the user's existing default must
remain unchanged. Review the PushPlus account after running the helper.

## Callback mode

The Worker accepts a PushPlus delivery callback at:

```text
/pushplus/callback/YOUR_CALLBACK_TOKEN
```

A callback contains a short code and delivery status rather than the complete
SMS body. The Worker fetches the corresponding short-message page before
filtering and delivery. Prefer the custom webhook path when the full
`{content}` can be sent directly.

## Direct SmsForwarder fallback architecture

For SmsForwarder 3.2.0 or newer, configure the signed direct Worker webhook as
the first sender and PushPlus as the second sender with "stop after success".
Set three request retries on the phone. This removes PushPlus from the normal
critical path while preserving it as an independently routed fallback through
the VPS. The Worker still applies workflow-scoped intercept leases to both
paths, so unrelated SMS continue to reach Telegram.

## Manual backfill

`.github/workflows/forward.yml` reads recent PushPlus messages and forwards
messages not present in the `state` branch. It runs only through
`workflow_dispatch`.

The workflow's dry-run option does not send Telegram messages, but it still
updates matching-message state. Use it to inspect selection, not to preserve an
untouched backfill queue.

Local backfill:

```bash
PUSHPLUS_TOKEN='replace-me' \
PUSHPLUS_SECRET_KEY='replace-me' \
TELEGRAM_BOT_TOKEN='replace-me' \
TELEGRAM_CHAT_ID='replace-me' \
STATE_SECRET='local-test-secret' \
DRY_RUN=true \
npm run forward
```

Review output before setting `DRY_RUN=false`.

## Best-effort scheduled recovery

Keep realtime webhook delivery as the primary path. Enable recovery only after
the Worker has valid PushPlus, Telegram, state, and KV configuration.

1. Deploy with `PUSHPLUS_RECOVERY_ENABLED=false`.
2. Set `PUSHPLUS_RECOVERY_NOT_BEFORE` to the current ISO-8601 timestamp with a
   timezone.
3. Set a narrow `PUSHPLUS_RECOVERY_TITLE_KEYWORD` when the PushPlus account
   contains unrelated messages.
4. Keep `PUSHPLUS_RECOVERY_MODE=failed-only` for conservative recovery, or set
   it to `unhandled` when local KV state should be authoritative even if
   PushPlus reports delivery success.
5. Set `PUSHPLUS_RECOVERY_ENABLED=true` and deploy again.
6. Check Worker logs for the `pushplus_recovery` event after the next scheduled
   trigger.

The log reports scanned candidates and separate forwarded, intercepted,
filtered, duplicate, empty, upstream-delivered, upstream-pending, and failed
counts. Disable recovery first when investigating unexpected selection or
duplicate delivery; existing realtime webhooks continue to work. Set
`PUSHPLUS_RECOVERY_ALERT_ENABLED=false` when operators prefer log-only recovery
reporting. Do not use this job as the primary delivery path: PushPlus can omit
connection-timeout failures from the Open API message list.

The production diagnostic uses the bearer-protected
`POST /diagnostics/handled` endpoint to verify a specific synthetic message's
KV marker after PushPlus reports a realtime webhook failure. The endpoint
accepts only `{ "sourceId": "..." }`, returns only a boolean handled state,
and never exposes the stored value or message content.

## Health and troubleshooting

Worker and relay health endpoints return a small JSON response:

```text
GET /health
```

When delivery fails, check in this order:

1. the PushPlus webhook URL and response status;
2. relay `WORKER_ORIGIN` and `RELAY_TOKEN`, when a relay is used;
3. Worker `CALLBACK_TOKEN` and KV binding;
4. title/body filters and intercept rules;
5. Telegram bot token, destination chat, and bot membership;
6. Cloudflare Worker logs with SMS content redacted.

A healthy relay only proves the relay process is reachable. It does not verify
the Worker origin, PushPlus credentials, Telegram delivery, or KV access.

Workflow consumers that need to hide OTP notifications temporarily should
acquire an intercept lease immediately before the SMS-producing step and
release it with an `always()` cleanup step. Use a unique lease ID derived from
the workflow run ID and attempt. Do not leave the equivalent preset in
`SMS_INTERCEPT_PRESETS` or `SMS_INTERCEPT_RULES`, because static rules continue
silencing messages after the consumer workflow finishes.

## Data handling

Normal forwarding stores salted deduplication keys rather than SMS bodies.
Rules with storage enabled put selected bodies in KV for six hours. Cloudflare,
PushPlus, Telegram, and GitHub Actions may still process request or log metadata
according to their own services.

Avoid logging request bodies. Rotate every affected credential if a message,
token, chat ID, or real endpoint is exposed publicly.
