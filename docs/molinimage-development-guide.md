# molinimage 开发文档

## 1. 文档目的

本文档用于说明 molinimage 当前项目的技术方案、核心架构、模型接入方式、墨灵平台对接方式、阶段规划和后续开发重点。它面向产品、开发、测试、运维和后续接手的 Agent，作为开发推进时的总入口文档。

当前项目已经不是纯方案阶段，而是进入“基础工程 + MVP 功能闭环 + 墨灵联调”的开发阶段。后续新增功能时，应优先参考本文档，再按具体模块查看 `docs/` 下的细分文档。

## 2. 项目定位

molinimage 是接入墨灵平台的 AI 图片创作应用，为墨灵用户提供以下能力：

- 文生图：根据提示词生成图片。
- 图生图：上传参考图后按提示词编辑或生成新图。
- 图片修复：老照片修复、去噪、增强、模糊变清晰等。
- 高清放大：按 2x 或 4x 对图片做增强放大。
- 图生文：根据图片生成描述、标题、标签、提示词反推或文案。
- 作品历史：保存生成结果，支持预览、下载、再次编辑、收藏和删除。
- 积分计费：通过墨灵平台权益和积分体系做预占、结算、释放和对账。

产品目标不是简单封装模型 API，而是做一个可以计费、可追踪、可运营、可扩展的图片任务平台。

## 3. 当前技术栈

| 层级 | 当前选型 | 说明 |
|---|---|---|
| 运行时 | Node.js 20+ | 项目使用 ESM 模块 |
| 语言 | TypeScript | 后端、worker、脚本统一使用 TypeScript |
| API 服务 | Node 原生 HTTP 模块 | 当前未引入 Express/Fastify，保持轻量模块化单体 |
| 前端 | 原生 HTML/CSS/JavaScript | 当前工作台在 `public/` 下，适合 MVP 快速验证 |
| 数据库 | MySQL | 保存任务、文件元数据、计费事件、模型配置、作品历史 |
| 对象存储 | MinIO | S3 兼容，后期方便迁移到阿里云 OSS |
| 队列 | Redis | 用于图片任务异步处理、后续可接入持久任务队列 |
| AI 接入 | OpenAI 兼容 HTTP 协议 | 当前 OpenRouter 直连已跑通，目标切到墨灵 AI 网关 |
| 测试 | Node test runner | 构建后执行 `node --test dist/test/**/*.test.js` |
| 质量工具 | ESLint、Prettier、TypeScript | 构建、lint、格式化分开执行 |

主要 npm 脚本：

```bash
npm run dev
npm run dev:worker
npm run db:migrate
npm run build
npm run lint
npm test
npm run start
npm run start:worker
```

## 4. 当前目录结构

```text
molin-image-app/
  src/
    app/                     # API 服务、路由、HTTP 入口
    config/                  # 环境变量读取和配置校验
    infrastructure/
      ai/                    # AI 网关客户端
      database/              # MySQL repository
      storage/               # MinIO / 对象存储封装
    modules/
      auth/                  # 会话与墨灵入口
      billing/               # 计费估算、预占、结算、释放、对账
      files/                 # 文件上传、读取、下载 URL
      image-models/          # 图片模型目录与能力过滤
      image-tasks/           # 图片任务状态机和任务创建
      risk-control/          # 风控和限流
      style-presets/         # 风格预设
    workers/                 # 图片任务 worker
  public/                    # MVP 前端页面和静态资源
  migrations/                # MySQL migration
  scripts/                   # 迁移等脚本
  test/                      # 测试用例
```

根目录 `docs/` 放产品、架构、阶段目标、模型准备、墨灵对接和 Agent 分工文档。

## 5. 核心架构

```text
用户浏览器
  -> molinimage API 服务
    -> Session / Auth
    -> Image Task
    -> Billing
    -> File Service
    -> Image Model Service
    -> Risk Control
  -> MySQL
  -> MinIO
  -> Redis
  -> Worker
    -> AI Gateway Client
      -> 当前：OpenRouter
      -> 目标：墨灵 AI 网关
```

架构原则：

- 前端不直接调用 OpenRouter、墨灵 AI 网关、MinIO 或墨灵内部接口。
- 所有密钥只放服务端环境变量，不写入前端代码。
- 图片任务异步执行，API 创建任务后由 worker 处理。
- 数据库只保存文件元数据和对象 key，不保存图片二进制。
- 用户只能访问自己的任务和文件。
- 计费必须先预占，成功结算，失败释放，异常进入对账。

## 6. 当前模型调用方式

### 6.1 当前 OpenRouter 调用方式

当前 `.env` 中 `AI_GATEWAY_BASE_URL` 指向：

```text
https://openrouter.ai/api/v1
```

图片能力不是调用传统图片接口：

```text
/images/generations
/images/edits
```

而是统一走 OpenRouter 的：

```text
POST /chat/completions
```

文生图请求核心结构：

```json
{
  "model": "google/gemini-3.1-flash-lite-image",
  "modalities": ["image", "text"],
  "messages": [
    {
      "role": "user",
      "content": "用户提示词 + 输出尺寸和数量要求"
    }
  ]
}
```

图生图、修复、放大请求核心结构：

```json
{
  "model": "google/gemini-3.1-flash-lite-image",
  "modalities": ["image", "text"],
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "编辑提示词"
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/png;base64,..."
          }
        }
      ]
    }
  ]
}
```

返回图片解析兼容三类位置：

- `choices[].message.images[].image_url.url`
- `choices[].message.content[]`
- 文本中的 `data:image/...;base64,...`

### 6.2 目标墨灵 AI 网关调用方式

目标是把图片模型全部切到墨灵 AI 网关：

```text
AI_GATEWAY_BASE_URL=http://8.130.9.163:8080/v1
AI_GATEWAY_API_KEY=sk-molin-...
```

墨灵 AI 网关需要支持和 OpenRouter 当前相同的多模态 chat 协议：

```text
POST /v1/chat/completions
modalities=["image","text"]
messages.content 支持 text 和 image_url
返回 choices[].message.images[].image_url.url 或 data:image base64
```

当前实测状态：

- `/v1/models` 已返回图片逻辑模型：`image-gen-default`、`image-edit-default`、`vision-text-default`。
- 文本 `chat/completions` 可用。
- 图片模型请求已经能路由到上游，但当前上游返回 `This model is not available in your region.`。
- `/v1/images/generations` 和 `/v1/images/edits` 当前仍返回 404，因此 molinimage 应优先走 `/v1/chat/completions` 多模态协议。

## 7. 模型目录设计

当前 MVP 可以通过 `.env` 的 `IMAGE_MODEL_CATALOG_JSON` 配置模型目录。后续应切换为墨灵 AI 网关目录。

模型目录字段建议：

```json
{
  "gateway_model_code": "image-gen-default",
  "display_name": "通用图片生成",
  "description": "适合日常配图、海报草稿和创意探索。",
  "capability": "image_generation",
  "status": "active",
  "quality_tier": "standard",
  "supported_task_types": ["text_to_image"],
  "supported_image_sizes": ["1024x1024", "1024x1536", "1536x1024"],
  "supported_input_types": ["text"],
  "supported_output_types": ["image"],
  "max_input_files": 0,
  "max_output_count": 4,
  "sort_order": 10
}
```

任务和能力映射：

| 任务类型 | 能力标签 | 说明 |
|---|---|---|
| `text_to_image` | `image_generation` | 文生图 |
| `image_to_image` | `image_edit` | 图生图 |
| `image_restore` | `image_restore` 或 `image_edit` | 图片修复 |
| `upscale` | `upscale` 或 `image_edit` | 高清放大 |
| `image_to_text` | `vision_text` | 图生文 |
| `prompt_optimize` | `prompt_optimize` | 提示词优化 |
| `moderation` | `moderation` | 内容安全 |

第一版至少需要：

```text
image_generation
vision_text
moderation
```

如果第一版继续保留图生图、修复、放大入口，还需要：

```text
image_edit
image_restore 或 upscale
```

## 8. 数据库设计

数据库使用 MySQL，核心表包括：

| 表 | 作用 |
|---|---|
| `image_tasks` | 图片任务、状态、参数、结果、错误 |
| `files` | 上传图、生成图、文本结果等文件元数据 |
| `billing_events` | 预占、结算、释放、待对账事件 |
| `ai_gateway_call_logs` | AI 调用日志、耗时、模型、错误、usage |
| `style_presets` | 风格模板和提示词模板 |
| `user_collections` | 用户收藏作品 |
| `image_model_configs` | 后台模型配置 |
| `pricing_rules` | 后台价格规则 |
| `risk_control_events` | 风控命中记录 |

数据库规则：

- 业务表使用 InnoDB。
- 字符集使用 `utf8mb4`。
- 任务、计费和文件归属字段必须建立索引。
- 计费幂等键必须唯一。
- 不把图片二进制写入 MySQL。

## 9. 文件存储设计

第一阶段使用 MinIO，后期迁移到阿里云 OSS。

对象存储原则：

- bucket 私有。
- 前端不能拿写权限。
- 后端校验用户身份后生成短期预签名 URL。
- 数据库只保存 `storage_provider`、`storage_bucket`、`storage_key`。
- 不在数据库保存完整 MinIO 外链。

推荐对象 key：

```text
uploads/{user_id}/{yyyy}/{mm}/{file_id}.{ext}
generated/{user_id}/{task_id}/{file_id}.{ext}
restored/{user_id}/{task_id}/{file_id}.{ext}
thumbnails/{user_id}/{task_id}/{file_id}.webp
temp/{user_id}/{task_id}/{file_id}.{ext}
```

迁移到阿里云 OSS 时，只需要复制对象并更新 `storage_provider`，业务层继续走统一 Storage Service。

## 10. 计费设计

计费采用“预占 -> 结算 / 释放”模式。

```text
用户提交任务
  -> 后端估算积分
  -> 调墨灵 entitlement reserve
  -> 创建任务并入队
  -> worker 调 AI 网关
  -> 成功：保存结果并 settle
  -> 失败：release
  -> settle/release 失败：进入 billing_pending 或 release_pending
```

关键要求：

- 余额不足时不能调用 AI 网关。
- 同一个任务重试不能重复扣费。
- AI 网关失败、文件存储失败都要释放预占积分。
- 结算失败必须进入对账，不允许静默吞掉。
- 金额和积分不要使用浮点数计算。

当前任务计费示例：

| 任务 | 建议 usage_type | 示例积分 |
|---|---|---|
| 文生图 | `image_text_to_image` | 6 credits |
| 图生图 | `image_to_image` | 8 credits |
| 图片修复 | `image_restore` | 5 credits |
| 图生文 | `image_to_text` | 1 credit |
| 高清放大 2x | `image_upscale` | 4 credits |
| 高清放大 4x | `image_upscale` | 8 credits |

## 11. 墨灵平台接入

平台接入流程：

```text
用户在墨灵点击 molinimage
  -> 墨灵生成 launch ticket
  -> 跳转 /enter?ticket=...
  -> molinimage 后端调用墨灵 verify
  -> 校验 app_id/product_id
  -> 创建应用 session
  -> 前端进入工作台
```

应用侧关键配置：

```env
MOLING_API_BASE_URL=http://8.130.9.163:8080
MOLING_APP_ID=实际 molinimage 应用 ID
MOLING_PRODUCT_ID=实际 molinimage 商品 ID
INTERNAL_API_TOKEN=墨灵内部接口令牌
APP_BASE_URL=http://8.130.9.163:5199
PORT=5199
```

平台后台需要确认：

- 应用 code 为 `molinimage`，不要有前后空格。
- 应用 `access_url` 指向 molinimage 的 `/enter`。
- 商品 `business_ref_id` 指向 molinimage 应用。
- 套餐和价格配置正确。
- 用户已拥有 molinimage 权益或可购买。
- 内部接口 token 和 IP 白名单可用。
- AI 网关图片模型对该 sk 或用户可见。

## 12. 当前开发阶段

按 `docs/ai-image-stage-goals.md`，项目阶段如下：

| 阶段 | 状态 | 说明 |
|---|---|---|
| P0 项目基础阶段 | 基本完成 | 工程、配置、MySQL、MinIO、Redis、构建测试已建立 |
| P1 平台接入阶段 | 进行中 | 墨灵入口、session、模型目录和平台联调仍需持续验证 |
| P2 MVP 创作闭环阶段 | 已具备雏形 | 文生图、图生图、修复、放大、历史、计费流程已有实现，需要稳定 AI 网关 |
| P3 图片编辑与修复阶段 | 部分完成 | 图生图、修复、放大入口已有，模型稳定性和效果仍需验证 |
| P4 运营配置阶段 | 部分完成 | 价格、模型、风格等后台页面已有基础能力 |
| P5 商业增强阶段 | 未开始 | 批量、商品图、品牌模板、团队空间后置 |
| P6 稳定性与上线阶段 | 未完成 | 需要全量回归、安全检查、部署监控、上线验收 |

当前最关键的阻塞点是：墨灵 AI 网关的图片模型需要彻底可用。模型目录已经出现图片模型，但上游图片调用仍返回区域不可用。

## 13. 后续开发规划

### 13.1 短期优先级

1. 修通墨灵 AI 网关图片模型。
2. 将 `.env` 从 OpenRouter 直连切换为墨灵 AI 网关。
3. 将 `IMAGE_MODEL_CATALOG_JSON` 中的模型 code 改为墨灵逻辑模型：
   - `image-gen-default`
   - `image-edit-default`
   - `vision-text-default`
   - `prompt-optimize-default`
   - `moderation-text`
4. 验证文生图、图生图、图片修复、高清放大、图生文五条链路。
5. 跑通一次完整计费闭环：预占、成功结算、失败释放。
6. 修复历史作品、图片预览、下载 URL、再次编辑等用户可见问题。

### 13.2 MVP 验收目标

MVP 至少满足：

- 用户能从墨灵平台进入 molinimage。
- `/api/me` 能返回当前用户和权益信息。
- 用户能上传图片到 MinIO。
- 用户能完成一次文生图并看到历史作品。
- 用户能完成一次图生文并保存文本结果。
- 余额不足时不会调用 AI 网关。
- AI 失败时积分释放。
- 生成结果只能本人查看和下载。
- `.env` 不进入仓库。

### 13.3 第二阶段能力

第二阶段重点增强：

- 图生图模式细分：保持主体、换背景、换风格、生成变体。
- 图片修复模式细分：老照片修复、去噪增强、模糊变清晰、色彩增强。
- 高清放大：2x、4x 不同价格和二次确认。
- 历史作品再次编辑。
- 管理后台模型开关、价格配置、风格模板配置。
- 对账后台可查看和重试异常计费事件。

### 13.4 第三阶段能力

第三阶段偏商业化：

- 批量生成和批量修复。
- 商品图处理。
- 商业海报工作流。
- 品牌模板。
- 团队空间。
- 运营模板市场。
- 成本统计和模型质量评估。

## 14. 测试与验证

代码修改后优先执行：

```bash
cd molin-image-app
npm run build
npm run lint
npm test
```

环境验证：

```bash
curl http://127.0.0.1:5199/api/health
```

AI 网关验证：

```bash
curl http://8.130.9.163:8080/v1/models \
  -H "Authorization: Bearer sk-molin-***"
```

图片模型验证重点：

- `image-gen-default` 是否支持 `modalities=["image","text"]`。
- `image-edit-default` 是否支持 `messages.content[].image_url`。
- `vision-text-default` 是否支持图片输入并返回文本。
- 返回结果是否包含 `message.images` 或 `data:image/...base64`。

## 15. 开发规范

- 新增关键业务逻辑必须写中文注释。
- 计费、权限、幂等、重试、对账、风控、文件归属必须有中文注释说明。
- 敏感配置只放环境变量。
- 不提交 `.env`、真实 token、真实密钥。
- 前端不能直接调用 AI 网关、MinIO、墨灵内部接口。
- 后端错误返回给前端时必须是产品化中文提示，不能暴露上游堆栈和密钥信息。
- 数据库 migration 变更要可重复执行和可回滚。
- 不要为了单个功能破坏现有模块边界。

## 16. 相关文档

- `docs/ai-image-platform-design.md`：平台设计总文档。
- `docs/ai-image-stage-goals.md`：阶段和 Goal 拆分。
- `docs/ai-image-model-preparation.md`：模型准备清单。
- `docs/molinimage-moling-integration-flow.md`：墨灵平台接入流程。
- `docs/ai-image-agent-task-assignment.md`：Agent 分工。
- `molin-image-app/README.md`：工程结构和运行说明。

