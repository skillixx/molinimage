# G02 SessionStore 接口重构实施记录

## 1. 实施范围

- Goal：`G02 SessionStore 接口重构`
- 实施日期：2026-07-16
- 当前分支：`codex/split-image-modes`
- 前置 Goal：G01 已完成

本阶段只重构 Session 抽象与鉴权调用链。当前 API 仍显式注入 `InMemorySessionStore`，没有实现 Redis Session、Session 灰度配置或跨实例会话共享。

## 2. 接口契约

鉴权模块统一依赖以下异步接口：

```ts
export interface SessionStore {
  createSession(identity: SessionIdentity, ttlSeconds: number): Promise<CreatedSession>;
  getSession(token: string | undefined): Promise<ApplicationSession | undefined>;
  deleteSession(token: string | undefined): Promise<void>;
}
```

类型职责：

- `SessionIdentity`：墨灵票据校验后允许写入应用 Session 的用户、应用、商品和可选权益身份。
- `ApplicationSession`：在身份字段上增加应用 Session ID、创建时间和过期时间。
- `CreatedSession`：包含只写入 Cookie 的随机 Token 和服务端 Session 内容。
- `SessionStore`：屏蔽内存或 Redis 的存储细节。

API 字段继续使用 snake_case，没有改变公开响应结构。

## 3. 调用链变化

- 请求鉴权通过 `await sessionStore.getSession()` 读取 Session。
- 合法墨灵 Ticket 校验完成后，通过 `await sessionStore.createSession()` 创建 Session。
- 登出通过 `await sessionStore.deleteSession()` 删除 Session，再返回过期 Cookie。
- `createAppRequestHandler()` 要求调用方显式注入 `SessionStore`，不再声明或实例化具体内存类。
- API 组合根和测试组合根当前显式注入 `InMemorySessionStore`，为 G03 替换 Redis 实现保留单一入口。

## 4. 保持不变的契约

- Cookie 名称继续来自 `SESSION_COOKIE_NAME`。
- Cookie 内容仍只保存随机应用 Session Token，不保存墨灵一次性 Ticket。
- Cookie 的 `HttpOnly`、`SameSite=Lax`、`Path=/`、TTL 和 Secure 规则不变。
- 墨灵 Ticket 校验、应用/商品匹配和公开错误码不变。
- Session Token、Session ID 的生成方式不变。
- 用户访问文件、任务、余额和管理能力时继续使用 Session 中的 `user_id` 做权限边界。
- 积分预占、结算、释放和对账契约未修改。

## 5. 测试覆盖

- 合法 Ticket 创建 Session 并读取当前用户。
- 根路径 Ticket 入口继续可用。
- 缺失、无效或应用不匹配 Ticket 不创建 Session。
- Session 到期后不可读取并从内存清理。
- 登出后 Session 立即失效，重复删除安全。
- 文件和图片任务接口继续绑定当前 Session 用户。
- `npm run build`：通过。
- `npm run lint`：通过。
- `npm test`：170 项通过，0 项失败。
- G02 修改文件的 Prettier 检查：通过。
- 全库 `npm run format:check` 仍报告 5 个本次未修改的既有前端或测试文件格式不合规，本阶段未覆盖这些用户已有修改。

## 6. 明确未实现

- Redis Session 数据结构、Token 哈希 Key 和 TTL 写入。
- `SESSION_STORE=memory|redis` 灰度配置。
- 生产环境强制 Redis Session。
- API 重启、多实例共享 Session 和真实 Redis 集成测试。

以上内容属于 G03，不在 G02 提前实现。
