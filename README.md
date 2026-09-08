# PushPlusSmsToTelegram

[简体中文](README_CN.md)

Forward SMS notifications from PushPlus or a signed direct webhook to a Telegram chat through a Cloudflare Worker. Includes message filtering, durable delivery coordination and an optional short-lived protected inbox.

```text
SMS source → PushPlus or signed webhook → Worker → Telegram
```

An optional Pages relay provides another ingress when PushPlus cannot reach the Worker. Configure its upstream explicitly for your deployment.

## Requirements

- Node.js 20+ and Wrangler for local development and deployment.
- Cloudflare Workers, KV and a SQLite-backed Durable Object.
- A Telegram bot and destination chat; PushPlus credentials for PushPlus features.

## Quick start

Create a deployment configuration:

```bash
npm ci
cp wrangler.example.toml wrangler.toml
npx wrangler kv namespace create FORWARDED_KV
```

Set your KV namespace ID in `wrangler.toml`. Preserve the `INTERCEPT_LEASES` binding and the `InterceptLeaseCoordinator` migration from the example: forwarding requires them. Keep deployment-specific configuration out of Git.

Add secrets through Wrangler's interactive prompts:

```bash
npx wrangler secret put CALLBACK_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put STATE_SECRET
```

Use independent random secrets. Add `SMSFORWARDER_WEBHOOK_SECRET` for signed direct ingress; other optional secrets are listed in [Configuration](docs/configuration.md).

Validate and deploy:

```bash
npm test
npm run lint
npx wrangler deploy
```

Open `/health` on your Worker, configure the chosen sender, and verify a controlled test message in Telegram. Health only checks the endpoint; it is not proof of message delivery.

## Choose an ingress

| Source | Worker path | Setup |
| --- | --- | --- |
| PushPlus custom webhook | `/pushplus/webhook/<CALLBACK_TOKEN>` | Body includes `{title}`, `{url}` and `{content}` |
| Signed SmsForwarder | `/smsforwarder/webhook` | HMAC signature and timestamp |
| Hardware SIM gateway | `/device/webhook/<HARDWARE_WEBHOOK_TOKEN>` | Standard POST JSON |
| Optional Pages relay | `/pushplus/webhook/<RELAY_TOKEN>` | Set `WORKER_ORIGIN` to your own Worker |

For exact payloads and authentication settings, see [Configuration](docs/configuration.md). Never share token-bearing URLs.

## Delivery and stored data

The Durable Object claims a message before sending; KV stores the deduplication mirror. Equivalent ingress copies use content fingerprints to reduce duplicate delivery.

Timeouts, uncertain responses and partial sends retain a no-resend reservation. Verify the destination before any recovery. Do not clear state or rotate `STATE_SECRET` to force a retry; the system does not promise end-to-end exactly-once delivery.

Only intercept rules with storage enabled put SMS bodies in the protected inbox, where they expire after six hours. Normal forwarding stores salted deduplication keys. Protect the bot, tokens and Telegram chat as personal-data access.

Scheduled backfill and record cleanup require explicit feature configuration. Review their limits and activation baseline before enabling them.

## Documentation

- [Configuration and payloads](docs/configuration.md)
- [Deployment, relay, backfill and troubleshooting](docs/operations.md)

## Support and contributing

[Support](SUPPORT.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md)

## License

[MIT](LICENSE).
