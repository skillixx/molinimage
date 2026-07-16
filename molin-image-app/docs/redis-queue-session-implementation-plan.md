# Redis 队列与 Redis 会话实施计划

## 1. 文档目的

本文档用于指导开发 Agent 按顺序完成 molinimage 的 Redis Session、BullMQ 图片任务队列、独立 Worker、任务恢复和生产监控能力。

执行本文档时必须一次只完成一个 Goal。当前 Goal 未通过测试和验收前，不得开始下一个 Goal。

本文档仅是实施计划。创建本文档不代表对应功能已经实现。

## 2. 当前基线

当前项目已经配置 `REDIS_URL`，但 Redis 尚未真正进入运行链路：

- API 默认使用 `InMemorySessionStore` 保存登录会话。
- 图片任务在 HTTP 请求中直接调用 `ImageGenerationWorkerService.processTask()`。
- `src/workers/image-task-worker.ts` 尚未连接 Redis 或消费任务。
- `package.json` 尚未包含 `ioredis`、`bullmq` 等 Redis 队列依赖。
- MySQL 是任务、计费、文件和模型配置的事实来源。
- MinIO 是上传图片和生成结果的对象存储。
- 现有计费流程已经支持预占、结算、释放、幂等和待对账状态。

## 3. 目标架构

```text
墨灵平台
   |
   v
molinimage API
   |-- Redis Session
   |-- MySQL 创建任务和 Outbox 记录
   |-- BullMQ Producer 投递 task_id
   |
   v
Redis / BullMQ
   |
   v
独立 Image Worker
   |-- 从 MySQL 读取完整任务
   |-- 调用 AI 网关
   |-- 结果写入 MinIO
   |-- 更新 MySQL 状态
   `-- 结算或释放墨灵积分
```

架构原则：

1. Redis 只保存 Session、队列、锁和短期运行数据。
2. MySQL 始终是任务和计费状态的事实来源。
3. 队列消息只传 `task_id`，不得传用户身份、积分、提示词、文件地址或密钥。
4. Worker 必须根据 `task_id` 从 MySQL 重新加载任务。
5. 队列采用至少一次投递，业务层必须保证重复消费不会重复调用模型或重复扣费。
6. API 创建任务后快速返回，不等待 AI 模型完成。
7. 生产环境 Redis 不可用时必须显式失败，不得静默回退到内存实现。

## 4. 推荐技术选型

| 类型         | 选型           | 用途                                   |
| ------------ | -------------- | -------------------------------------- |
| Redis 客户端 | `ioredis`      | Session、健康检查和 BullMQ 连接        |
| 任务队列     | `bullmq`       | 图片任务生产、消费、重试和任务状态统计 |
| 事实数据     | MySQL          | 任务、Outbox、计费、文件和审计记录     |
| 对象存储     | MinIO          | 用户上传图片和生成结果                 |
| 测试 Redis   | Docker Redis 7 | 本地和 CI 集成测试                     |

不要同时引入 `redis` 和 `ioredis` 两套客户端，避免连接管理和错误处理不一致。

## 5. Goal 总览

| Goal | 名称                         | 状态   | 前置 Goal |
| ---- | ---------------------------- | ------ | --------- |
| G00  | 基线确认与设计冻结           | 已完成 | 无        |
| G01  | Redis 连接基础设施           | 已完成 | G00       |
| G02  | SessionStore 接口重构        | 已完成 | G01       |
| G03  | Redis Session 实现           | 已完成 | G02       |
| G04  | BullMQ 队列与 Outbox         | 已完成 | G01       |
| G05  | 独立 Worker 消费任务         | 已完成 | G04       |
| G06  | API 和前端异步化             | 已完成 | G05       |
| G07  | 重试、恢复和死信处理         | 已完成 | G06       |
| G08  | 健康检查、监控与管理能力     | 待执行 | G07       |
| G09  | 集成测试、灰度切换和部署验收 | 待执行 | G08       |

状态只能使用：`待执行`、`执行中`、`已完成`、`阻塞`。

## 6. G00 基线确认与设计冻结

### 目标

确认现有会话、任务、计费和 Worker 契约，冻结本次改造边界。

### 任务

- 阅读根目录 `AGENTS.md` 和项目开发规范。
- 确认当前 Git 分支和未提交修改，不覆盖用户已有改动。
- 记录当前 `npm run build`、`npm run lint`、`npm test` 结果。
- 画出当前任务创建、预占、执行、结算和失败释放流程。
- 确认 `image_tasks` 状态机和计费幂等键规则。
- 确认 Redis 连接方式，但不得把密码写入文档或日志。
- 冻结队列消息结构为 `{ task_id: string }`。
- 确定生产灰度开关名称和默认值。

### 建议配置

```env
REDIS_KEY_PREFIX=molinimage
SESSION_STORE=memory
IMAGE_TASK_EXECUTION_MODE=inline
IMAGE_TASK_QUEUE_NAME=molinimage-image-tasks
IMAGE_TASK_WORKER_CONCURRENCY=2
IMAGE_TASK_JOB_ATTEMPTS=3
IMAGE_TASK_JOB_TIMEOUT_MS=120000
```

### 验收标准

- 没有修改业务行为。
- 基线测试结果已经记录。
- 队列载荷、Key 前缀、灰度开关和失败策略已经确认。
- 明确列出本次不修改的墨灵计费公开契约。

## 7. G01 Redis 连接基础设施

### 目标

提供 API、Worker、Session 和队列可以复用的 Redis 连接管理模块。

### 建议文件

```text
src/infrastructure/redis/
  redis-connection.ts
  redis-health-check.ts
  redis-key.ts
```

### 任务

- 安装 `ioredis` 和 `bullmq`。
- 扩展 `AppConfig`，读取 Redis Key 前缀、连接超时和队列配置。
- 建立 API 普通 Redis 连接和 BullMQ 专用连接工厂。
- BullMQ 连接必须设置适合阻塞消费的 `maxRetriesPerRequest`。
- 为 Redis Key 提供统一前缀函数。
- 增加连接、重连、错误和关闭事件处理。
- API 和 Worker 收到 `SIGTERM`、`SIGINT` 时优雅关闭连接。
- 日志只能输出连接状态和脱敏主机信息，不得输出完整 `REDIS_URL`。

### 测试

- 合法 Redis URL 可以创建连接。
- Redis 不可达时返回明确中文错误。
- Redis 密码不会进入日志。
- 重复关闭连接不会抛出异常。
- Key 前缀不会在不同环境之间冲突。

### 验收标准

- API 和 Worker 可以分别连接当前 Redis。
- Redis 断开时进程不会无限快速重连。
- `npm run build`、`npm run lint`、`npm test` 全部通过。

## 8. G02 SessionStore 接口重构

### 目标

让鉴权模块依赖 Session 接口，不直接依赖内存实现。

### 建议接口

```ts
export interface SessionStore {
  createSession(identity: SessionIdentity, ttlSeconds: number): Promise<CreatedSession>;
  getSession(token: string | undefined): Promise<ApplicationSession | undefined>;
  deleteSession(token: string | undefined): Promise<void>;
}
```

### 任务

- 提取 `SessionStore`、`ApplicationSession` 和 `CreatedSession` 类型。
- 将 `InMemorySessionStore` 改为异步接口实现。
- 修改 `createAppRequestHandler()` 和登录、登出、鉴权调用点。
- 测试环境继续允许注入内存实现。
- 不改变 Cookie 名称、Cookie 内容和墨灵 Ticket 校验流程。

### 测试

- 合法 Ticket 创建 Session。
- 无效 Ticket 不创建 Session。
- Session 到期后不可读取。
- 登出后 Session 立即失效。
- API 仍然不能访问其他用户的任务和文件。

### 验收标准

- 业务代码不再声明具体的 `InMemorySessionStore` 类型依赖。
- 现有鉴权测试全部通过。
- 尚未切换 Redis 时功能行为保持不变。

## 9. G03 Redis Session 实现

### 目标

使用 Redis 保存应用 Session，使 API 重启和多实例部署不再导致会话丢失。

### 建议文件

```text
src/modules/auth/
  session-store.ts
  redis-session-store.ts
```

### Redis Key

```text
{prefix}:session:{sha256(session_token)}
```

不要直接把原始 Session Token 作为可读 Redis Key。

### 任务

- 实现 `RedisSessionStore`。
- Session 内容使用 JSON，并验证读取后的字段类型。
- 写入 Session 时使用 Redis TTL。
- 登出时删除 Redis Key。
- 读取过期或格式错误的 Session 时按未登录处理，并记录脱敏告警。
- 增加 `SESSION_STORE=memory|redis` 灰度配置。
- `APP_ENV=production` 时默认或强制使用 Redis Session。
- 生产 Redis 不可用时登录和鉴权失败，不得回退内存 Session。

### 测试

- Session 写入后可以跨 Store 实例读取。
- API 重启后 Session 仍有效。
- 两个 API 实例共享 Session。
- TTL 到期后 Redis 自动删除 Session。
- 登出会立即删除 Session。
- Redis 中不保存墨灵一次性 Ticket。
- Redis 异常不会把连接串或 Session Token写入错误响应。

### 验收标准

- Redis 模式下不再实例化 `InMemorySessionStore`。
- 内存模式只允许测试和本地灰度使用。
- 登录、刷新页面、登出和过期流程通过真实 Redis 集成测试。

## 10. G04 BullMQ 队列与 MySQL Outbox

### 目标

可靠地把已创建图片任务投递到 BullMQ，消除 MySQL 成功但 Redis 投递丢失的窗口。

### 建议文件

```text
src/infrastructure/queue/
  image-task-queue.ts
  bullmq-image-task-queue.ts
  image-task-outbox-dispatcher.ts
src/infrastructure/database/
  image-task-outbox-repository.ts
migrations/
  {next}_create_image_task_outbox.up.sql
  {next}_create_image_task_outbox.down.sql
```

Migration 编号必须使用执行时下一个可用编号，不得覆盖已有 migration。

### Outbox 建议字段

```text
id
task_id
status: pending | dispatching | dispatched | failed | cancelled
attempt_count
next_attempt_at
last_error_code
last_error_message
created_at
updated_at
dispatched_at
```

### 任务

- 定义 `ImageTaskQueue` 接口。
- BullMQ Job 名称固定为 `process-image-task`。
- BullMQ `jobId` 固定为 `task_id`，吸收重复投递。
- Job data 只能包含 `task_id`。
- 在同一个 MySQL 事务中创建 `image_tasks` 和 Outbox 记录。
- Outbox Dispatcher 扫描待投递记录并写入 BullMQ。
- 投递成功后把 Outbox 标记为 `dispatched`。
- Redis 暂时不可用时保留 Outbox，并按退避策略重试。
- 长时间无法投递时进入告警，不得静默丢弃。
- 配置 `IMAGE_TASK_EXECUTION_MODE=inline|queue` 作为灰度开关。

### 计费要求

- 不修改 reserve、settle、release 的公开契约。
- Outbox 暂时失败时任务和预占可以等待恢复。
- 超过最大等待时间后，应取消任务并幂等释放预占积分。
- 重复 Dispatcher 不得重复创建有效 Job。

### 测试

- MySQL 任务和 Outbox 同时创建或同时回滚。
- 相同 `task_id` 重复投递只保留一个有效 Job。
- Redis 断开后 Outbox 保持待投递。
- Redis 恢复后任务自动进入队列。
- 超时未投递任务会释放积分。

### 验收标准

- 队列模式创建任务时 API 不直接调用 `processTask()`。
- 模拟 API 在提交事务后崩溃，任务仍可由 Dispatcher 恢复投递。
- 不发生丢任务或重复预占。

## 11. G05 独立 Worker 消费任务

### 目标

让 `npm run start:worker` 真正消费 BullMQ 图片任务。

### 任务

- 在 `image-task-worker.ts` 中构建与 API 一致的数据库、存储、计费和 AI 网关依赖。
- 创建 BullMQ Worker 并注册 `process-image-task` 处理器。
- 收到 Job 后只读取 `task_id`，再从 MySQL 加载完整任务。
- 使用数据库条件更新抢占任务，确保同一任务只有一个 Worker 获得执行权。
- Worker 并发由 `IMAGE_TASK_WORKER_CONCURRENCY` 控制。
- 增加任务执行超时、停机等待和锁续期。
- Worker 收到停止信号后停止领取新任务，并等待当前任务安全结束。
- 成功任务保存结果后结算积分。
- 永久失败任务释放积分。
- 结算或释放失败继续进入现有待对账状态。

### 幂等要求

- `succeeded`、`failed`、`cancelled` 任务不得再次调用 AI 网关。
- 已被其他 Worker 抢占的任务直接跳过。
- MinIO 结果写入和文件记录需要可判断是否已经完成。
- 计费继续使用现有幂等键和版本栅栏。

### 测试

- Worker 可以消费文生图、图生文、图生图、图片修复和高清放大。
- 两个 Worker 同时收到相同任务时只执行一次。
- Worker 重启后锁过期任务可以恢复。
- Worker 在模型调用前崩溃不会重复扣费。
- Worker 在结果保存后崩溃不会重复生成无法追踪的文件。

### 验收标准

- Worker 进程能够独立部署和扩容。
- 停止 API 不影响已经在队列中的任务继续执行。
- 停止 Worker 不影响 API 登录、历史查询和任务创建。

## 12. G06 API 和前端异步化

### 目标

任务创建接口快速返回，前端通过轮询展示真实异步状态。

### API 行为

队列模式建议返回 `202 Accepted`：

```json
{
  "task": {
    "id": "task_xxx",
    "status": "billing_reserved"
  }
}
```

### 任务

- API 创建任务后不等待 AI 网关。
- 将任务和 Outbox 写入成功后立即返回 `task_id`。
- 前端按现有任务详情接口轮询状态。
- 轮询使用退避间隔，并在页面离开后停止。
- 页面刷新后可以根据任务 ID 恢复进度。
- 进度文案映射已有任务状态，不伪造已完成阶段。
- 失败任务显示公开中文错误并允许重试。
- 重试接口只创建新任务并投递队列，不在 HTTP 请求内执行模型。

### 测试

- 创建任务响应不等待 AI 模型完成。
- API 返回后任务最终可由 Worker 完成。
- 页面刷新后仍可恢复任务状态。
- 多次点击创建按钮只生成一个幂等任务。
- 网络中断恢复后前端继续查询任务。

### 验收标准

- API 请求耗时不再等于模型生成耗时。
- 前端五种图片能力均能正确展示异步状态。
- API 或浏览器刷新不会导致重复创建或重复扣费。

## 13. G07 重试、恢复与死信处理

### 目标

建立可预测的失败分类、自动重试、卡住任务恢复和人工重放机制。

### 错误分类

可重试错误：

- AI 网关超时。
- AI 网关 `429` 或临时 `5xx`。
- MinIO 临时连接失败。
- MySQL 短暂连接失败。

不可重试错误：

- 参数非法。
- 模型能力不匹配。
- 输入文件不存在或不属于当前用户。
- 内容审核拒绝。
- 积分不足。

### 任务

- 建立结构化 Worker 错误类型和 `retryable` 标志。
- 可重试错误使用指数退避和随机抖动。
- 达到最大次数后才把任务标记为最终失败并释放积分。
- BullMQ 自动重试期间不得提前释放积分。
- 增加死信队列或失败 Job 保留策略。
- 增加扫描器处理长时间停留在 `billing_reserved`、`queued`、`running` 的任务。
- 管理端支持查看失败原因和重新投递。
- 人工重新投递仍使用原任务幂等边界或明确创建 retry task。

### 测试

- 可重试错误在恢复后成功完成。
- 不可重试错误不进行无意义重试。
- 达到最大重试次数后只释放一次积分。
- 卡住任务可以被恢复扫描器接管。
- 迟到 Worker 不得覆盖新 Worker 的最终状态。

### 验收标准

- API、Worker 和 Redis 分别重启后不会丢任务。
- 多次投递和多 Worker 不会重复扣费。
- 所有最终失败任务都有明确错误码和计费状态。

### 实施结果（2026-07-16）

- Worker 使用 `ImageTaskProcessingError` 区分可重试与不可重试错误；AI 网关保留 HTTP 状态码，`408`、`429` 和 `5xx` 进入有限重试。
- BullMQ 使用指数退避和 25% 抖动；中间重试仅归还数据库租约，不改变最终任务状态，不释放预占积分。
- 不可重试错误使用 BullMQ `UnrecoverableError` 跳过剩余尝试；失败 Job 保留在 failed 集合，达到最大次数后才由 `ImageTaskService` 进入最终失败并释放积分。
- `ImageTaskRecoveryScanner` 周期扫描长时间停留在 `billing_reserved`、`queued` 和租约过期的 `running` 任务；未耗尽次数的任务原子回收并重新投递，次数耗尽的任务进入最终失败。
- 管理员可访问 `/admin/task-recovery` 查看错误码、公开错误说明、Worker 尝试次数和最新计费状态，并通过显式 retry task 重新投递。
- 已补充结构化错误、重试耗尽、不可重试、恢复扫描、人工重投和管理 API 测试；真实 MySQL 与 Redis 队列集成测试通过。
- 已有 Outbox 新 Dispatcher 接管覆盖 API 重启，数据库过期租约接管覆盖 Worker 重启，Redis 断连后补投覆盖连接恢复；G09 再执行生产进程和 Redis 实例的破坏性重启演练。

## 14. G08 健康检查、监控与管理能力

### 目标

让运维能够判断 Redis、队列和 Worker 是否真实可用。

### 健康接口建议

```json
{
  "status": "ok",
  "dependencies": {
    "mysql": "ok",
    "redis": "ok",
    "minio": "ok"
  },
  "queue": {
    "waiting": 2,
    "active": 1,
    "delayed": 0,
    "failed": 0
  }
}
```

### 任务

- 区分存活检查和就绪检查。
- 就绪检查覆盖 MySQL、Redis、MinIO 和队列写入能力。
- 增加 Worker 心跳 Key，并设置短 TTL。
- 记录等待数、处理中数量、失败数和最老任务等待时间。
- 增加 Outbox 积压和死信数量告警。
- 记录任务排队耗时、执行耗时和端到端耗时。
- 日志包含 `request_id`、`task_id`、`job_id`，但不包含提示词原文、Token 或图片内容。
- 管理端提供失败任务和重投递入口时必须保留管理员鉴权和审计。

### 验收标准

- Redis 断开时 readiness 返回失败。
- Worker 全部离线时能够告警。
- 队列持续积压时能够告警。
- 健康检查不输出连接串和内部错误堆栈。

## 15. G09 集成测试、灰度切换与部署验收

### 目标

通过真实 Redis 和多进程场景验证，并安全切换生产流量。

### 集成测试环境

- MySQL 测试库。
- MinIO 测试 Bucket。
- Redis 7 测试实例。
- 一个或两个 API 实例。
- 两个 Worker 实例。
- 可控的 Fake AI Gateway。

### 必测场景

- API 重启后 Session 仍然有效。
- 两个 API 实例能够读取同一 Session。
- 创建任务后 API 快速返回。
- API 退出后 Worker 继续执行任务。
- Worker 退出后任务由其他 Worker 恢复。
- Redis 短暂中断后 Outbox 自动补投。
- 相同任务重复投递只调用一次模型。
- AI 临时失败后自动重试。
- AI 永久失败后释放积分。
- 结算失败进入待对账状态。
- 队列积压和 Worker 离线可以被健康检查发现。

### 灰度步骤

1. 部署 Redis 基础设施和 Session 接口，但保持 `SESSION_STORE=memory`。
2. 切换一个测试实例到 `SESSION_STORE=redis`。
3. 验证登录、刷新、登出和 API 重启。
4. 部署 Worker 和 Outbox，但保持 `IMAGE_TASK_EXECUTION_MODE=inline`。
5. 启动 Dispatcher 和 Worker，确认健康检查正常。
6. 对白名单用户开启 `IMAGE_TASK_EXECUTION_MODE=queue`。
7. 观察任务成功率、队列延迟、积分对账和死信。
8. 全量切换队列模式。
9. 稳定后删除生产环境内存 Session 和进程内 Worker 回退路径。

### 回滚策略

- Session 回滚不得导致 Redis 中已有 Session 被误删。
- 队列回滚前必须暂停新任务，并处理完或安全迁移等待中的 Job。
- 不得在仍有活动 Job 时直接清空 Redis。
- 回滚不得回退已经执行的 MySQL migration。
- 回滚后仍需运行对账，确认没有未释放预占。

### 最终验收命令

```bash
npm run build
npm run lint
npm test
```

还必须执行真实 Redis 集成测试、API/Worker 重启测试和多实例 Session 测试。只通过单元测试不能判定本计划完成。

## 16. 商业化完成定义

满足以下全部条件后，才能把 Redis 队列和 Redis Session 标记为完成：

- 生产 API 不再使用内存 Session。
- API 重启和多实例部署不会导致用户掉线。
- 图片创建接口不再同步等待模型调用。
- 独立 Worker 可以真实消费 Redis 队列。
- MySQL 与 Redis 之间通过 Outbox 防止丢任务。
- 重复投递不会重复生成或重复扣费。
- Worker 重启后任务可以恢复。
- Redis 短暂中断后任务可以补投。
- 最终失败任务只释放一次积分。
- 结算失败任务进入待对账状态。
- 运维能够查看队列积压、Worker 心跳和死信。
- 所有单元测试、集成测试和重启测试通过。

## 17. Agent 执行规则

每个 Agent 执行 Goal 时必须遵守：

1. 开始前阅读 `AGENTS.md` 和本文档。
2. 一次只执行一个 Goal，不提前实现后续 Goal。
3. 开始时把当前 Goal 状态改为 `执行中`。
4. 先检查当前分支和用户已有修改，不覆盖无关内容。
5. 关键 Redis、队列、幂等、计费和异常逻辑必须写简洁中文注释。
6. 不把 Redis 密码、墨灵 Token、AI 密钥写入代码、日志、测试或文档。
7. 不修改现有计费公开契约和 API snake_case 字段。
8. 完成后执行该 Goal 要求的测试。
9. 验收全部通过后才能把 Goal 状态改为 `已完成`。
10. 交付说明必须列出修改文件、行为变化、测试结果和剩余风险。

## 18. 可直接使用的执行提示词

首次执行 G00：

```text
请阅读 AGENTS.md 和 docs/redis-queue-session-implementation-plan.md。

只执行文档中的 G00“基线确认与设计冻结”，不要提前执行 G01 或后续 Goal。开始前检查当前 Git 分支和未提交修改，不覆盖已有内容。按照 G00 的任务、测试和验收标准完成工作，并更新文档中的 Goal 状态。

完成后说明：
1. 修改了哪些文件；
2. 确认了哪些接口和数据契约；
3. 执行了哪些验证；
4. G00 是否达到验收标准；
5. 开始 G01 前还有什么风险。
```

后续依次执行：

```text
请阅读 AGENTS.md 和 docs/redis-queue-session-implementation-plan.md，检查 Goal 状态和当前代码。

只执行当前第一个状态为“待执行”且前置 Goal 已完成的 Goal。不要提前实现其他 Goal。严格按照该 Goal 的任务、测试和验收标准执行，并保护工作区中已有修改。

完成后更新 Goal 状态，并说明修改文件、实现行为、测试结果、验收结论和剩余风险。如果前置条件不满足，将当前 Goal 标记为“阻塞”并说明原因，不要绕过依赖继续开发。
```
