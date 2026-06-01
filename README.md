# PushPlusSmsToTelegram

把 PushPlus 收到的短信主动转发到 Telegram Bot。适合“硬件短信转发器只能推 PushPlus，但你还想在 Telegram 里实时查看短信”的场景。

推荐方案是 **PushPlus 自定义 webhook 渠道 + Cloudflare Pages Relay + Cloudflare Worker**：短信转发器仍然把短信发到 PushPlus，PushPlus 按默认渠道把消息内容主动 POST 到 Pages Relay，Relay 再转发到 Worker，Worker 最后转发到 Telegram。这个模式不需要定时轮询，只有新短信进来才会触发。

仓库仍保留 GitHub Actions 手动轮询脚本，作为排障或临时补发工具；默认不启用定时轮询。

## 转发内容

Telegram 消息包含：

- PushPlus 标题；
- 发件人，例如 `10001`；
- 短信发送时间；
- 完整短信内容，不脱敏。

## 推荐方案：主动 webhook 转发

### 原理

PushPlus 自定义 webhook 支持把消息里的动态参数发到指定 HTTP 地址。实测 PushPlus 服务器可能无法访问 `workers.dev` 域名，所以这里推荐先部署一个 `pages.dev` Relay：

```text
PushPlus -> pages.dev Relay -> workers.dev Worker -> Telegram
```

这里配置一个自定义 webhook：

- 请求地址：`https://你的-pages-project.pages.dev/pushplus/webhook/你的CALLBACK_TOKEN`
- 请求方式：`POST`
- Body 内容：

```text
标题：{title}
链接：{url}

{content}
```

用纯文本 body 可以避免短信正文里出现换行、引号时破坏 JSON 结构。Worker 会从 body 中提取标题和链接，并把完整内容转发到 Telegram。

然后把 PushPlus 用户 token 的默认发送渠道改成这个 webhook。之后短信转发器只要继续使用这个 token 发送，PushPlus 就会主动调用 Worker，不需要 Cloudflare Cron 或 GitHub Actions 轮询。

也可以用脚本自动创建/更新 PushPlus 自定义 webhook，并把用户 token 默认渠道切到该 webhook：

```bash
PUSHPLUS_TOKEN=... \
PUSHPLUS_SECRET_KEY=... \
PUSHPLUS_WEBHOOK_URL=https://pushplus-sms-to-telegram.pages.dev/pushplus/webhook/你的CALLBACK_TOKEN \
npm run configure:pushplus
```

脚本不会输出 token，只会输出已脱敏的 webhook 地址和配置结果。

> 说明：如果你不想改变用户 token 的默认渠道，也可以创建专用消息 token，再把这个消息 token 的默认渠道设置为 webhook，最后把短信转发器里的 token 换成这个消息 token。

### Cloudflare 免费吗？

这类低频短信转发通常可以放在 Cloudflare Workers 免费计划内。主动 webhook 模式只有短信到达时才触发 Worker，没有固定轮询请求。

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

部署后可先访问健康检查：

```text
https://你的-worker.workers.dev/health
```


### Pages Relay 部署步骤

如果 PushPlus 能直接访问你的 Worker 自定义域名，可以跳过 Relay。若使用默认 `workers.dev` 域名，建议部署 Relay：

```bash
cd pages-relay
npx wrangler pages project create pushplus-sms-to-telegram --production-branch main --compatibility-date 2026-05-31
npx wrangler pages secret put RELAY_TOKEN --project-name pushplus-sms-to-telegram
npx wrangler pages deploy dist --project-name pushplus-sms-to-telegram --branch main
```

`RELAY_TOKEN` 填同一个 `CALLBACK_TOKEN`。部署后，PushPlus 自定义 webhook 地址使用：

```text
https://pushplus-sms-to-telegram.pages.dev/pushplus/webhook/你的CALLBACK_TOKEN
```

Relay 只做鉴权和转发，不保存短信内容，也不需要 Telegram token。Telegram token 仍只配置在 Worker secret 中。

### Worker Secrets

| Secret | 说明 |
| --- | --- |
| `CALLBACK_TOKEN` | 保护 PushPlus webhook/callback 入口，建议放在 URL 路径末尾。 |
| `TELEGRAM_BOT_TOKEN` | Telegram BotFather 创建的 bot token。 |
| `TELEGRAM_CHAT_ID` | 接收消息的 chat id。 |
| `STATE_SECRET` | 随机长字符串，用于生成 KV 去重 key。 |

### Worker Variables

| Variable | 默认值 | 说明 |
| --- | --- | --- |
| `MESSAGE_BODY_KEYWORD` | 空 | 正文过滤。只转发短信时可填 `#SMS`；只转发电信可填 `10001`。 |
| `MESSAGE_TITLE_KEYWORD` | 空 | 标题过滤。硬件标题固定为“短信转发”时建议填 `短信转发`。 |

## 兼容：PushPlus 消息完成回调

Worker 仍支持 PushPlus 官方“消息完成回调”：

```text
https://你的-worker.workers.dev/pushplus/callback/你的CALLBACK_TOKEN
```

这个回调只带 `shortCode` 和发送状态，不直接带完整正文，所以 Worker 收到后会再访问一次 `/shortMessage/{shortCode}` 获取完整内容。实际生产建议优先用上面的自定义 webhook 渠道，因为它会直接把 `{content}` 推给 Worker。

## 手动备用：GitHub Actions 轮询

仓库保留 `npm run forward` 和 `Forward PushPlus SMS to Telegram` workflow，方便手动补发或排障。默认 workflow 只支持 `workflow_dispatch` 手动触发，不再配置 schedule。

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

## 安全说明

- 不要把 token、secretKey、Telegram bot token、chat id 写进仓库文件；
- 公开仓库的 `state` 分支只保存 HMAC 后的去重 ID，不保存短信正文和 PushPlus `shortCode`；
- Telegram 会收到完整短信内容，包括验证码，请确认 bot 和 chat 的访问范围可信；
- 如果 token 已在聊天或日志中暴露，建议重新生成并更新对应平台配置。
