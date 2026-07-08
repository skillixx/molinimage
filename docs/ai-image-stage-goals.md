# 墨灵 AI 图片创作应用阶段类型与任务 Goal 拆分

## 1. 文档目的

本文档把墨灵 AI 图片创作应用从产品规划拆解为可执行的阶段类型和任务 Goal。每个 Goal 都应能被单独认领、开发、测试和验收。

拆分原则：

- 阶段之间有清晰前置关系。
- 每个 Goal 有明确交付物和验收标准。
- 先打通最短业务闭环，再补齐能力，再做运营化和商业增强。
- 所有模型调用统一走墨灵 AI 网关协议。
- 数据库使用 MySQL，文件存储第一阶段使用 MinIO。
- 用户侧计费按图片任务结算，AI 网关 usage 只做成本核算和审计，避免双扣费。

## 2. 阶段类型总览

| 阶段 | 阶段类型 | 阶段目标 | 核心产出 |
|---|---|---|---|
| P0 | 项目基础阶段 | 搭建项目骨架、环境、文档和基础规范 | 工程框架、环境配置、基础约定 |
| P1 | 平台接入阶段 | 打通墨灵入口、用户 session、AI 网关目录、MySQL、MinIO | 用户能进入应用并具备基础数据能力 |
| P2 | MVP 创作闭环阶段 | 交付文生图、图生文、任务、文件、计费和历史闭环 | 可上线 MVP |
| P3 | 图片编辑与修复阶段 | 补齐图生图、图片修复、高清放大和再次编辑 | 完整图片创作能力 |
| P4 | 运营配置阶段 | 支持价格、模板、模型开关、限流、对账和消耗记录 | 可运营后台能力 |
| P5 | 商业增强阶段 | 支持批量、商品图、商业海报、品牌模板和团队空间 | 商业化增强能力 |
| P6 | 稳定性与上线阶段 | 完成性能、安全、回归、部署和上线验收 | 可生产发布 |

## 3. P0 项目基础阶段

### 阶段目标

建立项目基础工程和团队开发共识，让后续功能开发有统一目录、环境、规范和验证方式。

### P0-G01 工程初始化

目标：

- 创建 `molin-image-app` 工程骨架。
- 使用 Node.js + TypeScript。
- 建立 API、worker、模块、基础配置目录。

交付物：

- `package.json`
- `src/app`
- `src/modules`
- `src/infrastructure`
- `src/workers`
- `test`
- `migrations`

验收标准：

- 项目可以安装依赖。
- 本地启动命令存在。
- API 和 worker 目录边界清晰。

### P0-G02 基础配置与环境变量

目标：

- 定义应用配置项。
- 准备 `.env.example`。

交付物：

- `APP_BASE_URL`
- `DATABASE_URL`
- `REDIS_URL`
- `STORAGE_PROVIDER`
- `STORAGE_ENDPOINT`
- `STORAGE_BUCKET`
- `MOLING_API_BASE_URL`
- `AI_GATEWAY_BASE_URL`
- `INTERNAL_API_TOKEN`

验收标准：

- `.env.example` 只包含占位值。
- 真实密钥不进入仓库。
- 缺少关键配置时应用给出明确启动错误。

### P0-G03 Docker Compose 开发环境

目标：

- 提供本地 MySQL、Redis、MinIO 开发环境。

交付物：

- `docker-compose.yml`
- MySQL 8.0 服务。
- Redis 服务。
- MinIO 服务和控制台端口。

验收标准：

- 本地能一键启动基础依赖。
- MinIO bucket 可初始化。
- API 能连接 MySQL、Redis、MinIO。

### P0-G04 基础代码规范

目标：

- 建立 TypeScript、lint、format、测试命令。

交付物：

- `tsconfig.json`
- lint 配置。
- format 配置。
- test 配置。

验收标准：

- `npm run build` 可执行。
- `npm test` 可执行。
- 新增代码遵守中文注释要求，关键业务逻辑有中文注释。

## 4. P1 平台接入阶段

### 阶段目标

打通墨灵平台入口、用户身份、模型目录、数据库和对象存储，为 MVP 功能提供基础能力。

### P1-G01 墨灵入口与 Session

目标：

- 支持从墨灵平台 ticket 进入应用。
- 校验 ticket 并创建应用 session。

交付物：

- `GET /?ticket=...`
- `GET /enter?ticket=...`
- `GET /api/me`
- session 中间件。

验收标准：

- 合法 ticket 可进入应用。
- 无效 ticket 被拒绝。
- `GET /api/me` 返回当前用户信息。
- 日志不打印 ticket 或 session token。

### P1-G02 MySQL 数据库基础

目标：

- 建立图片应用基础表结构。

交付物：

- `image_tasks`
- `files`
- `billing_events`
- `ai_gateway_call_logs`
- `style_presets`
- `user_collections`

验收标准：

- migration 可重复执行和回滚。
- 表使用 InnoDB 和 `utf8mb4`。
- 幂等键、用户查询、任务查询相关索引存在。

### P1-G03 MinIO 文件存储

目标：

- 建立统一 Storage Service。
- 使用 MinIO 保存上传图、生成图和缩略图。

交付物：

- Storage Service。
- 文件上传到 MinIO。
- 短期预签名 URL。
- `files` 元数据写入。

验收标准：

- 文件不写入 MySQL 二进制字段。
- 只能读取自己的文件。
- 数据库只保存 `storage_provider`、`storage_bucket`、`storage_key`。

### P1-G04 AI 网关模型目录

目标：

- 从墨灵 AI 网关获取当前用户可见的图片模型目录。

交付物：

- AI Gateway Client。
- `GET /api/image/models`
- 模型 capability 过滤。
- 按 `docs/ai-image-model-preparation.md` 准备 MVP 必备模型能力。

验收标准：

- 前端只看到当前用户可见模型。
- 只返回图片应用支持的能力模型。
- 模型不可用时返回空列表和中文提示所需信息。
- MVP 必备的 `image_generation`、`vision_text`、`moderation` 能力在 AI 网关目录中可用。

### P1-G05 基础前端框架

目标：

- 搭建 AI 图片应用前端基础框架。

交付物：

- 顶部栏。
- 工作台页面。
- 功能模式切换。
- API 请求封装。
- 基础错误提示。

验收标准：

- 进入应用后首屏是工作台。
- 前端不直接调用 AI 网关、MinIO 或墨灵内部接口。
- 模型列表来自 `GET /api/image/models`。

## 5. P2 MVP 创作闭环阶段

### 阶段目标

完成可上线 MVP：用户能文生图、图生文、上传文件、查看作品历史，并完成计费预占、结算、失败释放。

### P2-G01 图片任务状态机

目标：

- 建立统一图片任务状态机。

交付物：

- 任务创建。
- 任务查询。
- 状态流转。
- 失败原因记录。

验收标准：

- 支持 `pending`、`billing_reserved`、`queued`、`running`、`succeeded`、`failed`、`billing_pending`、`cancelled`。
- 非法状态流转被拦截。
- 任务必须绑定 `owner_user_id`。

### P2-G02 计费预估与预占

目标：

- 用户提交前能看到预计积分。
- 任务创建时预占积分。

交付物：

- `POST /api/billing/estimate`
- 计费规则读取。
- 预占计费事件。

验收标准：

- 参数变化后可重新估算。
- 余额不足不能创建任务。
- 计费事件具备幂等键。

### P2-G03 文生图能力

目标：

- 用户输入提示词生成图片。

交付物：

- 文生图前端表单。
- 文生图任务创建。
- worker 调用 AI 网关 `image_generation` 能力。
- 结果图存 MinIO。

验收标准：

- 成功后任务进入 `succeeded`。
- 结果写入 `files`。
- 图片可预览和下载。
- AI 网关调用日志落库。

### P2-G04 图生文能力

目标：

- 用户上传图片生成描述、标题、标签或文案。

交付物：

- 图生文前端表单。
- 上传图片。
- worker 调用 AI 网关 `vision_text` 能力。
- 文本结果保存。

验收标准：

- 支持复制文本结果。
- 文本结果进入作品历史。
- 用户不能使用他人图片生成文案。

### P2-G05 作品历史

目标：

- 用户能查看和管理自己的生成结果。

交付物：

- `GET /api/image/history`
- 作品列表页。
- 图片结果卡片。
- 文本结果卡片。
- 收藏和删除。

验收标准：

- 只展示当前用户作品。
- 支持按任务类型筛选。
- 删除需要二次确认。

### P2-G06 失败释放与重试

目标：

- 任务失败时释放预占积分，并允许用户重试。

交付物：

- 失败释放流程。
- `POST /api/image/tasks/{task_id}/retry`
- 前端失败状态和重试按钮。

验收标准：

- AI 网关失败不扣费。
- 文件存储失败不扣费。
- 重试不会重复扣费。

### P2-G07 MVP 前端验收

目标：

- 完成 MVP 前端体验闭环。

交付物：

- 文生图模式。
- 图生文模式。
- 文件上传组件。
- 预计消耗组件。
- 任务进度组件。
- 结果预览组件。

验收标准：

- 用户能完成一次文生图并下载。
- 用户能完成一次图生文并复制结果。
- 余额不足时提交按钮禁用。
- 移动端基本可用。

## 6. P3 图片编辑与修复阶段

### 阶段目标

补齐图生图、图片修复、高清放大和再次编辑能力，让产品从 MVP 变成完整图片创作工具。

### P3-G01 图生图能力

目标：

- 用户上传参考图并生成新图。

交付物：

- 图生图表单。
- 编辑模式：保持主体、换背景、换风格、生成变体。
- AI 网关 `image_edit` 调用。

验收标准：

- 输入图必须归属当前用户。
- 成功结果可继续编辑。
- 支持查看输入图和输出图关联。

### P3-G02 图片修复能力

目标：

- 用户能修复和增强图片。

交付物：

- 图片修复表单。
- 修复类型：老照片修复、去噪增强、模糊变清晰、色彩增强。
- AI 网关 `image_restore` 或 `image_edit` 调用。

验收标准：

- 高消耗任务有二次确认。
- 修复结果保留原图关联。
- 修复失败释放积分。

### P3-G03 高清放大

目标：

- 用户能选择 2x 或 4x 高清放大。

交付物：

- 高清倍率参数。
- 对应价格规则。
- 放大结果文件。

验收标准：

- 不同倍率价格不同。
- 放大后文件元数据记录宽高。

### P3-G04 再次编辑

目标：

- 用户能用历史结果继续发起新任务。

交付物：

- 再次编辑按钮。
- 参数回填。
- 输入图自动带入。

验收标准：

- 历史图片可作为新任务输入。
- 新任务和旧任务有可追踪关系。

### P3-G05 任务详情

目标：

- 用户能查看单个任务的完整信息。

交付物：

- 任务详情页或抽屉。
- 输入参数。
- 输入文件。
- 输出结果。
- 消耗积分。
- 状态和错误信息。

验收标准：

- 用户不能查看他人任务详情。
- 失败任务能看到中文失败原因。

## 7. P4 运营配置阶段

### 阶段目标

让产品具备后台运营能力，可配置价格、模型、模板、限流和对账。

### P4-G01 价格配置

目标：

- 管理端可配置不同任务价格。

交付物：

- 价格规则管理。
- 按任务类型、模型能力、质量、尺寸配置积分。

验收标准：

- 前端估算与后端价格一致。
- 禁用价格规则后对应任务不可提交或使用默认规则。

### P4-G02 模型开关与能力配置

目标：

- 管理端可控制图片应用可用模型。

交付物：

- 模型列表同步。
- 模型能力标签配置。
- 默认模型配置。

验收标准：

- 关闭模型后用户端不可见。
- 模型能力不匹配时不能提交任务。

### P4-G03 风格模板管理

目标：

- 管理端可配置风格模板。

交付物：

- 模板名称。
- 模板分类。
- prompt 模板。
- 预览图。
- 排序和启停。

验收标准：

- 启用模板在前端可见。
- 停用模板不再展示。

### P4-G04 对账管理

目标：

- 管理端可处理 `billing_pending` 和释放失败任务。

交付物：

- 待对账列表。
- 重试结算。
- 重试释放。
- 对账结果记录。

验收标准：

- 待对账任务可被重试处理。
- 失败原因可追踪。

### P4-G05 用户限流与风控

目标：

- 控制用户任务频率和高风险请求。

交付物：

- 用户级限流。
- IP 级限流。
- 高风险能力开关。
- 风控日志。

验收标准：

- 高频请求被限制。
- 命中风控时不调用 AI 网关。

### P4-G06 消耗记录

目标：

- 用户可查看积分消耗记录。

交付物：

- 余额与消耗页。
- 任务关联。
- 预占、结算、释放、待对账状态展示。

验收标准：

- 用户只能查看自己的消耗记录。
- 点击记录可跳转任务详情。

## 8. P5 商业增强阶段

### 阶段目标

面向电商、运营和企业团队增强产品价值，提高客单价和复用率。

### P5-G01 批量任务

目标：

- 支持批量生成或批量修复。

交付物：

- 批量上传。
- 批量任务创建。
- 批量进度。
- 批量下载。

验收标准：

- 批量任务逐项可追踪。
- 单项失败不影响全部任务结算。

### P5-G02 商品图处理

目标：

- 支持电商商品图场景。

交付物：

- 商品主图增强。
- 背景替换。
- 商品卖点文案。
- 商品海报模板。

验收标准：

- 产品主体尽量保持一致。
- 输出结果可直接下载。

### P5-G03 商业海报工作流

目标：

- 用户能围绕主题快速生成海报。

交付物：

- 海报场景模板。
- 标题、副标题、卖点输入。
- 图片和文案组合生成。

验收标准：

- 用户能完成一次完整海报生成。
- 海报结果进入作品历史。

### P5-G04 品牌模板

目标：

- 企业用户可维护品牌风格。

交付物：

- 品牌色。
- 字体偏好。
- Logo 素材。
- 品牌 prompt 模板。

验收标准：

- 生成时可选择品牌模板。
- 品牌模板仅归属用户或团队可见。

### P5-G05 团队空间

目标：

- 支持团队共享作品和模板。

交付物：

- 团队作品库。
- 团队模板。
- 成员权限。

验收标准：

- 团队成员可共享作品。
- 非成员不可访问团队资源。

## 9. P6 稳定性与上线阶段

### 阶段目标

完成生产上线前的质量、安全、性能和运维准备。

### P6-G01 全量回归测试

目标：

- 覆盖所有核心用户路径。

交付物：

- 回归测试用例。
- 测试报告。
- 缺陷清单。

验收标准：

- P0/P1 缺陷清零。
- MVP 主流程全部通过。

### P6-G02 性能与容量测试

目标：

- 验证任务、上传、队列和 AI 网关调用的容量。

交付物：

- 并发任务测试。
- 文件上传测试。
- worker 消费能力测试。

验收标准：

- 平均任务耗时在可接受范围。
- 队列积压可观察。
- 系统繁忙时有明确提示。

### P6-G03 安全检查

目标：

- 检查权限、文件、密钥、内容安全和日志脱敏。

交付物：

- 安全检查报告。
- 高风险能力开关检查。

验收标准：

- 用户不能访问他人任务和文件。
- 日志不输出密钥、token、永久文件 URL。
- 去水印、伪造证件等高风险能力未开放。

### P6-G04 部署与监控

目标：

- 准备生产部署和运行监控。

交付物：

- 部署配置。
- 健康检查。
- 日志面板。
- 任务失败告警。
- 对账异常告警。

验收标准：

- API、worker、MySQL、Redis、MinIO 连接正常。
- 关键失败有告警。
- 回滚方案明确。

### P6-G05 上线验收

目标：

- 完成产品、测试、运维联合验收。

交付物：

- 上线 checklist。
- 验收报告。
- 已知问题清单。

验收标准：

- 产品确认功能范围。
- 测试确认质量门禁通过。
- 运维确认部署与监控可用。

## 10. 推荐执行顺序

```text
P0-G01 -> P0-G02 -> P0-G03 -> P0-G04
  -> P1-G01 -> P1-G02 -> P1-G03 -> P1-G04 -> P1-G05
  -> P2-G01 -> P2-G02 -> P2-G03 -> P2-G04 -> P2-G05 -> P2-G06 -> P2-G07
  -> P3-G01 -> P3-G02 -> P3-G03 -> P3-G04 -> P3-G05
  -> P4-G01 -> P4-G02 -> P4-G03 -> P4-G04 -> P4-G05 -> P4-G06
  -> P5-G01 -> P5-G02 -> P5-G03 -> P5-G04 -> P5-G05
  -> P6-G01 -> P6-G02 -> P6-G03 -> P6-G04 -> P6-G05
```

可以并行的任务：

- P0-G02、P0-G03、P0-G04 可并行。
- P1-G02、P1-G03、P1-G04 可并行。
- P2-G03 和 P2-G04 可在任务状态机和计费预占完成后并行。
- P3-G01、P3-G02、P3-G03 可并行开发，但共享上传、计费和 AI 网关能力。
- P4-G01、P4-G02、P4-G03 可并行。

## 11. MVP 最小上线 Goal 集合

若只做第一版可上线 MVP，至少完成：

- P0-G01 工程初始化。
- P0-G02 基础配置与环境变量。
- P0-G03 Docker Compose 开发环境。
- P1-G01 墨灵入口与 Session。
- P1-G02 MySQL 数据库基础。
- P1-G03 MinIO 文件存储。
- P1-G04 AI 网关模型目录。
- P1-G05 基础前端框架。
- P2-G01 图片任务状态机。
- P2-G02 计费预估与预占。
- P2-G03 文生图能力。
- P2-G04 图生文能力。
- P2-G05 作品历史。
- P2-G06 失败释放与重试。
- P2-G07 MVP 前端验收。
- P6-G01 全量回归测试。
- P6-G03 安全检查。
- P6-G05 上线验收。

## 12. Agent 加入 Goal 规划

为避免 Goal 只停留在任务列表，后续每个 Goal 都按“主责 Agent 认领、协作 Agent 配合、验收 Agent 复核”的方式推进。详细职责边界以 `docs/ai-image-agent-task-assignment.md` 为准，本文档用于在阶段规划层面明确如何使用 Agent。

### 12.1 使用规则

- 每个 Goal 必须有一个主责 Agent，负责拆任务、推动实现、更新交付状态。
- 协作 Agent 只处理自己边界内的内容，不能越权修改计费、模型、存储、权限等高风险模块。
- 涉及计费、文件访问、模型能力、用户权限、内容安全的 Goal，必须让对应专业 Agent 复核。
- 一个 Goal 完成时，主责 Agent 必须输出修改文件、接口变化、测试结果、遗留风险和是否影响高风险模块。
- 进入下一阶段前，`qa-agent` 需要确认本阶段关键验收标准，`pm-agent` 需要确认产品范围和上线取舍。

### 12.2 Goal 与 Agent 分配总表

| Goal | 任务 | 主责 Agent | 协作 Agent |
|---|---|---|---|
| P0-G01 | 工程初始化 | `backend-app-agent` | `devops-agent` |
| P0-G02 | 基础配置与环境变量 | `backend-app-agent` | `devops-agent` |
| P0-G03 | Docker Compose 开发环境 | `devops-agent` | `backend-app-agent` |
| P0-G04 | 基础代码规范 | `backend-app-agent` | `frontend-agent`、`qa-agent` |
| P1-G01 | 墨灵入口与 Session | `platform-agent` | `backend-app-agent`、`qa-agent` |
| P1-G02 | MySQL 数据库基础 | `backend-app-agent` | `billing-agent`、`storage-agent` |
| P1-G03 | MinIO 文件存储 | `storage-agent` | `backend-app-agent`、`devops-agent` |
| P1-G04 | AI 网关模型目录 | `ai-gateway-agent` | `frontend-agent`、`pm-agent` |
| P1-G05 | 基础前端框架 | `frontend-agent` | `platform-agent`、`ai-gateway-agent` |
| P2-G01 | 图片任务状态机 | `backend-app-agent` | `billing-agent`、`qa-agent` |
| P2-G02 | 计费预估与预占 | `billing-agent` | `backend-app-agent`、`frontend-agent` |
| P2-G03 | 文生图能力 | `backend-app-agent` | `frontend-agent`、`ai-gateway-agent`、`storage-agent`、`billing-agent` |
| P2-G04 | 图生文能力 | `backend-app-agent` | `frontend-agent`、`ai-gateway-agent`、`storage-agent` |
| P2-G05 | 作品历史 | `backend-app-agent` | `frontend-agent`、`storage-agent` |
| P2-G06 | 失败释放与重试 | `billing-agent` | `backend-app-agent`、`qa-agent` |
| P2-G07 | MVP 前端验收 | `qa-agent` | `frontend-agent`、`pm-agent` |
| P3-G01 | 图生图能力 | `backend-app-agent` | `frontend-agent`、`ai-gateway-agent`、`storage-agent`、`safety-agent` |
| P3-G02 | 图片修复能力 | `backend-app-agent` | `frontend-agent`、`ai-gateway-agent`、`safety-agent`、`billing-agent` |
| P3-G03 | 高清放大 | `backend-app-agent` | `ai-gateway-agent`、`billing-agent`、`frontend-agent` |
| P3-G04 | 再次编辑 | `frontend-agent` | `backend-app-agent`、`storage-agent` |
| P3-G05 | 任务详情 | `frontend-agent` | `backend-app-agent`、`billing-agent` |
| P4-G01 | 价格配置 | `billing-agent` | `pm-agent`、`frontend-agent` |
| P4-G02 | 模型开关与能力配置 | `ai-gateway-agent` | `pm-agent`、`frontend-agent` |
| P4-G03 | 风格模板管理 | `pm-agent` | `frontend-agent`、`backend-app-agent` |
| P4-G04 | 对账管理 | `billing-agent` | `backend-app-agent`、`qa-agent` |
| P4-G05 | 用户限流与风控 | `safety-agent` | `backend-app-agent`、`devops-agent` |
| P4-G06 | 消耗记录 | `billing-agent` | `frontend-agent`、`backend-app-agent` |
| P5-G01 | 批量任务 | `backend-app-agent` | `frontend-agent`、`billing-agent` |
| P5-G02 | 商品图处理 | `pm-agent` | `frontend-agent`、`backend-app-agent`、`ai-gateway-agent` |
| P5-G03 | 商业海报工作流 | `pm-agent` | `frontend-agent`、`backend-app-agent` |
| P5-G04 | 品牌模板 | `pm-agent` | `frontend-agent`、`backend-app-agent` |
| P5-G05 | 团队空间 | `backend-app-agent` | `frontend-agent`、`platform-agent` |
| P6-G01 | 全量回归测试 | `qa-agent` | 全部 Agent |
| P6-G02 | 性能与容量测试 | `qa-agent` | `devops-agent`、`backend-app-agent` |
| P6-G03 | 安全检查 | `safety-agent` | `qa-agent`、`devops-agent` |
| P6-G04 | 部署与监控 | `devops-agent` | `qa-agent`、`backend-app-agent` |
| P6-G05 | 上线验收 | `pm-agent` | `qa-agent`、`devops-agent`、全部主责 Agent |

### 12.3 MVP 推荐启动 Agent 队列

第一版 MVP 建议先创建并使用以下 Agent：

```text
pm-agent
backend-app-agent
frontend-agent
ai-gateway-agent
storage-agent
billing-agent
qa-agent
```

第二批再补充：

```text
platform-agent
devops-agent
safety-agent
```

如果开发资源有限，`backend-app-agent` 可以临时兼任 `platform-agent` 的部分任务，`qa-agent` 可以临时覆盖基础安全检查。但进入图生图、图片修复、高风险图片处理前，应单独创建 `safety-agent`。

### 12.4 阶段推进方式

```text
pm-agent 确认阶段范围和验收口径
  -> 主责 Agent 拆解当前 Goal 的实现任务
  -> 协作 Agent 补齐接口、模型、存储、计费或前端依赖
  -> qa-agent 根据验收标准补测试和缺陷清单
  -> pm-agent 做阶段验收和范围取舍
```

每个阶段结束后，进入下一阶段前至少确认：

- 本阶段 Goal 是否全部完成或明确延期。
- 高风险模块是否已由对应 Agent 复核。
- 测试用例、验收结果和遗留问题是否可追踪。
- 文档、API 契约、数据库结构和前端行为是否保持一致。
