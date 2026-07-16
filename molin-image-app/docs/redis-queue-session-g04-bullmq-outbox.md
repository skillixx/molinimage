# G04 BullMQ 队列与 MySQL Outbox 实现记录

## 1. Goal 范围

- Goal：G04 BullMQ 队列与 MySQL Outbox
- 前置 Goal：G01 已完成，G03 Redis Session 已完成
- 本 Goal：任务生产端、事务 Outbox、Dispatcher、重复投递吸收、失败退避、超时取消与积分释放
- 不包含：BullMQ Worker 消费和任务抢占（G05）、202 响应与前端轮询（G06）、死信和停滞任务恢复（G07）

## 2. 灰度配置

```env
IMAGE_TASK_EXECUTION_MODE=inline
IMAGE_TASK_OUTBOX_POLL_INTERVAL_MS=1000
IMAGE_TASK_OUTBOX_BATCH_SIZE=20
IMAGE_TASK_OUTBOX_MAX_WAIT_MS=300000
IMAGE_TASK_OUTBOX_MAX_BACKOFF_MS=60000
```

- `development`、`test` 未配置时默认 `inline`，保留当前同步链路用于本地灰度。
- `production` 未配置时默认 `queue`，显式配置 `inline` 会在启动阶段失败。
- `queue` 模式创建和重试任务时，API 不调用 `ImageGenerationWorkerService.processTask()`。
- G06 前继续返回现有 `201` 结构；异步 `202` 和前端轮询不在本 Goal 提前实现。

## 3. 队列契约

Job 名称固定为：

```text
process-image-task
```

Job ID 固定为图片任务 ID，Job Data 只能包含：

```json
{
  "task_id": "task_xxx"
}
```

BullMQ Job 不保存用户身份、权益 ID、提示词、文件地址、计费参数或密钥。后续 Worker 必须仅凭 `task_id` 回 MySQL 读取完整任务。

`removeOnComplete` 和 `removeOnFail` 暂时关闭，确保终态 Job 存在期间，相同 `task_id` 的迟到重复投递仍由 BullMQ 吸收。清理策略在监控阶段统一配置。

## 4. 事务 Outbox

Migration：

```text
migrations/017_create_image_task_outbox.up.sql
migrations/017_create_image_task_outbox.down.sql
```

状态：

```text
pending -> dispatching -> dispatched
                     `-> failed -> dispatching
pending/failed -> cancelled
```

关键约束：

- `task_id` 唯一，一条图片任务只有一条 Outbox。
- `image_tasks` 与 `image_task_outbox` 使用同一个 MySQL Connection 和同一个事务提交。
- Outbox INSERT 失败时回滚图片任务 INSERT。
- API 在事务提交后崩溃时，新 Dispatcher 可以继续扫描 `pending` 记录并恢复投递。
- 预占成功但任务事务失败时，使用现有任务级 `release` 幂等键释放预占积分。

## 5. Dispatcher 行为

每轮 Dispatcher：

1. 领取超过最大等待时间的记录，取消任务并幂等释放预占积分。
2. 使用 `FOR UPDATE SKIP LOCKED` 领取到期 `pending` 或 `failed` 记录。
3. 使用 `jobId=task_id` 写入 BullMQ。
4. 幂等推进图片任务状态为 `queued`。
5. 把 Outbox 标记为 `dispatched`。
6. Redis 或状态推进失败时保留 Outbox，写入公开错误并指数退避。

并发 Dispatcher 通过行锁跳过彼此已领取的记录。BullMQ JobId 再吸收数据库提交后、Outbox 状态回写前发生崩溃所造成的重复投递。

超时取消失败会写入 `OUTBOX_CANCELLATION_RETRY`，后续只重试取消，不会误投到正常图片队列。

## 6. 时间与时区

Outbox 的可投递时间、超时截止时间、下次重试时间和投递完成时间全部使用 MySQL `CURRENT_TIMESTAMP(3)` 计算。

Node.js 只传递等待时长，禁止把应用 `Date` 与远程 MySQL 无时区 `DATETIME` 直接比较。真实环境测试曾识别出应用与数据库相差 8 小时时新任务被误判超时的问题，该实现已消除这一跨时区比较。

## 7. 幂等与计费

- 图片任务 ID 由 `owner_user_id + 创建幂等键` 的 SHA-256 摘要稳定派生。
- 并发重复请求使用相同 `task_id` 和相同 reserve 幂等键，不会产生两个独立预占。
- Dispatcher 重放 `markTaskQueued()` 时，已是 `queued`、`running` 或 `succeeded` 的任务直接视为成功。
- Outbox 超时取消使用 `${task_id}:${task_type}:release`，重复取消不会重复归还积分。
- reserve、settle、release 和对账公开契约没有修改。

## 8. 验收记录

- `npm run db:migrate`：通过，开发 MySQL 已应用 `017`
- `npm run build`：通过
- `npm run lint`：通过
- `npm test`：通过，197 项通过、0 项失败、2 项外部集成用例默认跳过
- 真实 MySQL 与 Redis 集成测试：通过，覆盖同事务提交、第二步失败回滚、提交后新 Dispatcher 恢复、最小载荷和重复 Job 去重
- G03 Redis 与 G04 队列显式集成测试：2 项通过、0 项失败
- queue 模式 API 临时端口健康检查：通过
- 本 Goal 文件 Prettier 检查：通过
- 全仓 `npm run format:check`：仍有 5 个本 Goal 之前已存在的格式问题，本 Goal 未修改这些文件
- 集成测试数据清理：通过，`image_tasks` 与 `image_task_outbox` 均无 `task_g04_*` 残留
- G05 独立 Worker：未开始
