# PushPlusSmsToTelegram

[English](README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)](package.json)

通过 Cloudflare Worker 把 PushPlus 收到的短信通知转发到 Telegram。服务支持去重、
内容过滤、可选拦截规则，以及供其他授权自动化读取的短期受保护 inbox。

## 架构

直接部署：

```text
短信转发器 → PushPlus → Cloudflare Worker → Telegram
```

可选 relay：

```text
短信转发器 → PushPlus → Cloudflare Pages relay → Worker → Telegram
```

只有 PushPlus 无法访问 Worker 地址时才需要 relay。relay 校验 token 后转发请求，
不会存储短信正文。

## 主要功能

- 接收 PushPlus custom webhook 和 callback 通知。
- 使用 Cloudflare KV 去重。
- 按标题或正文关键词过滤。
- 从 Telegram 消息中移除可识别的设备状态元数据。
- 在通知前应用自定义拦截规则。
- 把指定消息写入带 token 的 inbox，TTL 为 6 小时。
- 有界补偿实时链路漏掉的近期消息。
- 通过 Cloudflare Cron 有界删除旧 PushPlus 记录。
- 提供手动部署和补发用的 GitHub Actions workflow。

## 运行要求

- 本地开发使用 Node.js 20 或更高版本
- 支持 Workers 和 KV 的 Cloudflare 账号
- 能配置 custom webhook 的 PushPlus 账号
- Telegram bot 和目标聊天
- 手动部署需要 Wrangler

## 快速开始

### 1. 创建 KV

```bash
npm ci
cp wrangler.example.toml wrangler.toml
npx wrangler kv namespace create FORWARDED_KV
```

把返回的 namespace ID 写入本地 `wrangler.toml`，不要提交真实配置。

### 2. 配置 Worker secrets

```bash
npx wrangler secret put CALLBACK_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put STATE_SECRET
```

生成随机 token：

```bash
openssl rand -hex 32
```

受保护 inbox、漏发补偿和定时清理需要额外 secrets：

```bash
npx wrangler secret put INBOX_TOKEN
npx wrangler secret put PUSHPLUS_TOKEN
npx wrangler secret put PUSHPLUS_SECRET_KEY
```

### 3. 部署 Worker

```bash
npm test
npm run lint
npx wrangler deploy
```

健康检查：

```text
https://your-worker.example.com/health
```

直接 webhook：

```text
https://your-worker.example.com/pushplus/webhook/YOUR_CALLBACK_TOKEN
```

如果 PushPlus 无法访问 `workers.dev`，优先为 Worker 配置 Cloudflare custom domain。

### 4. 可选：部署 Pages relay

```bash
cd pages-relay
npx wrangler pages project create your-pages-project \
  --production-branch main
npx wrangler pages secret put RELAY_TOKEN \
  --project-name your-pages-project
npx wrangler pages secret put WORKER_ORIGIN \
  --project-name your-pages-project
npx wrangler pages deploy dist \
  --project-name your-pages-project --branch main
```

`WORKER_ORIGIN` 必须填写你自己的 Worker origin。Fork 用户必须覆盖它：仓库内 relay
带有维护者部署地址作为 fallback，不能原样用于其他部署。

relay webhook：

```text
https://your-pages-project.pages.dev/pushplus/webhook/YOUR_RELAY_TOKEN
```

### 5. 配置 PushPlus

推荐使用纯文本 custom webhook 模板：

```text
标题：{title}
链接：{url}

{content}
```

启用旧记录清理时保留 `{url}`，Worker 会使用其中的 short code 关联已处理记录。

可以使用仓库脚本配置 webhook：

```bash
PUSHPLUS_TOKEN='replace-me' \
PUSHPLUS_SECRET_KEY='replace-me' \
PUSHPLUS_WEBHOOK_URL='https://your-endpoint/pushplus/webhook/YOUR_TOKEN' \
npm run configure:pushplus
```

脚本可能修改 PushPlus 用户的默认发送渠道。如果发送端会显式选择渠道，并且需要保留
现有默认渠道，请设置 `PUSHPLUS_SET_USER_DEFAULT=false`。

## 消息处理顺序

1. 校验 webhook 或 callback token；
2. callback 只有 short code 时，从 PushPlus 获取正文；
3. 通过 KV 跳过已经处理的消息；
4. 应用拦截规则；
5. 应用标题和正文过滤；
6. 整理短信元数据并发送到 Telegram；
7. 写入带 TTL 的去重标记。

可选的分钟级补偿会复用相同的过滤、拦截和 KV 状态。它会检查 PushPlus 的最终投递
状态，只补偿实时 webhook 明确失败的消息，并且只扫描有界的近期窗口。只有操作员设置
启用时间并明确开启后，该功能才会运行。详细配置见
[配置说明](docs/configuration.md#missed-message-recovery)。

配置 `INBOX_TOKEN` 后才能访问受保护 inbox：

```http
GET /messages?since=...&sender=10001
Authorization: Bearer <INBOX_TOKEN>
```

只有明确配置为 store 的规则会把短信正文写入 inbox，记录会在 6 小时后自动过期。

## 文档

- [配置说明](docs/configuration.md)
- [部署与运维](docs/operations.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [支持说明](SUPPORT.md)

## 安全

该服务处理个人短信，并可能转发验证码。应使用私有 Telegram 聊天、相互独立的随机
token 和专属 Cloudflare 部署。不要提交 Worker secret、PushPlus 凭据、Telegram
凭据、chat ID、短信正文或真实 `wrangler.toml`。

安全问题请按 [SECURITY.md](SECURITY.md) 报告。

## 许可证

本项目使用 [MIT License](LICENSE)。
