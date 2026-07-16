# G05 独立 Worker 消费任务实施记录

## 1. 完成状态

- Goal：G05 独立 Worker 消费任务
- 状态：已完成
- 完成日期：2026-07-16
- 前置条件：G04 BullMQ 队列与 MySQL Outbox 已完成

本 Goal 只实现独立 Worker、数据库执行租约、执行超时、优雅停机和结果文件幂等，没有提前修改 G06 的 API `202 Accepted` 或前端轮询行为。

## 2. 实现内容

### 2.1 独立 BullMQ Worker

`npm run start:worker` 现在会独立构建 MySQL、MinIO、墨灵计费和 AI 网关依赖，并消费 `process-image-task` Job。

- 队列消息严格限制为 `{ task_id: string }`。
- Worker 根据 `task_id` 从 MySQL 重新读取任务参数和所有者信息。
- 并发数由 `IMAGE_TASK_WORKER_CONCURRENCY` 控制。
- Worker 收到退出信号后先停止领取新任务，等待在途任务完成，再关闭 Redis 和 MySQL。
- API 与 Worker 没有进程内共享状态，可以分别启动、停止和扩容。

### 2.2 MySQL 执行租约

迁移 `018_add_image_task_worker_lease` 为 `image_tasks` 增加：

- `worker_lock_token`
- `worker_lock_expires_at`
- `worker_started_at`
- `worker_attempt_count`
- `idx_image_tasks_worker_recovery`

任务抢占使用单条条件更新完成。只有 `billing_reserved`、`queued` 或租约过期的 `running` 任务能获得新的执行令牌。终态任务和仍由其他 Worker 持有的任务直接跳过。

运行期间 Worker 定时续租。终态写入、结果登记和异常释放都携带当前锁令牌，旧 Worker 即使迟到也不能覆盖新执行者的状态。

### 2.3 超时与异常处理

- 总执行时间由 `IMAGE_TASK_JOB_TIMEOUT_MS` 控制。
- AI 网关请求接收 `AbortSignal`，超时或租约丢失时中止请求。
- 基础设施异常会按当前令牌把任务释放回 `queued`，再交给 BullMQ 的 attempts/backoff 处理。
- AI 业务失败仍由现有任务服务进入 `failed` 并释放预占积分。
- 成功任务继续使用原有 settle 幂等键；结算或释放失败仍进入原有待对账状态。

现有 reserve、settle、release 和对账公开契约没有变化。

### 2.4 结果文件幂等

Worker 生成文件使用任务、能力和序号组成稳定幂等键：

- 相同结果重试会复用同一 `file_id` 和 MinIO 对象路径。
- 复用前校验所有者、MIME 和 SHA-256，内容冲突时明确失败，不能误认成同一文件。
- 每个文件保存成功后立即登记到 `image_tasks.output_file_ids`。
- 如果上次 Worker 已保存并登记全部图片，恢复消费只补任务终态和积分结算，不再次调用模型。

## 3. 关键契约

```ts
interface ImageTaskJobData {
  task_id: string;
}
```

```text
billing_reserved / queued / expired running
  -> MySQL 条件更新抢占
  -> running + worker_lock_token + worker_lock_expires_at
  -> AI / MinIO / 文件登记
  -> succeeded | failed | billing_pending
```

Redis 只负责 Job 交付；任务状态、执行租约、结果文件和计费状态继续以 MySQL 为事实来源。

## 4. 测试与验收

执行结果：

| 验证                                                                         | 结果                           |
| ---------------------------------------------------------------------------- | ------------------------------ |
| `npm run build`                                                              | 通过                           |
| `npm run lint`                                                               | 通过                           |
| `RUN_QUEUE_INTEGRATION_TESTS=true RUN_REDIS_INTEGRATION_TESTS=true npm test` | 207/207 通过                   |
| `npm run db:migrate`                                                         | 已应用 018；重复执行无新增迁移 |
| `npm run start:worker` 隔离队列启动冒烟                                      | 启动成功，无错误输出           |
| G05 测试数据清理                                                             | `image_tasks` 残留 0 条        |

覆盖场景：

- 文生图、图生文、图生图、图片修复和高清放大五类任务消费。
- 两个处理器同时收到同一 `task_id` 时只执行一次。
- `succeeded` 等终态任务重复投递不会调用 AI。
- Worker 重启后可抢占租约过期的 `running` 任务。
- 长任务持续续租，超时任务中止并释放回队列。
- 旧锁令牌不能登记文件或提交终态。
- 结果文件重复保存不会重复写 MinIO 或文件记录。
- BullMQ Worker 关闭会等待当前任务完成。

## 5. 验收结论

G05 验收标准已满足：

- Worker 可作为独立进程部署并通过并发配置扩容。
- API 进程不负责消费任务，停止 API 不影响已运行的 Worker。
- Worker 进程不承载登录、历史查询和任务创建接口，停止 Worker 不影响 API 基础功能。
- 重复投递、过期锁恢复和迟到 Worker 均受到 MySQL 租约与计费幂等保护。

## 6. 剩余风险

- 多图任务只保存了部分结果就崩溃时会保留已登记文件；G07 需要补充部分结果清理或人工恢复策略。
- BullMQ 最终失败分类、死信队列、卡住任务扫描和人工重放属于 G07，本 Goal 不提前实现。
- API 返回 `202`、前端轮询和刷新恢复属于 G06，本 Goal 保持现有接口响应契约。
