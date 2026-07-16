# G00 Redis 队列与会话基线确认及设计冻结

## 1. 记录信息

| 项目                  | 结果                      |
| --------------------- | ------------------------- |
| 记录日期              | 2026-07-16                |
| 当前分支              | `codex/split-image-modes` |
| 基线提交              | `95b922a`                 |
| 当前 Goal             | G00 基线确认与设计冻结    |
| 业务代码变更          | 无                        |
| Redis/BullMQ 依赖变更 | 无                        |

创建本记录时，工作区存在未提交的 Redis 实施计划文档和已有 `output/` 验收产物。G00 不修改、不删除这些已有文件。

## 2. 必读文件确认

已读取：

- `E:\molinimage\AGENTS.md`
- `docs/redis-queue-session-implementation-plan.md`
- `docs/development-standards.md`

后续 Goal 继续遵守以下约束：

- 关键业务逻辑、状态流转、幂等、计费、重试和异常处理需要中文注释。
- 敏感配置只能来自环境变量，不能写入代码、日志、测试和文档。
- Worker 队列载荷只传任务标识，完整任务必须从 MySQL 读取。
- reserve、settle、release 和对账只能由现有计费模块负责。
- 不覆盖工作区中与当前 Goal 无关的已有修改。

## 3. 当前会话基线

当前 API 在 `createAppRequestHandler()` 内默认创建 `InMemorySessionStore`：

```text
墨灵 Ticket
  -> API 校验 Ticket
  -> 生成随机 Session Token
  -> Session 写入 Node.js Map
  -> 浏览器保存 HttpOnly Cookie
```

当前特征：

- Session 只存在于单个 API 进程内存。
- API 重启后 Session 全部丢失。
- 多个 API 实例之间不能共享 Session。
- Cookie 已使用 `HttpOnly`、`SameSite=Lax` 和 TTL。
- 内存 Session 不保存墨灵一次性 Ticket。
- 登录、读取和删除接口目前是同步方法。

G02 才允许抽象异步 `SessionStore` 接口，G03 才允许接入 Redis Session。G00 不修改会话代码。

## 4. 当前图片任务执行基线

### 4.1 创建流程

```text
POST /api/image/tasks
  -> 校验应用 Session
  -> 校验请求 JSON 和输入文件归属
  -> ImageTaskService 校验任务类型、模型、模板和参数
  -> 检查任务创建幂等键
  -> 风控校验
  -> 墨灵积分预占
  -> MySQL 写入 image_tasks，状态为 billing_reserved
  -> API 进程直接调用 ImageGenerationWorkerService.processTask(task_id)
  -> 状态推进到 queued
  -> 状态推进到 running
  -> 调用 AI 网关
  -> 结果写入 MinIO，文件元数据写入 MySQL
  -> 成功时结算积分并写入 succeeded 或 billing_pending
  -> 失败时释放积分并写入 failed
  -> HTTP 请求返回最终任务结果
```

### 4.2 当前同步执行位置

以下任务都在 API 请求内直接调用 `processTask()`：

- `text_to_image`
- `image_to_text`
- `image_to_image`
- `image_restore`
- `upscale`
- 失败任务的 retry task

当前 `src/workers/image-task-worker.ts` 只完成配置加载和启动日志，没有 Redis 连接、队列消费或任务恢复逻辑。

G04 才允许增加队列和 Outbox，G05 才允许让独立 Worker 消费任务，G06 才允许改变 API 响应时机。G00 不修改当前运行行为。

## 5. MySQL 任务状态机冻结

当前状态集合：

```text
pending
billing_reserved
queued
running
succeeded
failed
billing_pending
cancelled
```

当前允许的状态流转：

```text
pending          -> billing_reserved | queued | failed | cancelled
billing_reserved -> queued | billing_pending | failed | cancelled
queued           -> running | failed | cancelled
running          -> succeeded | failed | billing_pending
billing_pending  -> succeeded | failed
succeeded        -> 终态
failed           -> 终态
cancelled        -> 终态
```

冻结要求：

- 后续队列改造必须复用现有公开状态名称。
- 新增内部投递状态优先放在 Outbox，不随意扩展公开 `image_tasks.status`。
- Worker 抢占必须使用带 `fromStatus` 的条件更新，不能无条件覆盖任务状态。
- `succeeded`、`failed`、`cancelled` 任务不得再次调用 AI 网关。
- `billing_pending` 必须继续保留生成结果和原 reserve 关联，等待对账处理。

## 6. 当前幂等边界冻结

### 6.1 任务创建幂等键

来源：请求头 `Idempotency-Key` 或请求体 `idempotency_key`。

数据库约束：

```text
image_tasks.uk_image_tasks_idempotency_key
```

相同幂等键命中已有任务时，必须校验 owner 和关键任务参数一致后返回原任务。

### 6.2 积分预占幂等键

```text
{task_id}:{task_type}:reserve
```

### 6.3 积分结算幂等键

```text
{task_id}:{task_type}:settle
```

### 6.4 积分释放幂等键

```text
{task_id}:{task_type}:release
```

### 6.5 数据库约束

```text
billing_events.uk_billing_events_idempotency_key
```

冻结要求：

- 后续 Goal 不修改上述公开幂等键格式。
- BullMQ `jobId` 使用 `task_id`，不能替代业务和计费幂等键。
- 队列重复投递必须由任务状态条件更新和现有计费幂等共同吸收。
- 结算失败继续写入待对账事件，不能把任务直接伪装成普通成功。
- 释放失败继续进入待对账路径，不能重复归还积分。

## 7. Redis 连接基线

当前环境通过 `REDIS_URL` 配置 Redis：

- URL scheme 为 `redis`。
- 主机和端口已配置。
- 已配置认证信息。
- 本次检查时 TCP 端口可达。
- 检查过程没有输出 Redis 主机、密码或完整连接字符串。
- 应用当前只读取和校验 `REDIS_URL`，没有安装 Redis 客户端，也没有建立运行时连接。

后续实现统一使用 `ioredis`，BullMQ 复用同一技术栈，不再引入第二套 Redis 客户端。

## 8. 队列契约冻结

BullMQ Job 名称：

```text
process-image-task
```

Job data 唯一允许的结构：

```json
{
  "task_id": "task_xxx"
}
```

禁止进入队列的内容：

- `owner_user_id`
- `entitlement_id`
- 提示词和反向提示词
- 输入、输出文件地址或文件内容
- 预计积分和计费事件详情
- 模型供应商密钥
- 墨灵 Token 或 Redis 连接信息

Worker 收到 `task_id` 后必须从 MySQL 加载完整任务，并重新依赖数据库状态和 owner 信息执行。

## 9. Redis Key 前缀冻结

默认前缀：

```text
molinimage
```

建议 Key 命名：

```text
molinimage:session:{sha256_session_token}
molinimage:worker:heartbeat:{worker_id}
molinimage:lock:{business_key}
```

BullMQ 自身 Key 由 `IMAGE_TASK_QUEUE_NAME` 和 BullMQ prefix 统一管理，不允许各模块自行拼接不一致的队列 Key。

生产、测试和本地环境必须允许通过配置覆盖前缀，防止共用 Redis 时互相污染。

## 10. 灰度开关冻结

| 环境变量                        | 可选值            | G00 默认值               | 最终生产值      |
| ------------------------------- | ----------------- | ------------------------ | --------------- |
| `SESSION_STORE`                 | `memory`、`redis` | `memory`                 | `redis`         |
| `IMAGE_TASK_EXECUTION_MODE`     | `inline`、`queue` | `inline`                 | `queue`         |
| `REDIS_KEY_PREFIX`              | 合法非空字符串    | `molinimage`             | 按环境配置      |
| `IMAGE_TASK_QUEUE_NAME`         | 合法非空字符串    | `molinimage-image-tasks` | 按环境配置      |
| `IMAGE_TASK_WORKER_CONCURRENCY` | 正整数            | `2`                      | 压测后配置      |
| `IMAGE_TASK_JOB_ATTEMPTS`       | 正整数            | `3`                      | `3`             |
| `IMAGE_TASK_JOB_TIMEOUT_MS`     | 正整数            | `120000`                 | 按模型 SLA 配置 |

冻结要求：

- G01 只负责读取和校验 Redis 连接及基础配置，不切换运行模式。
- 测试和本地环境允许显式使用 `memory`、`inline`。
- 生产环境最终必须拒绝 `memory` Session 和 `inline` 图片任务执行。
- 切换队列模式前必须先部署可用 Worker 和 Outbox Dispatcher。
- 任何回退都不得清空 Redis 或破坏已预占任务。

## 11. 失败策略冻结

### 11.1 Redis Session

- 生产环境 Redis 不可用时登录和鉴权明确失败。
- 不得静默创建内存 Session。
- 错误响应不得暴露 Redis URL、密码或内部堆栈。

### 11.2 MySQL 与队列投递

- MySQL 任务和 Outbox 记录必须在同一事务中创建。
- Redis 投递失败时 Outbox 保持待投递并退避重试。
- API 在 MySQL 提交后崩溃时，Dispatcher 必须能够补投。
- 超过最大等待时间仍未投递的任务，由恢复流程取消并幂等释放预占。

### 11.3 Worker 执行

- 队列采用至少一次投递。
- 可重试错误不能在第一次失败时立即释放积分。
- 达到最终失败条件后才能将任务置为 `failed` 并释放预占。
- 永久参数错误不进行无意义重试。
- AI 网关、MinIO、MySQL 临时错误按后续 G07 的分类规则退避重试。
- Worker 崩溃或锁超时后，任务必须可以由其他 Worker 恢复。

### 11.4 计费

- 任何 Worker、Dispatcher 或恢复任务都不得直接调用墨灵计费接口。
- 所有计费动作继续通过 `BillingService`。
- reserve、settle、release 幂等键保持不变。
- 结算和释放失败继续进入现有对账流程。

## 12. 本次不修改的公开契约

G00 以及后续 Redis 改造不得擅自修改：

- 墨灵 Ticket 校验和应用 Session Cookie 名称。
- 墨灵应用 ID、商品 ID 和 entitlement 归属规则。
- `POST /api/billing/estimate` 的公开字段。
- 墨灵积分 reserve、settle、release 请求契约。
- 任务创建的 snake_case 请求字段。
- `GET /api/image/tasks/{task_id}` 的 owner 权限边界。
- 文件上传、预览和下载的 owner 权限边界。
- `billing_pending` 对账语义。
- MySQL 和 MinIO 作为任务事实数据与对象存储的职责。

G06 可以在评审后把队列模式下的任务创建响应调整为 `202 Accepted`，但必须同步前端、测试和接口文档，不得在 G01 至 G05 提前修改。

## 13. G01 边界

G01 只允许完成：

- 安装 `ioredis` 和 `bullmq`。
- 增加 Redis 连接、健康检查和 Key 工具。
- 增加 Redis 与队列相关配置读取和校验。
- 增加连接关闭与脱敏错误处理。
- 增加对应单元测试和连接测试。

G01 禁止完成：

- 不替换 `InMemorySessionStore`。
- 不创建 BullMQ Queue 或 Worker 业务实例。
- 不修改图片任务 API 响应时机。
- 不修改 `ImageGenerationWorkerService` 执行语义。
- 不新增 Outbox migration。
- 不切换 `SESSION_STORE` 或 `IMAGE_TASK_EXECUTION_MODE`。

## 14. 基线测试结果

2026-07-16 在 `codex/split-image-modes`、提交 `95b922a` 上执行：

| 命令            | 结果                     |
| --------------- | ------------------------ |
| `npm run build` | 通过                     |
| `npm run lint`  | 通过                     |
| `npm test`      | 通过，157 项测试全部成功 |

测试覆盖了当前 Ticket Session、用户权限、任务状态机、模型选择、文件归属、计费预占、结算、释放、待对账和五类图片 Worker 行为。

这些测试是后续 Goal 的回归基线，不代表 Redis 队列、Redis Session 或多进程恢复已经实现。

## 15. G00 验收结论

- 未修改业务运行行为。
- 当前会话和任务同步执行链路已经记录。
- `image_tasks` 状态机已经冻结。
- 任务、预占、结算和释放幂等键已经冻结。
- Redis 连接方式和脱敏要求已经确认。
- 队列消息结构已经冻结为 `{ task_id: string }`。
- Key 前缀、灰度开关和失败策略已经确认。
- 不修改的墨灵计费公开契约已经列出。
- 基线构建、lint 和 157 项测试全部通过。

G00 达到验收标准。下一步是 G01 Redis 连接基础设施，但必须等待用户确认后才能开始。
