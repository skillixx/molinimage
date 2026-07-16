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
npm run test:integration
npm run acceptance
```

G09 商业化验收会串行执行真实 Redis Session、两个独立 API 进程、MySQL Outbox、BullMQ 多 Worker 和健康探针测试。部署完成后设置 `DEPLOYMENT_API_BASE_URL`，再执行 `npm run validate:deployment`，确认远端运行模式、API、MySQL、Redis、MinIO、队列、Worker 和计费对账门禁全部就绪。failed Job 与孤立预占由目标 API 的令牌保护内部门禁检查，failed Job 非零时需按 [G09 部署验收](docs/g09-deployment-acceptance.md) 审核并填写其 ID 集合摘要。

## 目录边界

- `src/app`：API 服务入口和 HTTP 边界。
- `src/modules`：业务模块，后续放任务、文件、计费、鉴权等领域逻辑。
- `src/infrastructure`：外部系统适配层，后续放 MySQL、MinIO、Redis、AI 网关等实现。
- `src/workers`：异步任务 worker 入口。
- `test`：自动化测试。
- `migrations`：数据库变更脚本。

## 环境变量

应用启动前会校验 `.env.example` 中列出的关键配置。真实环境变量值必须由本地 `.env`、部署平台或密钥管理系统提供，不能提交到仓库。

队列恢复相关配置：

- `IMAGE_TASK_JOB_ATTEMPTS`：单个任务最大执行次数。
- `IMAGE_TASK_RECOVERY_SCAN_INTERVAL_MS`：Worker 扫描卡住任务的间隔。
- `IMAGE_TASK_STUCK_AFTER_MS`：`billing_reserved`、`queued` 任务被判定为卡住的时长。
- `IMAGE_TASK_RECOVERY_BATCH_SIZE`：每轮恢复扫描的最大任务数。

监控相关配置：

- `WORKER_HEARTBEAT_INTERVAL_MS`：Worker 刷新在线心跳的间隔。
- `WORKER_HEARTBEAT_TTL_SECONDS`：Worker 心跳 TTL，必须大于刷新间隔。
- `QUEUE_BACKLOG_ALERT_THRESHOLD`：队列等待任务数量告警阈值。
- `QUEUE_OLDEST_WAIT_ALERT_MS`：最老等待任务持续时长告警阈值。
- `OUTBOX_BACKLOG_ALERT_THRESHOLD`：Outbox 未完成记录数量告警阈值。
- `HEALTH_PROBE_TIMEOUT_MS`：单个依赖探针最大执行时间。
- `HEALTH_READINESS_CACHE_TTL_MS`：readiness 短时缓存时间，并用于合并并发探测请求。

管理员可通过 `/admin/task-recovery` 查看最终失败原因、尝试次数和计费状态，并创建幂等的 retry task 重新投递。中间队列重试不会提前释放预占积分。

## 健康检查与监控

- `GET /api/health/live`：存活检查，只验证 API 进程能够响应，不访问外部依赖。
- `GET /api/health/ready`：就绪检查，验证 MySQL、Redis、MinIO、隔离 BullMQ 探针队列的真实写入能力和 Worker 心跳；依赖或 Worker 不可用时返回 HTTP `503`。
- `GET /api/health`：兼容入口，与 readiness 返回相同结果。
- readiness 返回队列 `waiting`、`active`、`delayed`、`failed`、`oldest_wait_ms`，以及 Outbox `backlog`、`dead_letter`、`oldest_wait_ms`。
- 队列持续积压、Outbox 积压/死信会进入 `alerts`；只有告警但依赖可用时状态为 `degraded`，关键依赖或 Worker 离线时状态为 `error`。
- Worker 执行日志只记录 `request_id`、`task_id`、`job_id`、尝试次数和三类耗时，不记录提示词、Token、图片内容、连接串或内部错误堆栈。

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
