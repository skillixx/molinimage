# G03 Redis Session 实现与验收记录

## 1. Goal 状态

- Goal：G03 Redis Session 实现
- 前置 Goal：G02 已完成
- 实现范围：Redis Session、灰度配置、API 组合根、公开错误和集成测试
- 明确不包含：BullMQ、Outbox、独立图片 Worker 和任务执行异步化，这些属于 G04 及后续 Goal

## 2. 运行配置

```env
SESSION_STORE=memory
```

`SESSION_STORE` 只允许 `memory` 或 `redis`：

- `development`、`test` 未填写时默认 `memory`，便于本地灰度和单元测试。
- `production` 未填写时默认 `redis`。
- `production` 显式填写 `memory` 会在启动配置校验阶段失败。
- Redis 模式发生连接或命令故障时显式返回错误，不回退到进程内存。

## 3. Session 数据契约

Redis Key：

```text
{redis_key_prefix}:session:{sha256(session_token)}
```

Cookie 保存随机生成的原始 Session Token，Redis Key 只保存 Token 的 SHA-256 摘要。这样 Redis 管理界面、Key 扫描和普通连接日志不会出现可直接登录的凭证。

Redis Value 使用 JSON：

```json
{
  "session_id": "应用会话 ID",
  "user_id": 479,
  "app_id": 990008,
  "product_id": 990107,
  "entitlement_id": 990311,
  "created_at": "ISO 8601 时间",
  "expires_at": "ISO 8601 时间"
}
```

读取时严格校验 ID、整数和时间字段。JSON 损坏、字段非法或业务时间已过期时按未登录处理并尝试删除 Key；告警不包含 Key、Value、Token 或连接串。

墨灵一次性 Ticket 只用于入口校验，不写入 Session Cookie、Redis Key 或 Redis Value。

## 4. API 行为

- 登录成功：使用 Redis `SET ... EX ttl_seconds` 写入会话，再返回 Session Cookie。
- 鉴权：根据 Cookie Token 的 SHA-256 摘要从 Redis 读取会话。
- 登出：删除 Redis Key，并立即清除浏览器 Cookie。
- 过期：Redis TTL 自动删除；应用层时间校验阻止边界时刻的过期会话继续授权。
- Redis 故障：HTTP 503，错误码 `SESSION_STORE_UNAVAILABLE`，提示“会话服务暂不可用，请稍后重试。”。
- 所有会话错误响应继续包含一致的 `X-Request-Id` 和 `error.request_id`。

## 5. 测试覆盖

单元与 HTTP 测试覆盖：

- Token 哈希 Key 和 Redis TTL 参数。
- 两个 Store 读取同一会话。
- JSON 损坏、字段非法、业务过期和删除。
- Redis `SET`、`GET`、`DEL` 故障统一封装。
- 登录创建、鉴权读取和退出删除故障的安全 503 响应。
- 生产环境强制 Redis，开发和测试允许内存模式。

真实 Redis 集成测试覆盖：

- 两个独立 Redis 连接和两个 API 实例共享 Session。
- HTTP 实例关闭并重建后 Session 仍有效。
- 真实 Redis TTL 到期后自动删除 Key。
- 登出后其它实例立即读取不到 Session。
- Redis Value 不包含墨灵一次性 Ticket。

显式运行真实 Redis 集成测试：

```powershell
$env:RUN_REDIS_INTEGRATION_TESTS='true'
node --test dist/test/redis-session-store.integration.test.js
Remove-Item Env:RUN_REDIS_INTEGRATION_TESTS
```

普通 `npm test` 会跳过外部 Redis 集成用例，避免本地或 CI 未配置 Redis 时产生误报；部署验收必须显式执行该用例。

## 6. 验收结果

- `npm run build`：通过
- `npm run lint`：通过
- `npm test`：通过，180 项通过、0 项失败、1 项外部 Redis 用例默认跳过
- 真实 Redis 集成测试：通过，1 项通过、0 项失败
- 本 Goal 文件 Prettier 检查：通过
- 全仓 `npm run format:check`：仍有 5 个本 Goal 之前已存在的格式问题，本 Goal 未修改这些文件
- G04 BullMQ 与 Outbox：未开始
