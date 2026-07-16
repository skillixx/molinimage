# G09 集成测试、灰度切换与部署验收

## 1. 验收范围

本文件用于把 Redis Session、MySQL Outbox、BullMQ 图片队列和独立 Worker 从开发状态切换为可部署状态。验收不会改变计费 reserve、settle、release、对账接口，也不会改变公开 API 的 snake_case 字段。

生产发布必须满足：

- `SESSION_STORE=redis`，API 不得静默回退到内存 Session。
- `IMAGE_TASK_EXECUTION_MODE=queue`，API 只创建任务与 Outbox，不执行模型调用。
- API、Dispatcher 和 Worker 使用相同的 `REDIS_KEY_PREFIX`、`IMAGE_TASK_QUEUE_NAME` 与数据库。
- API 和 Worker 均通过密钥管理系统注入配置，不在镜像、仓库或日志中保存真实密钥。
- MySQL migration 已执行，MinIO Bucket 已创建，Redis 7 可用。

## 2. 自动化验收矩阵

| 场景                          | 自动化证据                                                                       | 验收点                                              |
| ----------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------- |
| API 重启后 Session 有效       | `runtime-process.integration.test.ts`、`redis-session-store.integration.test.ts` | Redis 中保存 Session，进程内不保存事实状态          |
| 两个 API 实例共享 Session     | `runtime-process.integration.test.ts`                                            | 两个真实 Node 子进程读取同一 Cookie                 |
| 创建任务快速返回              | `image-task-api.test.ts`、`image-task-queue.integration.test.ts`                 | queue 模式返回 HTTP 202，模型调用不在 API 进程执行  |
| API 退出后任务不丢失          | `image-task-queue.integration.test.ts`                                           | 事务提交后的 Outbox 可由新 Dispatcher 补投          |
| Worker 退出后其他实例继续处理 | `image-task-worker.integration.test.ts`                                          | 子进程领取 Job 后被强杀，另一 Worker 在锁过期后接管 |
| Redis 短暂中断后自动补投      | `image-task-queue.integration.test.ts`                                           | 同一 TCP 连接中断并恢复后，原 Dispatcher 自动补投   |
| 重复投递只执行一次            | `image-task-worker.integration.test.ts`                                          | 不同 Job ID 重复投递仍由 MySQL 执行租约去重         |
| AI 临时失败后重试             | `image-task-commercialization.integration.test.ts`                               | 可控 Fake AI 首次失败，真实 BullMQ 第二次执行成功   |
| AI 永久失败后释放积分         | `image-task-commercialization.integration.test.ts`                               | 永久失败与重复 Job 只触发一次 release               |
| 结算失败进入待对账            | `image-task-commercialization.integration.test.ts`                               | 真实 MySQL 任务保留结果并进入 billing_pending       |
| 队列积压与 Worker 离线告警    | `health.test.ts`、`health.integration.test.ts`                                   | readiness 返回稳定告警且不泄露连接信息              |

执行完整验收：

```bash
npm run acceptance
```

该命令依次执行 build、lint、全量测试，并串行启用真实 Redis/MySQL/MinIO/BullMQ 集成测试。数据库测试通过同一连接的临时同名表遮蔽业务表，Redis 使用随机隔离队列名和专用测试任务 ID；仍不得主动把集成测试指向生产环境。

## 3. 灰度步骤

1. 备份当前部署配置并记录 migration 版本，只新增 Redis/队列配置，不回滚数据库 migration。
2. 部署 Redis Session 代码，测试实例保持 `SESSION_STORE=memory`，先验证登录、刷新和登出基线。
3. 将一个无生产流量实例切换为 `SESSION_STORE=redis`，验证同一 Cookie 可跨实例读取，API 重启后仍有效。
4. 部署 Worker 与 Outbox 代码，但 API 暂时保持 `IMAGE_TASK_EXECUTION_MODE=inline`；Worker 使用隔离测试队列完成启动检查。
5. 切换测试实例为 `IMAGE_TASK_EXECUTION_MODE=queue`，启动至少两个 Worker，确认 `/api/health/ready` 返回 `status=ok`。
6. 对内部白名单开放 queue 实例，观察任务创建 HTTP 延迟、成功率、`queue.oldest_wait_ms`、Outbox backlog、死信和计费待对账。
7. 白名单稳定后按实例逐步扩大流量；每次扩容只调整入口流量，不修改队列名或 Redis 前缀。
8. 全量切换后保留一个观察周期，确认没有 memory Session、inline 任务或持续积压，再移除生产回退配置。

## 4. 发布门禁

每次扩大流量前都必须满足：

- `/api/health/live` 返回 HTTP 200。
- `/api/health/ready` 返回 HTTP 200、`status=ok`。
- `dependencies.mysql/redis/minio/queue` 全部为 `ok`，`worker.status=ok`。
- 没有 `IMAGE_WORKER_OFFLINE`，队列和 Outbox 最老等待时间未持续越过阈值。
- 最近任务的成功、失败、重试、release 和 settle 数量能够对账。
- API 创建任务保持 HTTP 202，队列消息只包含 `task_id`。

部署后设置非敏感的 API 根地址并执行：

```bash
DEPLOYMENT_API_BASE_URL=https://molin-image.example.com npm run validate:deployment
```

Windows PowerShell：

```powershell
$env:DEPLOYMENT_API_BASE_URL="https://molin-image.example.com"
$env:DEPLOYMENT_GATE_TOKEN="<独立只读部署门禁令牌>"
npm run validate:deployment
```

校验脚本只承担部署后的基础设施门禁。公开 readiness 只检查远端运行模式和轻量依赖计数；待对账、孤立 reserve 与 failed Job 集合由目标 API 的 `/api/internal/deployment/gate` 在其实际使用的 MySQL、Redis 上计算，并通过独立的 `DEPLOYMENT_GATE_TOKEN` 保护。该令牌只有读取部署门禁的权限，配置加载会拒绝它与具备计费写权限的 `INTERNAL_API_TOKEN` 使用相同值；脚本强制外部地址使用 HTTPS，仅允许 `localhost`、`127.0.0.1` 和 `::1` 回环地址使用 HTTP。脚本会拒绝 `memory` Session、`inline` 任务模式、未排空的 waiting/active/delayed Job、Outbox backlog、待对账事件，以及没有成功 settle/release 终态的孤立 reserve。BullMQ failed Job 作为审计历史保留，不直接删除；存在失败记录时，运维必须逐条审核 Job ID 后设置 `DEPLOYMENT_ACKNOWLEDGED_FAILED_JOB_FINGERPRINT` 为内部门禁返回的集合摘要，集合发生任何替换都会重新阻断门禁。内部门禁通过 Redis Lua 原子读取 failed Job 数量和 ID 集合，最多为 1000 个 failed Job 计算摘要；超过上限返回 `overflow` 并强制阻断发布，要求先通过管理端逐项恢复或处置失败任务。该命令不能替代发布前的 `npm run acceptance`，任务 HTTP 202、最小队列载荷和 AI 异常均由 acceptance 的真实集成链路验收。脚本输出不回显 URL、连接串或密钥。

## 5. 回滚步骤

1. 暂停入口创建新图片任务，保留查询、下载和管理端对账能力。
2. 等待 `queue.waiting=0`、`queue.active=0`；无法等待时记录 Job ID，并通过任务状态和 Outbox 安全迁移，禁止清空 Redis。
3. 停止流量后依次停止 API Dispatcher、等待 Worker 当前任务完成，再停止 Worker。
4. Session 回滚只切换新流量读取策略，不删除 Redis 中已有 Session；用户 Cookie 到期前保留 Redis 数据。
5. 不回滚已经执行的 MySQL migration，不删除 billing_events、Outbox 或任务执行租约记录。
6. 恢复服务后运行对账，确认没有 `settle_pending`、`release_pending` 或未释放预占。
7. 重新执行 `npm run validate:deployment` 和核心任务冒烟测试后才恢复入口流量。

### Failed Job 收敛

failed Job 达到 1001 条时，部署门禁保持阻断。运维应暂停新任务入口，在任务恢复管理页按批次核对任务终态、计费状态和失败原因，并通过现有人工重投流程逐项恢复。人工重投先由业务服务幂等创建新 retry task，再校验并单条移除对应旧 failed Job；重复请求按旧 Job 已移除处理，不会批量触碰其他任务。不得运行脱离业务状态机的 Redis 批量删除脚本。处置后重新执行门禁，直到 failed Job 数量回到摘要上限以内并完成逐条审核。

## 6. 禁止操作

- 队列仍有 active 或 waiting Job 时执行 `FLUSHDB`、`FLUSHALL`、清空队列或更换队列名。
- Redis 不可用时把生产 Session 静默降级到内存。
- Worker 失败时绕过任务服务直接调用计费 release 或 settle。
- 为了恢复任务手工修改为 succeeded，或重复创建新的计费幂等键。
- 在工单、日志或截图中粘贴 Redis、MySQL、MinIO、墨灵或 AI 网关密钥。
