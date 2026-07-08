# 墨灵 AI 图片创作应用 Agent 任务分工

## 1. 文档目的

本文档用于定义 AI 图片创作应用项目中的 Agent 角色、职责边界、参与阶段和具体任务 Goal。后续创建子 Agent、分派开发任务、做阶段验收时，以本文档为任务归属参考。

## 2. Agent 总览

| Agent | 角色定位 | 核心职责 |
|---|---|---|
| `pm-agent` | 产品经理 Agent | 产品范围、优先级、阶段验收、风险能力取舍 |
| `frontend-agent` | 前端 Agent | 工作台、作品历史、任务详情、余额消耗、响应式 UI |
| `backend-app-agent` | 后端应用 Agent | 图片任务、任务状态机、作品历史、任务详情、业务 API |
| `platform-agent` | 平台接入 Agent | 墨灵入口、ticket、session、用户身份和归属校验 |
| `ai-gateway-agent` | AI 网关 Agent | 模型目录、capability、AI Gateway Client、模型调用日志 |
| `storage-agent` | 文件存储 Agent | MinIO、文件上传、预签名 URL、缩略图、OSS 迁移边界 |
| `billing-agent` | 计费 Agent | 积分预估、预占、结算、释放、对账、防重复扣费 |
| `qa-agent` | 测试 Agent | 接口测试、前端验收、回归测试、安全越权和计费异常测试 |
| `devops-agent` | 运维部署 Agent | Docker、MySQL、Redis、MinIO、部署、监控、告警 |
| `safety-agent` | 内容安全 Agent | 提示词审核、图片审核、高风险能力策略、风控日志 |

## 3. Agent 职责边界

### 3.1 pm-agent

负责：

- 产品文档维护。
- 阶段 Goal 优先级。
- MVP 范围控制。
- 验收标准确认。
- 高风险能力是否开放的产品决策。

不负责：

- 直接写后端业务代码。
- 直接修改数据库 migration。
- 直接实现模型调用。

主要文档：

- `docs/ai-image-product-plan.md`
- `docs/ai-image-stage-goals.md`
- `docs/ai-image-model-preparation.md`

### 3.2 frontend-agent

负责：

- AI 图片工作台。
- 文生图、图生图、图片修复、图生文页面。
- 文件上传组件。
- 模型选择器。
- 预计消耗组件。
- 任务进度组件。
- 结果预览。
- 我的作品。
- 任务详情。
- 移动端适配。

不负责：

- 直接调用 AI 网关。
- 直接调用 MinIO。
- 自行计算最终扣费。
- 自行伪造后端业务逻辑。

主要文档：

- `docs/ai-image-frontend-ui-design.md`
- `docs/ai-image-product-plan.md`

### 3.3 backend-app-agent

负责：

- 图片任务 API。
- 任务状态机。
- 任务查询、取消、重试。
- 作品历史。
- 任务详情。
- 业务参数校验。
- 调度 worker。

不负责：

- 墨灵 ticket 具体校验。
- MinIO 底层实现。
- AI 网关上游渠道配置。
- 实际积分扣减底层实现。

主要文档：

- `docs/ai-image-platform-design.md`
- `docs/ai-image-stage-goals.md`

### 3.4 platform-agent

负责：

- 墨灵应用入口。
- ticket 校验。
- session 创建。
- 当前用户信息。
- 用户身份和资源归属上下文。

不负责：

- 图片任务生成逻辑。
- 前端页面实现。
- AI 网关模型调用。

主要 Goal：

- `P1-G01`

### 3.5 ai-gateway-agent

负责：

- AI 网关模型目录对接。
- `GET /api/image/models`。
- `gateway_model_code`。
- capability 过滤。
- AI Gateway Client。
- `ai_gateway_call_logs`。
- 模型准备清单落地。

不负责：

- 直连 OpenAI、Gemini、Stability 或自部署模型。
- 保存上游模型供应商 key。
- 用户侧任务计费扣款。

主要文档：

- `docs/ai-image-model-preparation.md`
- `docs/ai-image-platform-design.md`

### 3.6 storage-agent

负责：

- MinIO 对象存储。
- Storage Service。
- 文件上传。
- 预签名 URL。
- 文件元数据。
- 缩略图。
- 后期阿里云 OSS 迁移边界。

不负责：

- 图片任务状态机。
- AI 网关调用。
- 用户侧积分扣费。

主要 Goal：

- `P1-G03`

### 3.7 billing-agent

负责：

- 价格估算。
- 积分预占。
- 成功结算。
- 失败释放。
- `billing_pending` 对账。
- 幂等键。
- 防重复扣费。
- AI 网关 usage 成本关联。

不负责：

- AI 网关上游模型调用。
- 前端最终价格计算。
- 文件存储实现。

主要 Goal：

- `P2-G02`
- `P2-G06`
- `P4-G01`
- `P4-G04`
- `P4-G06`

### 3.8 qa-agent

负责：

- 测试计划。
- 接口测试。
- 前端验收。
- 回归测试。
- 权限越权测试。
- 计费异常测试。
- 文件访问安全测试。

不负责：

- 替开发补业务实现。
- 直接合并代码。

主要 Goal：

- `P2-G07`
- `P6-G01`
- `P6-G03`
- `P6-G05`

### 3.9 devops-agent

负责：

- Docker Compose。
- MySQL、Redis、MinIO 本地环境。
- 部署配置。
- 健康检查。
- 日志和告警。
- 回滚方案。

不负责：

- 产品功能范围决策。
- 图片任务业务代码。

主要 Goal：

- `P0-G03`
- `P6-G04`

### 3.10 safety-agent

负责：

- 提示词审核。
- 上传图片审核。
- 高风险能力开关。
- 去水印、证件伪造、换脸等风险策略。
- 风控日志。

不负责：

- 普通模型调用封装。
- 计费结算。
- UI 页面实现。

主要 Goal：

- `P4-G05`
- `P6-G03`

## 4. 阶段 Goal 与 Agent 对应表

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

## 5. MVP 阶段 Agent 任务

MVP 最小上线集合对应 Agent 分工如下。

### pm-agent

- 确认 MVP 范围。
- 确认文生图、图生文、作品历史为第一版核心功能。
- 确认图片修复和图生图是否进入下一阶段。
- 确认初版积分价格策略。
- 参与 `P2-G07` 和 `P6-G05` 验收。

### frontend-agent

- `P1-G05` 基础前端框架。
- `P2-G03` 文生图前端表单。
- `P2-G04` 图生文前端表单。
- `P2-G05` 作品历史页面。
- `P2-G07` MVP 前端验收配合。

### backend-app-agent

- `P0-G01` 工程初始化。
- `P0-G02` 基础配置。
- `P1-G02` MySQL 基础表。
- `P2-G01` 图片任务状态机。
- `P2-G03` 文生图任务 API。
- `P2-G04` 图生文任务 API。
- `P2-G05` 作品历史 API。

### platform-agent

- `P1-G01` 墨灵入口与 Session。
- 当前用户上下文。
- 用户资源归属校验基础能力。

### ai-gateway-agent

- `P1-G04` AI 网关模型目录。
- 准备 `image_generation`、`vision_text`、`moderation` 能力。
- AI Gateway Client。
- `ai_gateway_call_logs` 写入规则。

### storage-agent

- `P1-G03` MinIO 文件存储。
- 文件上传。
- 短期预签名 URL。
- 文件元数据。
- 文生图结果图写入 MinIO。

### billing-agent

- `P2-G02` 计费预估与预占。
- `P2-G06` 失败释放与重试。
- 计费幂等。
- 防重复扣费。

### qa-agent

- MVP 主流程测试。
- 文生图测试。
- 图生文测试。
- 文件上传测试。
- 余额不足测试。
- 失败释放测试。
- 用户越权测试。

### devops-agent

- `P0-G03` Docker Compose。
- MySQL、Redis、MinIO 环境。
- 本地环境启动说明。
- P6 部署与监控准备。

### safety-agent

- MVP 内容安全策略。
- 提示词审核规则。
- 上传图片审核策略。
- 高风险能力默认关闭检查。

## 6. Agent 协作顺序

### MVP 推荐协作顺序

```text
pm-agent 确认 MVP 范围
  -> devops-agent 准备 MySQL/Redis/MinIO
  -> backend-app-agent 初始化工程和数据库
  -> platform-agent 打通墨灵入口
  -> ai-gateway-agent 打通模型目录
  -> storage-agent 打通文件上传
  -> billing-agent 打通预估和预占
  -> frontend-agent 搭建工作台
  -> backend-app-agent + frontend-agent 完成文生图/图生文
  -> billing-agent 完成失败释放和重试
  -> qa-agent 回归测试
  -> safety-agent 安全检查
  -> pm-agent 验收上线范围
```

### 并行建议

- `devops-agent` 和 `backend-app-agent` 可并行做 P0。
- `platform-agent`、`storage-agent`、`ai-gateway-agent` 可并行做 P1。
- `frontend-agent` 可以在 API mock 明确后提前开发工作台 UI。
- `billing-agent` 应在 P2-G03/P2-G04 前完成预估和预占。
- `qa-agent` 从 P1 开始介入，不要等功能全部完成后才写测试。

## 7. Agent 创建优先级

### 第一批必须创建

```text
pm-agent
backend-app-agent
frontend-agent
ai-gateway-agent
storage-agent
billing-agent
qa-agent
```

### 第二批建议创建

```text
platform-agent
devops-agent
safety-agent
```

如果人手或上下文有限，可以先让 `backend-app-agent` 临时兼任 `platform-agent`，让 `qa-agent` 临时覆盖部分 `safety-agent` 检查。但在图生图和图片修复进入开发前，建议单独创建 `safety-agent`。

## 8. 交付检查规则

每个 Agent 完成任务时必须输出：

- 完成的 Goal 编号。
- 修改的文件或接口。
- 实现的功能点。
- 自测命令或测试结果。
- 遗留问题。
- 是否影响计费、文件、模型、权限或内容安全。

涉及以下内容必须通知相关 Agent 复核：

- 修改计费规则：通知 `billing-agent` 和 `qa-agent`。
- 修改 AI 网关模型能力：通知 `ai-gateway-agent` 和 `frontend-agent`。
- 修改文件访问：通知 `storage-agent` 和 `safety-agent`。
- 修改用户身份或权限：通知 `platform-agent` 和 `qa-agent`。
- 修改高风险能力：通知 `pm-agent` 和 `safety-agent`。
