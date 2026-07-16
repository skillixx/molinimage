# molinimage

墨灵平台 AI 图片创作应用。当前工程以 `molin-image-app/` 为主应用目录，提供文生图、图生图、图生文、图片修复、高清放大、作品历史、计费预占/结算、MinIO 文件存储、MySQL 持久化和墨灵平台接入能力。

## 代码结构总览

```text
molinimage/
  AGENTS.md                    # Codex 与开发 Agent 协作规则
  docs/                        # 项目规划、模型准备、墨灵对接等设计文档
  molin_docs/                  # 墨灵平台参考文档
  molin-image-app/             # AI 图片应用主工程
    public/                    # 前端页面与浏览器端脚本
    src/
      app/                     # HTTP 服务入口、路由和公开 API 边界
      config/                  # 环境变量读取、配置校验和默认规则
      infrastructure/          # MySQL、MinIO、墨灵接口、AI 网关等外部适配器
      modules/                 # 业务模块：鉴权、计费、文件、任务、模型、风控、模板
      workers/                 # 长耗时图片任务 worker
    migrations/                # MySQL 表结构变更脚本
    scripts/                   # 迁移等运维脚本
    test/                      # Node test 自动化测试
```

## 主应用分层

### `src/app`

负责应用后端的 HTTP 边界，包括：

- 墨灵 ticket 入口、session 创建和 `/api/me`。
- 文件上传、文件预览代理、下载地址。
- 图片任务创建、查询、历史、收藏、删除、重试。
- 计费估算、余额、消耗记录。
- 管理端价格规则、模型配置、风格模板、对账接口。

这里是浏览器能访问的唯一后端入口。前端不能直接调用墨灵内部接口、MinIO 或 AI 网关。

### `src/modules`

业务逻辑层，按领域拆分：

- `auth`：本地应用会话。
- `billing`：积分估算、预占、结算、释放、对账和消耗记录。
- `files`：图片上传、归属校验、MinIO 对象读写、预览 URL 生成。
- `image-models`：模型目录、能力过滤、默认模型选择。
- `image-tasks`：图片任务创建、状态机、幂等、历史、收藏、删除、重试。
- `risk-control`：用户/IP 限流和高风险任务拦截。
- `style-presets`：文生图、图生图、图片修复的提示词模板管理。

当前任务类型已经独立成 `text_to_image`、`image_to_text`、`image_to_image`、`image_restore`、`upscale`。但图生图编辑模式和部分提示词 fallback 仍有硬编码，后续新增很多类型时建议抽成“任务类型注册表 + 提示词模板注册表”。

### `src/infrastructure`

外部系统适配层：

- `ai`：AI 网关客户端，兼容 OpenRouter chat/completions 图片输出和 OpenAI 风格图片接口。
- `database`：MySQL repository，保存任务、文件、计费、模型、模板、风控、对账记录。
- `moling`：墨灵平台 ticket、用户、权益、计费内部接口适配。
- `storage`：MinIO/S3 兼容对象存储适配。
- `audit`：关键操作审计日志。

业务模块只依赖这些适配器暴露的接口，不直接拼接外部服务细节。

### `src/workers`

处理长耗时图片任务。Worker 按 `task_type` 分发：

- `text_to_image`：调用图片生成能力，保存输出图片。
- `image_to_text`：读取输入图，调用视觉理解能力，保存文本结果。
- `image_to_image`：读取参考图，调用图片编辑能力。
- `image_restore`：按修复类型构造提示词，调用图片编辑能力。
- `upscale`：按倍率计算目标尺寸，调用高清放大或通用图片编辑能力。

生成流程遵循：预占积分 -> 进入队列/运行 -> 调用 AI 网关 -> 保存结果 -> 结算积分；失败时释放预占积分，结算/释放异常进入对账。

## 前端结构

前端位于 `molin-image-app/public/`：

- `index.html`：用户工作台页面。
- `assets/workbench.js`：工作台交互、模式切换、上传、提交、历史、详情。
- `assets/api-client.js`：统一 API 封装。
- `billing.html` 与 `assets/billing-records.js`：余额和消耗记录。
- `admin-*.html` 与 `assets/admin-*.js`：模型、价格、模板、对账管理页。

目前前端模式配置集中在 `workbench.js` 的 `modeConfig`，但提交函数仍按模式分别实现。后续若要快速增加很多能力，建议让前端从后端读取任务类型配置和表单 schema。

## 数据与存储

- MySQL：保存任务、文件元数据、计费事件、模型配置、提示词模板、风控记录和对账记录。
- MinIO：保存用户上传图片、AI 输出图片和可下载资产。
- Redis：用于后续生产队列/任务调度能力；当前核心任务链路已有持久化状态机。

文件表只保存 `storage_provider`、`storage_bucket`、`storage_key` 等元数据，不保存二进制内容。历史图片预览通过应用后端 `/api/files/{file_id}/preview` 代理返回，避免浏览器直连 MinIO 内网地址。

## 开发命令

```bash
cd molin-image-app
npm install
npm run build
npm run lint
npm run format:check
npm test
npm run db:migrate
npm start
```

本地服务端口当前使用 `5199`。

## 后续结构优化建议

如果后面要新增大量图片能力，例如换衣服、去水印、局部重绘、扩图、商品图、证件照、姿势迁移，建议优先做三件事：

1. 增加统一的任务类型注册表，描述 `task_type`、能力、输入文件数量、是否需要提示词、是否需要二次确认、默认模型和计费维度。
2. 将图生图编辑模式、修复类型和业务玩法统一沉淀为数据库可配置的提示词模板，而不是继续写死在 worker 和 HTML 中。
3. 将前端表单从硬编码模式切换为后端返回的 `input_schema` 渲染，减少新增类型时需要同时修改多处代码。
