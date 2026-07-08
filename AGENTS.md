# AGENTS.md

本文件是 Molin / Moling AI PPT 项目的 Codex 与开发 Agent 协作入口。执行任何代码、文档、测试、部署相关任务前，先阅读本文件，再按任务类型阅读 `molin_docs/` 下对应的权威文档。

## 项目定位

- 项目目标：构建可生产使用的墨灵平台 AI PPT 应用，支持从墨灵平台进入、生成演示文稿、管理生成文件，并通过平台计费体系消耗预付费积分。
- 产品范围：主题/提示词/文档/模板创建 PPT，确认并编辑大纲，生成和预览 PPT，导出 PPTX/PDF，查看积分余额和生成历史，支持失败重试与计费对账。
- 参考范围：Presenton 只作为交互模式参考，不作为运行时代码基座。

## 必读文档

按任务选择阅读，不要凭记忆修改契约：

- 项目总览：`molin_docs/docs/project-overview.md`
- 架构设计：`molin_docs/docs/architecture.md`
- 技术选型：`molin_docs/docs/technology.md`
- 目录设计：`molin_docs/docs/directory.md`
- API 契约：`molin_docs/docs/api.md`、`molin_docs/full-api-design.md`、`molin_docs/frontend-api-reference.md`
- 工作流与协作：`molin_docs/git-workflow.md`、`molin_docs/agents/README.md`
- 测试策略：`molin_docs/docs/testing.md`、`molin_docs/test-plan.md`
- 计费规则：`molin_docs/docs/billing.md`、`molin_docs/backend-token-billing-contract.md`
- 墨灵集成：`molin_docs/docs/moling-integration.md`、`molin_docs/docs/moling-app-integration-guide.md`

## 通用开发规则

- 编写代码时必须同步补充必要的中文注释，说明关键业务逻辑、数据流、状态变化、异常处理和接口调用意图。
- 注释要跟随代码一起写，避免事后补空泛说明；复杂条件、资金逻辑、权限判断、幂等处理、重试与对账逻辑必须有中文注释。
- 提交说明、PR 描述、评审意见和面向团队的交付说明必须使用中文。
- 优先保持现有架构和模块边界；不要为了单个需求引入不必要的新框架或跨层调用。
- 敏感配置必须来自环境变量，禁止把 Token、密钥、密码、身份证号、Refresh Token 等敏感数据写入代码、日志或示例真实值。
- 浏览器客户端不得直接调用墨灵内部 API；所有墨灵平台、计费、存储写权限、AI Provider 密钥相关操作必须由后端或 worker 侧适配器完成。
- Presenton 目录或资料仅作参考，不得把它作为应用运行时代码直接依赖。

## 架构与目录约束

- 应用运行时采用 Node.js + ESM。
- 后端优先采用模块化单体，保持模块边界清晰，后续再按需要拆分服务。
- 生产数据层目标为 PostgreSQL；生产生成任务应使用 Redis 或等价队列；上传文件、生成资产、PPTX/PDF 和缩略图应使用 S3 兼容对象存储。
- API 服务负责会话、鉴权、任务创建、状态读取和平台集成边界。
- Worker 服务负责长耗时的 AI 生成与导出任务，并通过持久化任务状态和幂等键避免重复扣费。
- 业务模块依赖接口，不直接依赖具体 Provider；Provider Adapter 放在 `infrastructure/`。
- 数据库结构变更只应在实现方案确认后写入 `migrations/`。

建议实现目录遵循：

```text
ppt-ai-app/
  src/
    app/
    config/
    modules/
      auth/
      billing/
      decks/
      files/
      generation/
      templates/
      observability/
    infrastructure/
      moling/
      ai/
      storage/
      database/
      queue/
    workers/
  test/
  migrations/
```

## API 契约规则

- 所有公开接口通过应用后端提供；写接口必须基于有效应用会话。
- 长耗时生成接口返回任务 ID，通过异步任务完成。
- JSON 请求体格式错误返回 `REQUEST_JSON_INVALID`，过大请求体返回 `REQUEST_BODY_TOO_LARGE`。
- 所有 HTTP 响应包含 `X-Request-Id`；错误响应必须在 `error.request_id` 中重复该值。
- 错误响应只暴露公开字段，不把内部平台响应、密钥、堆栈或 Provider 原始错误透出给前端。
- 分页列表统一使用 `{items,page,page_size,total}`。
- 接口字段、错误码、分页结构以 API 权威文档为准；字段契约变更必须同步后端、前端和文档。
- Worker 消息不是公开 HTTP API；队列载荷只传必要标识，worker 必须从数据库加载完整状态，不能信任队列载荷作为事实来源。

## 计费与高风险逻辑

- 只有计费模块可以 reserve、settle、release 或 consume 积分。
- 生成流程必须先预占积分，成功后结算，失败后释放；结算失败必须进入待对账状态。
- 积分不足或权益不可用时，必须在调用 AI Provider 前拦截。
- 重试、队列恢复、worker 重启、接口重复提交不得导致重复扣费。
- 钱包、订单、支付、积分、权益额度、实名隐私、权限判定、资产开通属于高风险内容，必须覆盖事务、并发、幂等、审计和异常路径。
- 金额和资金相关值禁止用浮点数计算；前端展示金额时也不得通过 `parseFloat` 或 `Number` 做加减展示。

## 前端规则

- 前端页面只通过 `src/api/*.ts` 调用接口，组件内禁止直接导入 axios 或绕过统一 API 层。
- API 字段保持 snake_case，不在前端自行转换成驼峰。
- 列表接口按 `{items,page,page_size,total}` 渲染。
- 加载态、错误提示、空状态、禁用态、防重复点击和二次确认必须覆盖到用户可触发的关键操作。
- 用户端购买、支付、充值等流程必须生成并传入 `Idempotency-Key`。
- `user_price === "-1"` 表示未配置价格，必须禁购；`"0"` 是合法免费价格。
- 发现接口缺失时，只列出需要后端补充的接口，不在前端自行伪造后端业务逻辑。

## 后端模块边界

- 后端甲：`auth`、`identity`、`iam`、`audit`，以及鉴权、权限、限流相关中间件。
- 后端乙：`product`、`order`、`billing`、`finance_consumer`，负责商品、订单、钱包、支付、按量计费和消费记录。
- 后端丙：`asset`、`membership`、`provision`、`app`、`content`，负责资产、权益、会员、应用接入、系统内容和开通衔接。
- 跨模块需求必须通过接口文档、任务单或评审意见交接，不得越权直接修改其他角色负责的业务代码。

## 角色协作

- 前端甲负责 `web/admin-console` 管理后台。
- 前端乙负责 `web/user-console` 用户控制台。
- 测试工程师负责接口测试、功能测试、验收测试、缺陷跟踪和测试报告。
- 运维工程师负责 infra、环境、CI/CD 和部署。
- 产品经理负责需求确认、业务验收和 PR 合并确认。
- 每个阶段完成后，需要先通过测试验收和产品确认，再进入下一阶段开发。

## 测试与验收

实现代码后按实际目录执行可用命令；若存在 `ppt-ai-app/`，优先执行：

```bash
cd ppt-ai-app
npm test
npm run acceptance
```

涉及墨灵配置时补充执行：

```bash
npm run validate:moling-config
```

必须重点覆盖：

- 墨灵 ticket 入口和应用会话创建。
- 无效或过期 ticket 拒绝。
- 用户不能访问他人的 deck、file 或 task。
- 生成前积分预占、成功结算、失败释放。
- 结算或释放失败进入对账状态。
- 积分不足时不调用 AI Provider。
- 导出文件仅所有者可下载。
- 单页重生成支持 `slide_id` 或一基页码，并保持稳定 slide 身份。
- 并发生成、队列重试、worker 重启不会重复扣费。
- 日志会脱敏 token、密码和隐私字段。

## Git 与交付

- 开发前确认当前分支；如果在 `main`，先创建语义清晰的 feature 分支。
- 代码类分支格式：`feature/{开发者标识}-{模块}-{功能描述}`。
- 纯文档分支格式：`feature/docs-{描述}`。
- Commit message 使用中文，格式：

```text
{类型}：{说明}

{详细描述，可选}

影响模块：{模块名}
```

- 类型包括：`新增`、`修复`、`重构`、`优化`、`文档`、`测试`、`配置`。
- 单个 PR 原则上不超过 500 行代码变更，migration 和生成代码除外。
- 禁止直接 push 到 `main`，禁止跳过 CI 合并，禁止提交 `.env.local`、`.env.prod` 或任何真实密钥文件。

## 交付说明

完成任务时必须说明：

- 修改了哪些文件和模块。
- 对应实现了哪些用户可见行为或接口行为。
- 执行了哪些测试或验证命令。
- 若未能执行测试，说明原因和剩余风险。
- 若发现接口、文档或需求不一致，明确列出需要产品、后端、前端或测试确认的问题。
