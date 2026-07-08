# 墨灵 AI 图片创作应用平台设计文档

## 1. 项目定位

本项目是接入墨灵平台的 AI 图片创作应用，面向墨灵用户提供文生图、图生图、图片修复、图生文等能力，并通过墨灵平台的身份、权益和计费体系完成用户访问控制与按量扣费。

应用不是简单的模型 API 转发器，而是一个完整的图片任务平台。平台需要统一处理用户身份、文件上传、任务排队、模型调用、内容安全、结果存储、作品历史、计费预占、结算、失败释放和异常对账。

## 2. 建设目标

- 用户可以从墨灵平台入口进入应用，无需单独注册登录。
- 用户可以使用文字生成图片。
- 用户可以上传参考图并根据提示词生成新图片。
- 用户可以对图片进行修复、增强、高清放大、局部重绘等操作。
- 用户可以上传图片生成描述、标题、标签、商品文案或提示词反推结果。
- 所有生成结果可保存到作品历史，并支持预览、下载和再次编辑。
- 每次生成或分析任务都能按配置规则消耗墨灵积分。
- 模型统一走墨灵 AI 网关协议，应用只选择模型目录中的逻辑模型，不直连任何上游模型供应商。
- 任务失败时不多扣费，结算异常时可进入后台对账流程。

## 3. 功能范围

### 3.1 文生图

用户输入提示词后生成图片。

核心能力：

- 正向提示词。
- 反向提示词，可选。
- 图片比例：1:1、4:3、3:4、16:9、9:16。
- 图片数量。
- 质量档位：普通、高清、超清。
- 风格模板：写实、插画、国风、二次元、产品海报、商业摄影等。
- 结果下载、再次编辑、作为参考图继续创作。

### 3.2 图生图

用户上传一张或多张参考图，再输入修改要求，生成新图片。

核心能力：

- 保持主体一致，改变背景或风格。
- 上传产品图生成营销海报。
- 上传人物图生成不同风格头像或场景图。
- 多图参考，例如主体图 + 风格图。
- 生成变体。

### 3.3 图片修复

图片修复属于图生图的垂直场景，但产品上建议单独作为一级入口，降低用户理解成本。

核心能力：

- 老照片修复。
- 图片去噪。
- 模糊图片清晰化。
- 高清放大。
- 色彩增强。
- 局部瑕疵修复。
- 背景补全。

需要谨慎处理：

- 去水印、去遮挡、恢复被刻意遮盖的信息等能力可能涉及版权、隐私或滥用风险，第一阶段建议不开放或仅做严格审核后的有限能力。

### 3.4 图生文

用户上传图片后生成文本内容。

核心能力：

- 图片内容描述。
- 图片标题。
- 商品卖点文案。
- 社媒发布文案。
- SEO 标签。
- 图片分类标签。
- 提示词反推。
- OCR 文本提取，可选。

## 4. 用户流程

### 4.1 墨灵入口流程

```text
用户在墨灵平台点击应用
  -> 墨灵平台携带 ticket 跳转到应用 access_url
  -> 应用后端校验 ticket
  -> 创建应用 session
  -> 获取用户身份、权益和可用余额
  -> 进入 AI 图片创作工作台
```

### 4.2 图片生成流程

```text
用户提交生成任务
  -> 后端校验 session
  -> 校验参数和上传文件归属
  -> 内容安全检查
  -> 计算预计消耗积分
  -> 调用墨灵计费接口预占积分
  -> 创建图片任务
  -> 投递到任务队列
  -> worker 按 AI 网关协议调用目录模型
  -> 生成结果写入对象存储
  -> 写入作品历史
  -> 调用墨灵计费接口结算积分
  -> 前端展示结果
```

### 4.3 失败与退款流程

```text
AI 网关调用失败或结果存储失败
  -> 标记任务失败
  -> 调用墨灵计费接口释放预占积分
  -> 记录失败原因和 AI 网关调用日志
  -> 用户可重新发起任务
```

### 4.4 结算异常流程

```text
图片已生成但计费结算失败
  -> 任务进入 billing_pending 状态
  -> 结果暂时限制下载或再次编辑
  -> 创建待对账记录
  -> 后台对账任务重试结算
  -> 结算成功后恢复作品可用状态
```

## 5. 系统架构

### 5.1 架构原则

- 前端不直接调用 AI 网关或任何上游模型供应商 API。
- 前端不接触墨灵内部 Token、AI 网关密钥、模型供应商密钥、对象存储写凭证。
- 所有写操作都必须经过应用后端鉴权。
- 生成、修复和分析任务统一抽象为图片任务。
- 计费先预占，成功后结算，失败后释放。
- worker 必须通过数据库读取完整任务状态，不信任队列消息作为唯一事实来源。
- 模型能力统一通过墨灵 AI 网关协议接入，图片应用不维护 OpenAI、Gemini、Stability 等直连适配器。

### 5.2 服务组成

```text
Web 前端
  -> 应用 API 服务
    -> Auth 模块
    -> Image Task 模块
    -> File 模块
    -> Billing 模块
    -> AI Gateway Client 模块
    -> Moderation 模块
  -> Redis 队列
  -> Worker 服务
    -> Molin AI Gateway
  -> MySQL
  -> MinIO 对象存储，后期可迁移到阿里云 OSS
  -> 日志、指标和对账任务
```

### 5.3 建议目录

```text
molin-image-app/
  src/
    app/
      server.ts
      routes.ts
      middleware/
    config/
    modules/
      auth/
      image_tasks/
      files/
      billing/
      ai_gateway/
      moderation/
      history/
      templates/
      observability/
    infrastructure/
      moling/
      storage/
      database/
      queue/
      ai_gateway/
    workers/
    scripts/
  test/
  migrations/
  docs/
  docker-compose.yml
  package.json
```

## 6. 模块设计

### 6.1 Auth 模块

职责：

- 接收墨灵平台 ticket。
- 调用墨灵平台接口校验 ticket。
- 创建应用 session。
- 维护当前用户信息。
- 查询用户权益和余额。

关键约束：

- ticket 只能使用一次。
- session 需要设置有效期。
- 后端日志不得打印 ticket、session token、内部访问令牌。

### 6.2 Image Task 模块

职责：

- 创建图片任务。
- 管理任务状态。
- 记录任务输入、输出、模型、消耗和错误。
- 支持任务查询、取消、重试。

任务类型：

```text
text_to_image      文生图
image_to_image     图生图
image_restore      图片修复
image_to_text      图生文
```

任务状态：

```text
pending            已创建，等待处理
billing_reserved   已预占积分
queued             已入队
running            模型处理中
succeeded          已成功
failed             已失败
billing_pending    结果成功但计费待对账
cancelled          已取消
```

### 6.3 File 模块

职责：

- 上传用户原始图片。
- 存储生成图片。
- 生成缩略图。
- 提供下载 URL。
- 校验文件归属。

文件类型：

```text
input_image        用户上传输入图
generated_image    模型生成图
restored_image     修复后图片
thumbnail          缩略图
text_result        图生文结果，可选
```

关键约束：

- 文件必须绑定 owner_user_id。
- 下载 URL 应短期有效。
- 上传文件需要限制 MIME、大小、分辨率和数量。
- 不允许用户读取他人的文件。
- 第一阶段文件存储使用 MinIO，应用层通过 S3 兼容客户端访问，避免业务代码直接绑定 MinIO 私有能力，方便后期迁移到阿里云 OSS。
- 数据库只保存 `storage_provider`、`storage_bucket`、`storage_key`、文件元数据和归属关系，不保存对象存储的临时签名 URL。
- 下载、预览和跨服务读取文件时，由后端按需生成短期有效的预签名 URL。

### 6.4 Billing 模块

职责：

- 根据任务类型和参数计算预计积分。
- 调用墨灵计费接口预占积分。
- 任务成功后结算积分。
- 任务失败后释放积分。
- 记录计费事件。
- 提供对账重试。

计费事件状态：

```text
reserved
settled
released
settle_pending
release_pending
failed
```

关键约束：

- 每个任务必须有唯一 idempotency_key。
- 重复提交、重复入队、worker 重启不得重复扣费。
- 计费异常必须可追踪、可对账、可人工处理。

### 6.5 AI Gateway Client 模块

职责：

- 按墨灵 AI 网关协议调用目录中已上架的逻辑模型。
- 查询或缓存模型目录，识别模型支持的能力、可见范围、状态和价格配置锚点。
- 为图片业务提供统一的文生图、图生图、图片修复、图生文调用方法。
- 记录 AI 网关请求 ID、逻辑模型、能力类型、耗时、错误码和用量信息。
- 屏蔽网关协议细节，避免 Image Task 模块直接拼接网关请求。

建议接口：

```text
listGatewayModels(params)
generateImageViaGateway(params)
editImageViaGateway(params)
restoreImageViaGateway(params)
describeImageViaGateway(params)
```

第一阶段默认模型已经在墨灵 AI 网关侧接好，图片应用不再单独接入 OpenAI、Gemini、Stability 或自部署模型。后续新增模型时，只需要在 AI 网关模型目录中上架并配置能力标签，图片应用按目录读取即可。

### 6.6 Moderation 模块

职责：

- 检查用户提示词。
- 检查上传图片。
- 检查生成结果，可选。
- 拦截违规任务。

重点风险：

- 色情、暴力、违法内容。
- 人脸和身份滥用。
- 未授权商标、版权图片。
- 去水印、去遮挡、伪造证件等高风险请求。

### 6.7 History 模块

职责：

- 管理用户作品历史。
- 支持按任务类型筛选。
- 支持收藏、删除、下载、再次编辑。
- 保留生成参数，方便复用提示词和模型设置。

## 7. AI 网关与模型目录设计

### 7.1 接入原则

本应用的所有模型能力统一走墨灵 AI 网关协议。图片应用不保存上游模型供应商密钥，不维护上游渠道，不实现多供应商故障切换；这些能力由墨灵 AI 网关和模型目录统一管理。

权威契约参考：

- `molin_docs/backend-token-gateway-design.md`
- `molin_docs/backend-token-gateway-integration.md`
- `molin_docs/token-gateway-openai-compat.md`
- `molin_docs/backend-token-billing-contract.md`

图片应用只关心：

- 当前用户可见的逻辑模型。
- 逻辑模型支持的能力类型。
- 任务类型与逻辑模型的映射关系。
- 网关调用结果、用量、错误码和 request_id。
- 业务侧计费预估和墨灵积分结算。

AI 网关负责：

- 上游渠道和真实模型管理。
- 模型目录、模型状态、可见范围。
- 上游密钥加密保存。
- 按协议转发模型请求。
- 返回统一响应、错误和用量信息。

计费边界：

- 用户侧收费以图片应用的任务计费为准，即文生图、图生图、图片修复、图生文按任务规则扣墨灵积分。
- AI 网关返回的 `usage` 用于成本核算、审计和定价参考，不应在同一次图片任务中再次直接扣用户钱包，避免应用计费和网关计费双扣。
- 如果平台要求 AI 网关也落模型用量流水，应标记为内部成本或应用归集成本，由图片应用的 `billing_event_id` 与网关 `request_id` 做关联。

### 7.2 模型能力映射

模型目录需要为图片应用暴露可识别的能力标签。建议使用以下能力值：

```text
image_generation      文生图
image_edit            图生图 / 局部编辑
image_restore         图片修复 / 高清增强
vision_text           图生文 / 图片理解
prompt_optimize       提示词优化
moderation            内容安全审核
```

图片任务和模型能力的对应关系：

| 任务类型 | 需要的网关能力 | 说明 |
|---|---|---|
| `text_to_image` | `image_generation` | 输入提示词，输出图片 |
| `image_to_image` | `image_edit` | 输入参考图和提示词，输出新图片 |
| `image_restore` | `image_restore` 或 `image_edit` | 优先使用专用修复模型，没有时可降级到图片编辑模型 |
| `image_to_text` | `vision_text` | 输入图片，输出描述、标题、标签或文案 |
| 提示词优化 | `prompt_optimize` | 可选，用于优化用户输入 |
| 内容安全 | `moderation` | 可选，结合本地规则做风控 |

### 7.3 逻辑模型选择

应用内不出现 OpenAI、Gemini、Stability 等供应商概念，只展示模型目录返回的业务名称和能力说明。

选择流程：

```text
任务类型 + 用户选择质量 + 风格模板 + 当前用户可见模型
  -> 查询 AI 网关模型目录
  -> 筛选 capability 匹配且 status=active 的逻辑模型
  -> 选择默认模型或用户指定模型
  -> 通过 AI Gateway Client 调用
  -> 记录 ai_gateway_call_logs
```

示例：

- 普通文生图选择 `image_generation` 能力下的默认模型。
- 商业海报选择支持高质量输出的 `image_generation` 模型。
- 图片修复优先选择 `image_restore` 模型，缺失时按配置降级到 `image_edit`。
- 图生文选择 `vision_text` 模型。

### 7.4 网关协议约束

图片应用调用 AI 网关时必须遵守：

- 每次请求携带应用侧生成的 `request_id`，方便日志、计费和问题排查串联。
- 请求中只传业务所需参数，不传上游供应商密钥。
- 输入图片只传受控文件引用或后端生成的短期可访问 URL，不把永久对象存储地址暴露给网关外部。
- 网关返回的 `usage`、`request_id`、`model`、`error_code` 必须落库。
- 网关调用失败时，应用只返回产品化中文错误，不透出上游原始堆栈或供应商密钥相关信息。

### 7.5 已接入状态

当前模型已通过墨灵 AI 网关目录接好。图片应用第一阶段不需要再单独接 OpenAI、Gemini、Stability 或自部署模型 SDK，开发重点放在任务系统、文件系统、计费闭环、历史作品和前端体验上。

## 8. 计费设计

### 8.1 计费维度

| 功能 | 计费维度 |
|---|---|
| 文生图 | 网关逻辑模型、尺寸、质量、图片数量 |
| 图生图 | 网关逻辑模型、输入图数量、输出图数量、尺寸 |
| 图片修复 | 修复类型、图片尺寸、高清倍率 |
| 图生文 | 图片数量、输出长度、网关逻辑模型档位 |
| 高清放大 | 放大倍率、目标分辨率 |

计费执行规则：

- 图片应用先按任务参数预估积分并调用墨灵计费接口预占。
- worker 调用 AI 网关后，按任务成功或失败执行结算或释放。
- AI 网关返回的用量只作为成本核算和后续调价依据，不在图片任务内对用户二次扣费。
- `billing_events.id`、`image_tasks.id`、`ai_gateway_call_logs.request_id` 必须能互相关联，方便排查成本和用户扣费差异。

### 8.2 示例价格配置

实际价格必须后台可配置，以下仅为产品设计示例：

```text
普通文生图：2 积分 / 张
高清文生图：5 积分 / 张
图生图：4 积分 / 张
图片修复：3 积分 / 张
高清放大：6 积分 / 张
图生文：1 积分 / 次
```

### 8.3 计费配置表示例

```text
pricing_rules
- id
- task_type
- gateway_model_code
- gateway_capability
- quality
- image_size
- unit_points
- enabled
- created_at
- updated_at
```

## 9. 数据库设计草案

本项目数据库选型为 MySQL。MySQL 负责保存任务、文件元数据、计费事件、模型调用日志、风格模板和作品收藏等结构化数据；图片原始文件和生成结果不直接写入 MySQL，而是保存到对象存储，数据库只保存 `storage_key`、文件大小、宽高、归属用户等元数据。

推荐配置：

- MySQL 8.0+。
- 字符集使用 `utf8mb4`。
- 排序规则优先使用 `utf8mb4_0900_ai_ci`，如运行环境不支持则使用 `utf8mb4_unicode_ci`。
- 所有业务表使用 InnoDB。
- 时间字段统一使用 `datetime(3)` 或 `timestamp(3)`，由应用层统一处理时区。
- JSON 类字段可使用 MySQL `json` 类型；如需兼容旧版本 MySQL，可降级为 `longtext` 并在应用层校验 JSON。
- 高并发计费、任务状态更新和权益消耗必须使用事务，并配合唯一索引保证幂等。

### 9.1 image_tasks

```text
- id
- owner_user_id
- task_type
- status
- prompt
- negative_prompt
- style_preset_id
- input_file_ids
- output_file_ids
- text_result
- gateway_model_code
- gateway_capability
- gateway_request_id
- quality
- image_size
- image_count
- cost_points
- billing_event_id
- idempotency_key
- error_code
- error_message
- created_at
- updated_at
```

建议索引：

```text
PRIMARY KEY (id)
UNIQUE KEY uk_image_tasks_idempotency_key (idempotency_key)
KEY idx_image_tasks_owner_status_created (owner_user_id, status, created_at)
KEY idx_image_tasks_task_type_created (task_type, created_at)
KEY idx_image_tasks_billing_event_id (billing_event_id)
```

### 9.2 files

```text
- id
- owner_user_id
- file_type
- original_name
- mime_type
- storage_provider
- storage_bucket
- storage_key
- size_bytes
- width
- height
- checksum
- created_at
```

建议索引：

```text
PRIMARY KEY (id)
KEY idx_files_owner_created (owner_user_id, created_at)
KEY idx_files_storage_key (storage_key)
KEY idx_files_checksum (checksum)
```

`storage_provider` 第一阶段默认值为 `minio`，迁移到阿里云 OSS 后可写入 `aliyun_oss`。历史文件迁移期间允许同一张表同时存在不同 provider 的文件记录，应用层根据 `storage_provider` 选择对应存储客户端。

### 9.3 billing_events

```text
- id
- owner_user_id
- task_id
- amount_points
- status
- idempotency_key
- moling_reserve_id
- error_code
- retry_count
- created_at
- updated_at
```

建议索引：

```text
PRIMARY KEY (id)
UNIQUE KEY uk_billing_events_idempotency_key (idempotency_key)
KEY idx_billing_events_task_id (task_id)
KEY idx_billing_events_owner_status_created (owner_user_id, status, created_at)
KEY idx_billing_events_status_retry (status, retry_count, updated_at)
```

### 9.4 ai_gateway_call_logs

```text
- id
- task_id
- request_id
- gateway_model_code
- gateway_capability
- operation
- latency_ms
- success
- usage_json
- input_summary
- output_summary
- error_code
- error_message
- created_at
```

建议索引：

```text
PRIMARY KEY (id)
UNIQUE KEY uk_ai_gateway_call_logs_request_id (request_id)
KEY idx_ai_gateway_call_logs_task_id (task_id)
KEY idx_ai_gateway_call_logs_model_created (gateway_model_code, created_at)
KEY idx_ai_gateway_call_logs_success_created (success, created_at)
```

### 9.5 style_presets

```text
- id
- name
- task_type
- prompt_template
- preview_image_file_id
- enabled
- sort_order
- created_at
- updated_at
```

建议索引：

```text
PRIMARY KEY (id)
KEY idx_style_presets_task_enabled_sort (task_type, enabled, sort_order)
```

### 9.6 user_collections

```text
- id
- owner_user_id
- task_id
- file_id
- title
- tags
- created_at
```

建议索引：

```text
PRIMARY KEY (id)
UNIQUE KEY uk_user_collections_owner_task_file (owner_user_id, task_id, file_id)
KEY idx_user_collections_owner_created (owner_user_id, created_at)
```

## 10. 对象存储设计

### 10.1 存储选型

第一阶段使用 MinIO 作为文件存储，原因是部署简单、开发环境可本地运行、协议兼容 S3，后期迁移到阿里云 OSS 时可以复用大部分对象存储抽象。

设计原则：

- 业务代码只依赖统一的 Storage Service，不直接调用 MinIO SDK 的私有能力。
- Storage Service 对外只暴露上传、下载、删除、复制、生成预签名 URL、读取对象元数据等通用能力。
- 对象 key 由应用生成，不使用供应商自动生成路径。
- 数据库保存稳定的 `storage_provider`、`storage_bucket` 和 `storage_key`，不保存完整外链。
- 所有 bucket 默认私有，用户访问文件必须通过后端鉴权后生成短期预签名 URL。

### 10.2 Bucket 规划

MVP 阶段建议先使用一个 bucket：

```text
molin-image
```

通过 key 前缀区分文件用途，减少运维复杂度。后期如果文件量变大或需要独立生命周期策略，可以拆分为：

```text
molin-image-input       用户上传原图
molin-image-output      生成图和修复图
molin-image-thumbnail   缩略图
molin-image-temp        临时文件
```

### 10.3 对象 Key 规则

```text
uploads/{user_id}/{yyyy}/{mm}/{file_id}.{ext}
generated/{user_id}/{task_id}/{file_id}.{ext}
restored/{user_id}/{task_id}/{file_id}.{ext}
thumbnails/{user_id}/{task_id}/{file_id}.webp
temp/{user_id}/{task_id}/{file_id}.{ext}
```

示例：

```text
uploads/u_123/2026/07/file_001.png
generated/u_123/task_888/file_002.png
thumbnails/u_123/task_888/file_002.webp
```

### 10.4 文件访问规则

- 上传文件时，后端先校验用户 session、文件类型、大小和分辨率。
- 文件上传成功后，后端写入 `files` 表。
- 用户下载或预览文件时，后端先校验 `owner_user_id`，再生成短期预签名 URL。
- 预签名 URL 建议有效期为 5 到 15 分钟。
- 删除作品时，优先软删除数据库记录；对象文件可由后台清理任务异步删除。

### 10.5 迁移到阿里云 OSS 的要求

为了后期从 MinIO 迁移到阿里云 OSS，第一阶段必须遵守：

- 不在业务表中保存 MinIO endpoint 拼出来的完整 URL。
- 不依赖 MinIO 独有策略、通知、对象锁等能力作为核心业务流程。
- `storage_provider`、`storage_bucket`、`storage_key` 三者分开保存。
- 对外访问统一走后端签名接口，不把对象存储地址固化到前端。
- 迁移时可按 `storage_key` 批量复制对象，并将 `storage_provider` 从 `minio` 更新为 `aliyun_oss`。
- 如果迁移期间需要双写，Storage Service 应支持新文件写 OSS、旧文件继续读 MinIO。

### 10.6 MinIO 开发环境

Docker Compose 中建议包含 MinIO 服务：

```text
minio:
  image: minio/minio
  command: server /data --console-address ":9001"
  ports:
    - "9000:9000"
    - "9001:9001"
  environment:
    MINIO_ROOT_USER: minioadmin
    MINIO_ROOT_PASSWORD: minioadmin
```

本地默认配置示例：

```text
STORAGE_PROVIDER=minio
STORAGE_ENDPOINT=http://127.0.0.1:9000
STORAGE_BUCKET=molin-image
STORAGE_ACCESS_KEY=minioadmin
STORAGE_SECRET_KEY=minioadmin
STORAGE_FORCE_PATH_STYLE=true
```

## 11. API 设计草案

### 11.1 会话

```text
GET /?ticket=...
GET /enter?ticket=...
GET /api/me
```

### 11.2 文件

```text
POST /api/files
GET /api/files/{file_id}
GET /api/files/{file_id}/download-url
DELETE /api/files/{file_id}
```

### 11.3 图片任务

```text
GET /api/image/models
POST /api/image/tasks
GET /api/image/tasks
GET /api/image/tasks/{task_id}
POST /api/image/tasks/{task_id}/retry
POST /api/image/tasks/{task_id}/cancel
```

`GET /api/image/models` 返回当前用户可见、适用于图片应用的 AI 网关模型目录子集。前端用它渲染模型下拉、能力说明和默认模型；前端不得直接调用 AI 网关模型目录接口。

创建任务请求示例：

```json
{
  "task_type": "text_to_image",
  "prompt": "一张高级感的 AI 图片创作平台宣传海报",
  "gateway_model_code": "image-default",
  "style_preset_id": "poster_modern",
  "image_size": "1024x1024",
  "quality": "standard",
  "image_count": 1,
  "input_file_ids": []
}
```

字段说明：

- `gateway_model_code` 来自 AI 网关模型目录；前端只允许提交当前用户可见且能力匹配的逻辑模型。
- 如果前端不传 `gateway_model_code`，后端按任务类型、质量档位和模型目录配置选择默认模型。
- 后端创建任务前必须再次校验该模型是否存在、是否 active、是否对当前用户可见、是否支持当前 `task_type` 对应能力。

### 11.4 作品历史

```text
GET /api/image/history
POST /api/image/history/{task_id}/favorite
DELETE /api/image/history/{task_id}
```

### 11.5 价格与余额

```text
GET /api/billing/balance
POST /api/billing/estimate
```

### 11.6 后台对账

```text
POST /internal/reconcile
```

## 12. 前端设计

### 12.1 页面结构

```text
AI 图片工作台
  - 文生图
  - 图生图
  - 图片修复
  - 图生文
我的作品
  - 全部
  - 文生图
  - 图生图
  - 图片修复
  - 图生文
任务详情
余额与消耗记录
```

### 12.2 工作台布局

```text
左侧：功能选择和历史入口
中间：上传区、提示词、参数配置、预计消耗
右侧或下方：生成进度、结果预览、下载和再次编辑
```

### 12.3 前端交互要求

- 提交任务前展示预计积分消耗。
- 余额不足时阻止提交并引导充值或购买套餐。
- 上传图片时展示大小、格式、分辨率限制。
- 生成中展示进度和状态。
- 失败时展示可理解的中文错误提示。
- 任务成功后支持下载、复制文本、再次编辑和收藏。
- 对图片修复、高清放大等高消耗任务增加二次确认。

## 13. 内容安全与合规

必须拦截或限制：

- 违法、暴力、色情、仇恨等内容。
- 生成或编辑证件、票据、印章等高风险内容。
- 未授权去水印、去版权标记。
- 恶意换脸、冒充真实人物。
- 识别、恢复或推断敏感个人信息。

建议策略：

- 提示词审核。
- 上传图片审核。
- 结果抽检或全量审核。
- 用户级限流和风控记录。
- 高风险能力默认关闭，通过后台配置逐步开放。

## 14. 运维与环境

### 14.1 基础环境

- Node.js 20+ 或 22+。
- TypeScript。
- MySQL 8.0+。
- Redis。
- MinIO 对象存储，应用层按 S3 兼容协议访问，后期迁移到阿里云 OSS。
- Docker Compose。

### 14.2 推荐依赖

- Web 框架：Fastify 或 Express。
- 队列：BullMQ。
- 数据库 ORM：Prisma 或 Drizzle，二者都需要按 MySQL 方言建模和生成 migration。
- 对象存储客户端：优先使用 S3 兼容客户端，并通过 Storage Service 封装，避免业务层直接依赖具体供应商。
- 日志：pino。
- 测试：Vitest 或 Jest。
- 前端验收：Playwright。
- AI 网关客户端：优先使用平台提供的 AI 网关协议 SDK；如暂无 SDK，则用统一 HTTP Client 封装。

### 14.3 配置项

```text
APP_BASE_URL
DATABASE_URL               # 示例：mysql://user:password@127.0.0.1:3306/molin_image
REDIS_URL
STORAGE_PROVIDER           # minio / aliyun_oss
STORAGE_ENDPOINT
STORAGE_BUCKET
STORAGE_ACCESS_KEY
STORAGE_SECRET_KEY
STORAGE_FORCE_PATH_STYLE   # MinIO 本地环境通常为 true，阿里云 OSS 按实际客户端配置
MOLING_API_BASE_URL
MOLING_APP_ID
MOLING_APP_SECRET
AI_GATEWAY_BASE_URL
AI_GATEWAY_API_KEY         # 应用调用 AI 网关的内部凭证，不是上游模型供应商 key
AI_GATEWAY_TIMEOUT_MS
INTERNAL_API_TOKEN
```

真实密钥只能通过环境变量或密钥管理系统注入，不得提交到代码仓库。

## 15. 测试计划

### 15.1 单元测试

- 价格计算。
- 任务状态机。
- 文件归属校验。
- 幂等键生成。
- AI 网关模型能力映射。

### 15.2 集成测试

- 墨灵 ticket 登录。
- 图片模型目录读取和能力过滤。
- 文件上传和下载。
- 文生图任务创建。
- 图生图任务创建。
- 图片修复任务创建。
- 图生文任务创建。
- 计费预占、结算、释放。
- 失败重试。
- 对账重试。

### 15.3 验收测试

- 用户能从墨灵平台进入应用。
- 用户只能看到 AI 网关目录中对自己可见的图片模型。
- 余额充足时可以生成图片。
- 余额不足时不能调用 AI 网关。
- 任务失败不会扣费。
- 生成成功后作品进入历史。
- 用户不能访问他人的图片和任务。
- 结算失败时任务进入待对账状态。

## 16. 分阶段实施计划

### 16.1 第一阶段：MVP

- 墨灵入口和 session。
- 文件上传和 MinIO 对象存储。
- 文生图。
- 图生文。
- 基础计费预占、结算、释放。
- 图片任务表和作品历史。
- 基础内容安全。
- 任务失败重试。

### 16.2 第二阶段：图生图与修复

- 图生图。
- 图片修复。
- 高清放大。
- 风格模板。
- 多图参考。
- 下载和再次编辑。

### 16.3 第三阶段：平台化能力

- AI 网关模型目录同步与能力配置。
- 后台价格配置。
- 后台模型开关。
- 对账管理。
- 用户限流。
- 批量任务。
- 运营模板市场。

### 16.4 第四阶段：高级能力

- 自部署模型。
- 商业海报生成工作流。
- 商品图批量处理。
- 企业品牌风格模板。
- 团队空间和共享作品库。

## 17. 待确认问题

- 墨灵平台当前可用的计费接口是否支持预占、结算、释放和对账。
- 图片修复是否开放去水印、去遮挡等高风险能力。
- 用户上传图片的最大大小和最大分辨率。
- 生成结果保存周期。
- 是否需要管理后台配置价格、模型和风格模板。
- 是否需要对免费用户、会员用户、企业用户设置不同价格和限额。
- 阿里云 OSS 迁移是在正式上线前完成，还是上线后按存量文件迁移方案逐步切换。
- AI 网关模型目录是否已经为图片类模型补齐 `image_generation`、`image_edit`、`image_restore`、`vision_text` 等能力标签。
