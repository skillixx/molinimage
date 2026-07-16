# G06 API 和前端异步化交付记录

## 1. 完成范围

G06 已完成队列模式下的 API 快速返回、前端任务轮询、页面恢复和重复提交保护。本文只记录 G06，未实施 G07 的自动重试分类、死信队列或人工重放。

## 2. API 契约

- `POST /api/image/tasks` 在 `IMAGE_TASK_EXECUTION_MODE=queue` 时返回 `202 Accepted`。
- `POST /api/image/tasks/:task_id/retry` 在队列模式下同样返回 `202 Accepted`。
- 两个接口只等待 MySQL 中任务和 Outbox 事务写入，不在 HTTP 请求内调用 AI 网关或进程内 Worker。
- `GET /api/image/tasks/:task_id` 继续作为任务状态和结果文件的唯一查询接口。
- `inline` 模式继续保留原有 `201 Created` 同步行为，便于本地兼容和渐进切换。

## 3. 前端异步流程

五种图片能力统一执行以下流程：

1. 创建任务时生成浏览器侧幂等键，并通过 `Idempotency-Key` 请求头提交；请求发出前把待确认提交写入当前标签页的 `sessionStorage`。
2. API 返回任务 ID 后，将活动任务的 `task_id` 和 `task_type` 保存到 `localStorage`。
3. 前端立即调用任务详情接口，并按 `800ms` 起步、最大 `8s` 的指数退避间隔轮询。
4. `pending`、`billing_reserved`、`queued`、`running`、`billing_pending` 映射到真实进度文案，不提前显示任务完成。
5. `succeeded`、`failed`、`cancelled` 作为终态停止轮询；失败任务继续展示公开中文错误和重试入口。
6. 页面 `pagehide` 时停止定时器；刷新后根据保存的任务 ID 继续查询。
7. 短暂网络错误不会清除任务 ID，页面显示恢复提示并继续退避查询；`401`、`403`、`404` 等永久错误会停止轮询并解除工作台锁定。
8. POST 响应丢失或页面刷新时，前端使用原幂等键、原请求参数和原输入文件 ID 重放，不重新建立计费边界。

`localStorage` 只保存活动任务 ID 和任务类型。为解决 POST 响应丢失竞态，`sessionStorage` 会在当前标签页内短暂保存待确认请求参数，收到任务 ID 后立即删除；不保存图片二进制、Token 或 Provider 密钥。

## 4. 状态映射

| 后端状态           | 前端阶段 | 用户提示                     |
| ------------------ | -------- | ---------------------------- |
| `pending`          | 预占积分 | 正在创建任务                 |
| `billing_reserved` | 预占积分 | 积分已预占，等待进入队列     |
| `queued`           | 生成中   | 任务已排队，等待 Worker 处理 |
| `running`          | 生成中   | AI 正在处理任务              |
| `billing_pending`  | 保存结果 | 结果已生成，积分正在结算     |
| `succeeded`        | 已完成   | 展示文本或结果文件           |
| `failed`           | 失败     | 展示公开错误和重试按钮       |
| `cancelled`        | 失败     | 提示任务已取消               |

## 5. 主要文件

- `src/app/create-app.ts`：队列模式创建和重试返回 `202`。
- `public/assets/api-client.js`：支持透传 `Idempotency-Key`。
- `public/assets/image-task-poller.js`：终态判断、状态映射、退避轮询和网络恢复。
- `public/assets/workbench.js`：五种能力统一提交、任务恢复、结果渲染和页面离开清理。
- `test/image-task-api.test.ts`：验证队列 API 不调用进程内 Worker。
- `test/image-task-poller.test.ts`：验证状态映射、退避、终态停止和网络恢复。
- `test/workspace-frontend.test.ts`：验证五种能力均接入统一异步流程。

## 6. 验证结果

已执行：

```bash
npm run build
npm run lint
node --test dist/test/image-task-api.test.js dist/test/image-task-poller.test.js dist/test/image-task-service.test.js dist/test/workspace-frontend.test.js
RUN_QUEUE_INTEGRATION_TESTS=true node --test dist/test/image-task-queue.integration.test.js dist/test/image-task-worker.integration.test.js
```

验证结果：

- G06 定向测试 `53` 项通过。
- 全量测试 `212` 项中 `209` 项通过，`3` 项按集成测试开关跳过。
- 真实 MySQL + Redis 集成测试 `2` 项通过。
- 五类任务均可由独立 BullMQ Worker 最终消费完成。
- 并发重复创建继续使用稳定任务 ID 和计费幂等键。

## 7. G07 边界

以下内容留给 G07：

- 按错误类型区分自动重试和不可重试错误。
- 超时任务扫描、死信队列和人工重放。
- Worker 崩溃后的更细粒度恢复策略和运维接口。
