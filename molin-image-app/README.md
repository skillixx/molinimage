# 墨灵 AI 图片创作应用

这是墨灵 AI 图片创作应用的 Node.js + TypeScript 工程骨架。

## 本地命令

```bash
copy .env.example .env
npm install
npm run dev
npm run dev:worker
npm run db:migrate
npm run db:rollback
npm run build
npm run lint
npm run format:check
npm test
```

## 目录边界

- `src/app`：API 服务入口和 HTTP 边界。
- `src/modules`：业务模块，后续放任务、文件、计费、鉴权等领域逻辑。
- `src/infrastructure`：外部系统适配层，后续放 MySQL、MinIO、Redis、AI 网关等实现。
- `src/workers`：异步任务 worker 入口。
- `test`：自动化测试。
- `migrations`：数据库变更脚本。

## 环境变量

应用启动前会校验 `.env.example` 中列出的关键配置。真实环境变量值必须由本地 `.env`、部署平台或密钥管理系统提供，不能提交到仓库。

## 数据库迁移

- `npm run db:migrate`：执行尚未应用的 `migrations/*.up.sql`。
- `npm run db:rollback`：回滚最近一次已应用的 migration。
- 迁移脚本会维护 `schema_migrations` 版本表，重复执行不会重复应用同一版本。
- 控制台只输出迁移方向和版本号，不输出 `DATABASE_URL`，避免数据库账号密码进入日志。

## 文件存储

- `POST /api/files`：基于当前应用 session 上传图片文件，文件内容写入 MinIO，元数据写入 MySQL `files` 表。
- `GET /api/files/{file_id}/download-url`：校验 `owner_user_id` 后生成短期预签名 URL。
- `files` 表只保存 `storage_provider`、`storage_bucket`、`storage_key` 等元数据，不保存二进制文件内容或永久公开 URL。

## 计费预估与预占

- `POST /api/billing/estimate`：按 `BILLING_RULES_JSON` 读取任务计费规则，返回预计积分、余额和余额是否充足。
- `POST /api/image/tasks`：创建任务前先预占积分，预占成功后任务进入 `billing_reserved`，并写入 `billing_events`。
- `billing_events.idempotency_key` 使用 `{task_id}:{task_type}:reserve` 格式，接口重试时不会重复写入预占事件。
- `BILLING_MOCK_BALANCE_POINTS` 仅用于本地开发和测试；生产预占走墨灵 `/api/internal/entitlement-reserve`。

## 文生图能力

- `POST /api/image/tasks` 传入 `task_type=text_to_image`、`prompt`、`gateway_model_code`、`image_size`、`image_count` 后，会触发文生图 worker。
- Worker 按 `billing_reserved -> queued -> running -> succeeded` 推进任务状态。
- Worker 调用 AI 网关 `image_generation` 能力，结果图片写入对象存储，文件元数据写入 `files` 表。
- `GET /api/image/tasks/{task_id}` 会返回 `result_files`，其中包含短期 `preview_url` 和 `download_url`。
- AI 网关调用结果写入 `ai_gateway_call_logs`，只保存摘要、模型、能力、耗时和成功/失败状态。

## 前端工作台

- `/`：AI 图片创作工作台首屏。
- `/assets/workbench.js`：工作台交互逻辑。
- `/assets/api-client.js`：统一 API 请求封装，只调用应用后端接口。
- `/assets/styles.css`：工作台样式。
- 模型列表来自 `GET /api/image/models`，预计积分来自 `POST /api/billing/estimate`，文生图提交到 `POST /api/image/tasks`，前端不直接调用 AI 网关、对象存储或墨灵内部接口。

## 代码规范

项目使用 TypeScript strict mode、ESLint 和 Prettier。新增代码需要遵守 [开发规范](docs/development-standards.md)，关键业务逻辑必须同步写中文注释。
