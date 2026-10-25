# AGENTS.md

## 项目是什么

把 PushPlus 或签名直连 webhook 的短信通知转发到 Telegram 聊天，跑在 Cloudflare Worker 上。带消息过滤、投递协调和可选的短期状态。

## 技术栈

Node.js（`package.json`），Cloudflare Worker。`npm test` + `npm run lint`。

## 目录

- `src/` — Worker 实现。
- `pages-relay/` — 网页中转。
- `scripts/` — 配置与运维脚本。
- `tests/` — 测试。
- `test-support/` — 测试辅助。
- `docs/` — `configuration.md` 配置说明，`operations.md` 运维。

## 本地验证

按改动选择相关离线检查，命令以仓库当前 CI 为准。先区分代码问题与环境条件，不为通过检查降低保护。

**依赖**

```bash
npm ci
```

**Lint**

```bash
npm run lint
```

**测试**

```bash
npm test
```

## 命名与文档

- 新增文档文件名小写、`-` 连接，中文版后缀 `.zh-CN.md`；`README.md`、`AGENTS.md` 等工具约定文件保留固定名称。源码沿用现有语言命名。
- 不提交审计报告、复盘、交接单、进度快照、升级计划。要追溯看 commit 历史。
- 改文件名时同一次提交改完所有引用。
- 提交前跑 `python scripts/check_hygiene.py`。

## 不要做

- 不要在代码里写死 Bot token、chat id 或 webhook 签名密钥。全部走 Worker secrets。
- 不要放宽 webhook 签名校验。那是这个服务唯一的入口防护。
- 不要在日志里打印短信正文。

## 提交与 PR

Conventional Commits，标题中文，不超过 50 字。类型只用 `feat` `fix` `docs` `refactor` `test` `chore` `perf` `ci`。

分支名 `<type>/<主题>`，例如 `docs/normalize-filenames`。不直接推默认分支，不 force push 已 review 的分支。

提交、推送、合并及生产动作按用户已明确授权的范围执行；同范围已有授权不重复确认。

PR 描述写改了什么、为什么改、怎么验证。
