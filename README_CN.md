# PushPlusSmsToTelegram

[English](README.md)

通过 Cloudflare Worker，将 PushPlus 或签名 webhook 收到的短信通知转发到 Telegram。支持过滤、持久化发送协调，以及可选的短期受保护收件箱。

```text
短信来源 → PushPlus 或签名 webhook → Worker → Telegram
```

PushPlus 无法访问 Worker 时，可增加 Pages relay 入口。部署 relay 时必须明确配置自己的 Worker 地址。

## 运行要求

- 本地开发和部署使用 Node.js 20+、Wrangler。
- Cloudflare Workers、KV 和 SQLite Durable Object。
- Telegram bot 和目标聊天；使用 PushPlus 功能时需配置其凭据。

## 快速开始

创建部署配置：

```bash
npm ci
cp wrangler.example.toml wrangler.toml
npx wrangler kv namespace create FORWARDED_KV
```

将 KV namespace ID 写入 `wrangler.toml`。保留示例中的 `INTERCEPT_LEASES` binding 和 `InterceptLeaseCoordinator` migration，转发依赖这两个配置。个人部署配置不要提交到 Git。

通过 Wrangler 交互式输入 secrets：

```bash
npx wrangler secret put CALLBACK_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put STATE_SECRET
```

使用独立随机密钥。签名直连入口还需 `SMSFORWARDER_WEBHOOK_SECRET`；其他可选凭据见[配置说明](docs/configuration.md)。

检查并部署：

```bash
npm test
npm run lint
npx wrangler deploy
```

访问 Worker 的 `/health`，配置所选发送端，再用受控测试消息在 Telegram 中验收。健康端点只能说明入口状态，不能证明短信送达。

## 选择接入方式

| 来源 | Worker 路径 | 配置要点 |
| --- | --- | --- |
| PushPlus 自定义 webhook | `/pushplus/webhook/<CALLBACK_TOKEN>` | 正文带 `{title}`、`{url}`、`{content}` |
| 签名 SmsForwarder | `/smsforwarder/webhook` | HMAC 签名与时间戳 |
| 硬件 SIM 网关 | `/device/webhook/<HARDWARE_WEBHOOK_TOKEN>` | 标准 POST JSON |
| 可选 Pages relay | `/pushplus/webhook/<RELAY_TOKEN>` | 将 `WORKER_ORIGIN` 设置为自己的 Worker |

具体请求格式和认证参数见[配置说明](docs/configuration.md)。不要分享包含 token 的 URL。

## 发送与数据保存

Durable Object 在发送前占用消息，KV 保存去重镜像；不同入口的相同短信通过内容指纹减少重复转发。

超时、响应未知和部分发送会保留禁止重发的状态。恢复前先核对目标聊天，不要通过清空状态或轮换 `STATE_SECRET` 强行重试。系统不承诺端到端恰好发送一次。

只有明确启用存储的拦截规则会将短信正文写入受保护收件箱，六小时后过期；普通转发保存加盐去重键。请按个人数据访问权限保护 bot、密钥和目标聊天。

定时补转发和记录清理需要明确启用，开启前先核对执行上限和生效起点。

## 文档

- [配置与请求格式](docs/configuration.md)
- [部署、relay、补转发与排障](docs/operations.md)

## 支持与贡献

[问题与支持](SUPPORT.md) · [贡献指南](CONTRIBUTING.md) · [安全问题](SECURITY.md) · [行为准则](CODE_OF_CONDUCT.md)

## 许可证

[MIT](LICENSE)。
