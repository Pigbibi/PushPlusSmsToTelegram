# PushPlusSmsToTelegram

把 PushPlus 收到的短信转发到 Telegram Bot。适合“硬件短信转发器只能推 PushPlus，但你还想在 Telegram 里实时查看短信”的场景。

推荐方案是 Cloudflare Worker 主动接收 PushPlus 的消息完成回调，再用回调里的 `shortCode` 拉取消息详情并转发 Telegram。这样不需要 GitHub Actions 定时轮询，平时没有短信就没有 Worker 请求。仓库同时保留 GitHub Actions 轮询方案作为备用。

## 转发内容

Telegram 消息包含：

- PushPlus 标题；
- 发件人，例如 `10001`；
- 短信发送时间；
- 完整短信内容，不脱敏。

## 推荐方案：Cloudflare Worker 主动触发

PushPlus 官方支持消息完成回调：消息真正推送完成后，会把包含 `shortCode` 和 `sendStatus` 的 JSON POST 到你配置的回调地址。这个 Worker 使用 `shortCode` 拉取 PushPlus 消息详情，再转发到 Telegram。

### Cloudflare 免费吗？

这类低频短信转发通常可以放在 Cloudflare Workers 免费计划内。Cloudflare 官方文档写明 Workers Free 有每天 100,000 次请求限制，Workers KV 也包含免费额度。短信回调一天几十次以内远低于这个量。

### 部署步骤

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

`CALLBACK_TOKEN` 用随机长字符串，`STATE_SECRET` 可以这样生成：

```bash
openssl rand -hex 32
```

部署后，把 PushPlus 回调地址设置为：

```text
https://你的-worker.workers.dev/pushplus/callback/你的CALLBACK_TOKEN
```

这个地址支持 PushPlus 保存时的 GET/OPTIONS/空 POST 校验，并按 PushPlus 官方文档返回 `{"code": 200, "msg": "success"}`；真正带 `shortCode` 的消息回调仍会校验路径末尾的 `CALLBACK_TOKEN`。也可以先访问健康检查：

```text
https://你的-worker.workers.dev/health
```

### Worker Secrets

| Secret | 说明 |
| --- | --- |
| `CALLBACK_TOKEN` | 保护回调入口，放在 PushPlus 回调 URL 路径末尾。 |
| `TELEGRAM_BOT_TOKEN` | Telegram BotFather 创建的 bot token。 |
| `TELEGRAM_CHAT_ID` | 接收消息的 chat id。 |
| `STATE_SECRET` | 随机长字符串，用于生成 KV 去重 key。 |

### Worker Variables

| Variable | 默认值 | 说明 |
| --- | --- | --- |
| `MESSAGE_BODY_KEYWORD` | 空 | 正文过滤。只转发短信时可填 `#SMS`；只转发电信可填 `10001`。 |

## 备用方案：GitHub Actions 轮询

如果暂时不部署 Cloudflare Worker，也可以用 GitHub Actions 每 5 分钟轮询 PushPlus。

## GitHub 配置

### Secrets

| Secret | 说明 |
| --- | --- |
| `PUSHPLUS_TOKEN` | PushPlus 用户 token，不能用消息 token。 |
| `PUSHPLUS_SECRET_KEY` | PushPlus 开放接口 secretKey。 |
| `TELEGRAM_BOT_TOKEN` | Telegram BotFather 创建的 bot token。 |
| `TELEGRAM_CHAT_ID` | 接收消息的 chat id。 |
| `STATE_SECRET` | 随机长字符串，用于把 PushPlus `shortCode` HMAC 后再写入公开 state 分支。 |

生成 `STATE_SECRET` 示例：

```bash
openssl rand -hex 32
```

### Variables

| Variable | 默认值 | 说明 |
| --- | --- | --- |
| `PUSHPLUS_PAGE_SIZE` | `20` | 每次读取最近多少条 PushPlus 消息，最大 50。 |
| `MESSAGE_TITLE_KEYWORD` | 空 | 标题过滤。硬件标题固定为“短信转发”时建议填 `短信转发`。 |
| `MESSAGE_BODY_KEYWORD` | 空 | 正文过滤。只转发短信时可填 `#SMS`；只转发电信可填 `10001`。 |
| `POLL_LOOKBACK_MINUTES` | `60` | 只处理最近多少分钟的消息；首次运行时避免转发很久以前的历史消息。 |

## 运行方式

手动测试：

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

GitHub Actions：

1. 配好 Secrets 和 Variables；
2. 手动运行 `Forward PushPlus SMS to Telegram` workflow，先设 `dry_run=true`；
3. 确认日志里只出现标题、发件人、时间和长度等信息；
4. 再手动运行 `dry_run=false`；
5. 确认 Telegram 收到消息后，保留 schedule 自动轮询。

## 自动触发还是轮询？

优先用 Cloudflare Worker 主动回调。PushPlus 的消息回调只带 `shortCode` 和发送状态，不直接带完整正文，所以 Worker 收到回调后还会访问一次 `/shortMessage/{shortCode}` 获取完整内容。

GitHub Actions 轮询只是备用方案。它不需要 Cloudflare，但会定时运行，实时性也差一些。如果已经部署 Worker，可以在 GitHub 仓库的 Actions 页面禁用 `Forward PushPlus SMS to Telegram` workflow，避免备用轮询继续跑。

## 安全说明

- 不要把 token、secretKey、Telegram bot token、chat id 写进仓库文件；
- 公开仓库的 `state` 分支只保存 HMAC 后的去重 ID，不保存短信正文和 PushPlus `shortCode`；
- Telegram 会收到完整短信内容，包括验证码，请确认 bot 和 chat 的访问范围可信；
- 如果 token 已在聊天或日志中暴露，建议重新生成并更新 GitHub Secrets。
