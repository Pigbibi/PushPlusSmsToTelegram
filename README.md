# PushPlusSmsToTelegram

把 PushPlus 收到的短信转发到 Telegram Bot。适合“硬件短信转发器只能推 PushPlus，但你还想在 Telegram 里实时查看短信”的场景。

默认方案是 GitHub Actions 每 5 分钟轮询 PushPlus OpenAPI。公开仓库里不会保存短信正文、验证码、PushPlus `shortCode` 或 Telegram token；去重状态只保存用 `STATE_SECRET` 做 HMAC 后的消息 ID。

## 转发内容

Telegram 消息包含：

- PushPlus 标题；
- 发件人，例如 `10001`；
- 短信发送时间；
- PushPlus 收到时间；
- 完整短信内容，不脱敏。

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

如果硬件短信转发器只能推 PushPlus，那么 PushPlus 不会主动回调这个仓库里的 GitHub Actions，所以这里采用轮询。GitHub Actions 的定时任务设置为每 5 分钟一次，实际触发时间可能有延迟。

如果你需要更接近实时，可以后续改成 Cloudflare Workers Cron Triggers 或 VPS 常驻进程。Cloudflare Workers 免费额度通常足够每分钟轮询一次这类低频短信转发，但需要额外配置 Worker secrets 和 KV / D1 等状态存储。

## 安全说明

- 不要把 token、secretKey、Telegram bot token、chat id 写进仓库文件；
- 公开仓库的 `state` 分支只保存 HMAC 后的去重 ID，不保存短信正文和 PushPlus `shortCode`；
- Telegram 会收到完整短信内容，包括验证码，请确认 bot 和 chat 的访问范围可信；
- 如果 token 已在聊天或日志中暴露，建议重新生成并更新 GitHub Secrets。
