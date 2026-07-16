# G01 Redis 连接基础设施实施记录

## 1. 实施范围

- Goal：`G01 Redis 连接基础设施`
- 实施日期：2026-07-16
- 当前分支：`codex/split-image-modes`
- 前置 Goal：G00 已完成

本阶段只建设可复用 Redis 连接能力，不切换 Redis Session，不创建 BullMQ 图片队列，不修改任务执行方式，也不修改积分预占、结算、释放和对账契约。

## 2. 配置契约

| 环境变量                        | 默认值                   | 用途                         |
| ------------------------------- | ------------------------ | ---------------------------- |
| `REDIS_URL`                     | 无，必填                 | Redis 连接地址，仅服务端读取 |
| `REDIS_KEY_PREFIX`              | `molinimage`             | Redis 基础 Key 前缀          |
| `REDIS_CONNECT_TIMEOUT_MS`      | `10000`                  | 单次 Redis 建连超时          |
| `REDIS_COMMAND_TIMEOUT_MS`      | `5000`                   | Redis 命令超时               |
| `REDIS_MAX_RETRIES_PER_REQUEST` | `3`                      | 普通客户端单请求最大重试次数 |
| `IMAGE_TASK_QUEUE_NAME`         | `molinimage-image-tasks` | 后续 BullMQ 图片任务队列名称 |
| `IMAGE_TASK_WORKER_CONCURRENCY` | `2`                      | 后续 Worker 默认并发数       |
| `IMAGE_TASK_JOB_ATTEMPTS`       | `3`                      | 后续图片任务最大尝试次数     |
| `IMAGE_TASK_JOB_TIMEOUT_MS`     | `120000`                 | 后续单个图片任务超时         |

实际 Redis Key 前缀为 `{REDIS_KEY_PREFIX}:{APP_ENV}`。例如开发和生产环境会生成不同命名空间，避免共用 Redis 时发生 Key 冲突。

## 3. 连接契约

### 普通连接

`createRedisConnection()` 提供 API、Session 等普通 Redis 客户端：

- 延迟建连，由入口显式调用 `connect()`。
- 启用 Ready Check、建连超时、命令超时和指数退避重连。
- 普通命令使用 `REDIS_MAX_RETRIES_PER_REQUEST`。

### BullMQ 专用连接

`createBullMqRedisConnection()` 提供 Worker 和队列专用客户端：

- `maxRetriesPerRequest` 固定为 `null`，满足 BullMQ 阻塞消费要求。
- 重连延迟从 250ms 递增，最大 5000ms，不会无限快速重连。
- 本阶段只验证连接能力，BullMQ Producer、Consumer 和 Job 在 G04、G05 实现。

### 日志与错误

- 日志只记录连接用途、状态和脱敏端点。
- 不记录完整 `REDIS_URL`、用户名、密码或原始驱动错误。
- 建连失败返回 `RedisConnectionError` 和稳定中文信息。
- PING 失败返回 `RedisHealthCheckError` 和稳定中文信息。
- 重复调用 `close()` 不会重复关闭或抛出异常。

## 4. 进程生命周期

- API 启动前建立普通 Redis 连接并执行 PING。
- Worker 启动前建立 BullMQ 专用连接并执行 PING。
- Redis 不可用时进程明确启动失败，不回退到内存连接或进程内替代实现。
- API 和 Worker 收到 `SIGTERM`、`SIGINT` 后幂等关闭 Redis。
- API 关闭时同时停止 HTTP Server 和 MySQL Pool。

## 5. Key 契约

所有后续 Redis Key 必须通过：

```ts
createRedisKey(config.redisKeyPrefix, "业务类型", "稳定标识");
```

业务段不能为空或包含冒号，避免不同模块自行拼接产生歧义。

## 6. G01 验收记录

- 合法 Redis URL 可创建普通客户端和 BullMQ 专用客户端。
- 不可达 Redis 返回稳定中文错误。
- 密码、用户名和完整主机不会进入连接日志。
- 重复关闭连接安全。
- 开发、测试、生产环境的 Key 前缀相互隔离。
- 当前环境的 API 普通连接和 Worker 专用连接均真实 PING 成功。
- 真实 API 入口在 Redis 连接和 PING 成功后监听临时端口，`/api/health` 返回 200。
- `npm run build`：通过。
- `npm run lint`：通过。
- `npm test`：167 项通过，0 项失败。
- 本阶段修改文件的 Prettier 检查：通过。
- 全库 `npm run format:check` 仍报告 5 个本次未修改的既有前端或测试文件格式不合规，本阶段未覆盖这些用户已有修改。

## 7. 明确未实现

- G02 的异步 `SessionStore` 接口重构。
- G03 的 Redis Session 数据读写。
- G04 的 BullMQ Producer 和 MySQL Outbox。
- G05 的 Worker 图片任务消费。
- G06 及后续 API 异步化、恢复、监控和部署能力。
