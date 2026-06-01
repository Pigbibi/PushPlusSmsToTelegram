# PushPlusSmsToTelegram

[English](README.en.md) | 简体中文

把 PushPlus 收到的短信**主动**转发到 Telegram Bot。适合“短信转发器只能推到 PushPlus，但你希望在 Telegram 里实时接收短信内容/验证码”的场景。

当前推荐链路：

```text
短信转发器 -> PushPlus -> Cloudflare Pages Relay -> Cloudflare Worker -> Telegram
```

这个方案是事件触发：**只有 PushPlus 收到新消息时才会调用 Cloudflare**，没有 Cloudflare Cron，也没有 GitHub Actions 定时轮询。

## 功能

- 主动 webhook 转发，无固定轮询延迟；
- Telegram 消息只展示发件人、发件时间和短信内容；
- 支持正文/标题关键字过滤；
- KV 去重，避免同一条 PushPlus 消息重复转发；
- 保留 GitHub Actions 手动补发脚本，默认不定时运行；
- 提供 GitHub Actions 手动部署 workflow。

## 为什么需要 Pages Relay？

实测 PushPlus 服务器可能无法访问 `workers.dev` 域名，但可以访问 `pages.dev`。因此默认架构使用一个很薄的 Pages Relay：

```text
PushPlus -> pages.dev Relay -> workers.dev Worker -> Telegram
```

Relay 只做两件事：

1. 校验 URL 里的 `RELAY_TOKEN`；
2. 把原始请求转发给 Worker。

Relay 不保存短信内容，也不需要 Telegram token。

如果你使用自己的 Worker 自定义域名，并且 PushPlus 可以访问它，可以跳过 Relay，直接把 PushPlus webhook 指向 Worker 的 `/pushplus/webhook/<CALLBACK_TOKEN>`。

## Telegram 消息内容

转发到 Telegram 的消息包含：

- 发件人，例如 `10001`；
- 短信发送时间；
- 短信内容，不脱敏。

PushPlus 标题、短链接、`#SMS`、本机号码、开机时长、运营商、信号等设备元数据会被自动隐藏。

## Cloudflare Worker 部署

```bash
cp wrangler.example.toml wrangler.toml
npx wrangler kv namespace create FORWARDED_KV
# 把输出的 id 填入 wrangler.toml

npx wrangler secret put CALLBACK_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put STATE_SECRET

npx wrangler deploy
```

`CALLBACK_TOKEN` 和 `STATE_SECRET` 建议使用随机长字符串：

```bash
openssl rand -hex 32
```

健康检查：

```text
https://你的-worker.workers.dev/health
```

## Cloudflare Pages Relay 部署

```bash
cd pages-relay
npx wrangler pages project create pushplus-sms-to-telegram --production-branch main --compatibility-date 2026-05-31
npx wrangler pages secret put RELAY_TOKEN --project-name pushplus-sms-to-telegram
npx wrangler pages deploy dist --project-name pushplus-sms-to-telegram --branch main
```

`RELAY_TOKEN` 建议和 `CALLBACK_TOKEN` 使用同一个值。部署后 webhook 地址类似：

```text
https://pushplus-sms-to-telegram.pages.dev/pushplus/webhook/你的RELAY_TOKEN
```

Relay 健康检查：

```text
https://pushplus-sms-to-telegram.pages.dev/health
```

## 配置 PushPlus 主动 webhook

PushPlus 自定义 webhook 使用纯文本 body，避免短信里出现换行或引号时破坏 JSON：

```text
标题：{title}
链接：{url}

{content}
```

可以用脚本自动创建/更新 PushPlus 自定义 webhook，并把用户 token 默认通道切到该 webhook：

```bash
PUSHPLUS_TOKEN=... \
PUSHPLUS_SECRET_KEY=... \
PUSHPLUS_WEBHOOK_URL=https://pushplus-sms-to-telegram.pages.dev/pushplus/webhook/你的RELAY_TOKEN \
npm run configure:pushplus
```

脚本只输出已脱敏的 webhook 地址，不会输出 token。

## GitHub Secrets

如果使用 `.github/workflows/deploy.yml` 手动部署，需要配置这些仓库 Secrets：

| Secret | 说明 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token，需要 Workers、KV、Pages 编辑权限。 |
| `CALLBACK_TOKEN` | Worker webhook/callback 鉴权 token。 |
| `RELAY_TOKEN` | Pages Relay 鉴权 token，通常与 `CALLBACK_TOKEN` 相同。 |
| `PUSHPLUS_TOKEN` | PushPlus 用户 token。 |
| `PUSHPLUS_SECRET_KEY` | PushPlus Open API secretKey。 |

Worker 自身还需要这些 Cloudflare Secrets：

| Secret | 说明 |
| --- | --- |
| `CALLBACK_TOKEN` | Worker 入口鉴权。 |
| `TELEGRAM_BOT_TOKEN` | Telegram BotFather 创建的 bot token。 |
| `TELEGRAM_CHAT_ID` | 接收消息的 chat id。 |
| `STATE_SECRET` | 用于生成 KV 去重 key 的随机字符串。 |

## Worker Variables

| Variable | 默认值 | 说明 |
| --- | --- | --- |
| `MESSAGE_BODY_KEYWORD` | 空 | 正文过滤。只转发短信时可填 `#SMS`。 |
| `MESSAGE_TITLE_KEYWORD` | 空 | 标题过滤。硬件标题固定为“短信转发”时可填 `短信转发`。 |

## GitHub Actions

### Deploy active PushPlus relay

`.github/workflows/deploy.yml` 是手动部署 workflow，会依次执行：

1. 测试和 lint；
2. 部署 Worker；
3. 部署 Pages Relay；
4. 配置 PushPlus webhook。

它不会定时运行。

### Forward PushPlus SMS to Telegram

`.github/workflows/forward.yml` 是手动备用补发 workflow。它会通过 PushPlus Open API 拉取最近消息并转发，主要用于排障或补发历史消息。默认没有 schedule，不会自动轮询。

## 本地手动补发

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

确认日志后，把 `DRY_RUN=false` 再执行即可真实转发。

## 兼容：PushPlus 消息完成回调

Worker 仍兼容 PushPlus 官方“消息完成回调”：

```text
https://你的-worker.workers.dev/pushplus/callback/你的CALLBACK_TOKEN
```

该回调只带 `shortCode` 和发送状态，不直接带完整正文；Worker 收到后会访问 `/shortMessage/{shortCode}` 获取内容。生产环境优先使用自定义 webhook，因为它能直接把 `{content}` 推给 Worker。

## 安全说明

- 不要把 token、secretKey、Telegram bot token、chat id 写进仓库文件；
- 公开仓库的 `state` 分支只保存 HMAC 后的去重 ID，不保存短信正文和 PushPlus `shortCode`；
- Telegram 会收到短信内容，包括验证码，请确认 bot 和 chat 的访问范围可信；
- 如果凭证曾在聊天、日志或截图中暴露，建议重新生成并更新对应平台配置。
