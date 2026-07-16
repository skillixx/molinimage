# 墨灵 AI 图片创作应用模型准备清单

## 1. 准备原则

本项目所有模型统一走墨灵 AI 网关协议。图片应用不直接接 OpenAI、Gemini、Stability 或自部署模型，而是通过 AI 网关模型目录选择 `gateway_model_code`。

因此需要准备的是“AI 网关目录里的逻辑模型”，不是在图片应用里保存供应商 API Key。

当前 MVP 阶段允许先通过应用服务端 `.env` 配置 `IMAGE_MODEL_CATALOG_JSON` 作为模型目录来源。该配置只保存逻辑模型 code、能力标签、展示信息和可用状态，不保存供应商密钥。前端仍统一调用 `GET /api/image/models`，后续墨灵 AI 网关提供用户可见模型目录接口后，可在后端把目录来源替换为“AI 网关目录 + env 白名单”，前端接口不变。

模型准备原则：

- 每个模型必须在 AI 网关目录中有稳定的逻辑模型 code。
- 每个模型必须配置能力标签 `capability`。
- 每个模型必须有中文展示名称和简短说明，方便前端展示。
- 每个模型必须标记是否 `active`。
- 每个模型必须声明适用任务类型。
- 用户侧计费仍按图片应用任务计费，AI 网关 usage 只做成本核算和审计。

## 2. MVP 必备模型

MVP 阶段至少准备 4 类模型能力。

| 优先级 | 能力标签 | 用途 | 最少数量 | 是否 MVP 必备 |
|---|---|---|---|---|
| P0 | `image_generation` | 文生图 | 1 个 | 是 |
| P0 | `vision_text` | 图生文 / 图片理解 | 1 个 | 是 |
| P0 | `moderation` | 提示词和图片安全审核 | 1 个 | 是 |
| P1 | `prompt_optimize` | 提示词优化 | 1 个 | 建议 |

MVP 最小可上线组合：

```text
image_generation  1 个
vision_text       1 个
moderation        1 个
```

如果暂时没有 `prompt_optimize`，产品仍可上线，但前端不要展示“一键优化提示词”。

## 3. 完整版推荐模型

完整图片创作应用建议准备以下能力。

| 能力标签 | 功能入口 | 说明 |
|---|---|---|
| `image_generation` | 文生图 | 根据文字生成图片 |
| `image_edit` | 图生图 | 参考图改风格、换背景、生成变体 |
| `image_restore` | 图片修复 | 老照片修复、去噪、清晰化、高清增强 |
| `vision_text` | 图生文 | 图片描述、标题、标签、商品卖点、提示词反推 |
| `prompt_optimize` | 提示词辅助 | 优化用户输入，提高生成质量 |
| `moderation` | 内容安全 | 提示词、上传图和结果图安全检查 |
| `ocr` | 图生文增强 | 图片文字识别，可选 |
| `background_remove` | 商品图处理 | 抠图/去背景，可选 |
| `upscale` | 高清放大 | 2x/4x 放大，可选，也可归入 `image_restore` |

## 4. 按功能准备模型

### 4.1 文生图

必备能力：

```text
image_generation
```

建议准备：

| 逻辑模型定位 | 建议 code | 用途 |
|---|---|---|
| 默认文生图模型 | `image-gen-default` | 普通生成，成本和质量均衡 |
| 高质量文生图模型 | `image-gen-quality` | 商业海报、产品图等高质量场景 |
| 快速文生图模型 | `image-gen-fast` | 草稿、低成本、多次尝试 |

MVP 至少准备：

```text
image-gen-default
```

前端展示建议：

- 默认生成。
- 高质量，可选。
- 快速草稿，可选。

### 4.2 图生图

必备能力：

```text
image_edit
```

建议准备：

| 逻辑模型定位 | 建议 code | 用途 |
|---|---|---|
| 默认图生图模型 | `image-edit-default` | 换风格、换背景、生成变体 |
| 主体保持模型 | `image-edit-consistency` | 产品主体或人物主体保持 |
| 局部编辑模型 | `image-edit-inpaint` | 局部重绘，第二阶段可做 |

MVP 可暂缓，P3 阶段至少准备：

```text
image-edit-default
```

### 4.3 图片修复

必备能力：

```text
image_restore
```

如果 AI 网关暂时没有专用 `image_restore`，可先用 `image_edit` 兜底，但需要在模型目录中标明该模型可用于修复。

建议准备：

| 逻辑模型定位 | 建议 code | 用途 |
|---|---|---|
| 默认修复模型 | `image-restore-default` | 老照片修复、去噪、色彩增强 |
| 高清放大模型 | `image-upscale-default` | 2x/4x 高清放大 |
| 人脸修复模型 | `image-face-restore` | 人像清晰化，可选且需风控 |

P3 阶段至少准备：

```text
image-restore-default
```

如果要单独开放高清放大，建议准备：

```text
image-upscale-default
```

### 4.4 图生文

必备能力：

```text
vision_text
```

建议准备：

| 逻辑模型定位 | 建议 code | 用途 |
|---|---|---|
| 默认图片理解模型 | `vision-text-default` | 图片描述、标题、标签 |
| 商品文案模型 | `vision-copywriting` | 商品卖点、营销文案 |
| 提示词反推模型 | `vision-prompt-reverse` | 根据图片反推提示词 |

MVP 至少准备：

```text
vision-text-default
```

如果不拆多个模型，也可以用一个 `vision-text-default` 通过 prompt 模板区分输出类型。

### 4.5 提示词优化

建议能力：

```text
prompt_optimize
```

建议准备：

```text
prompt-optimize-default
```

用途：

- 把用户短描述改写为更适合文生图的提示词。
- 根据风格模板补充构图、光影、材质、背景等信息。
- 为图生图任务整理更稳定的编辑指令。

如果没有该模型，前端不要展示提示词优化按钮。

### 4.6 内容安全

必备能力：

```text
moderation
```

建议准备：

| 逻辑模型定位 | 建议 code | 用途 |
|---|---|---|
| 文本审核模型 | `moderation-text` | 审核提示词和用户输入 |
| 图片审核模型 | `moderation-image` | 审核上传图和生成图 |

MVP 至少准备：

```text
moderation-text
```

如果上传图片风险较高，MVP 就应同时准备：

```text
moderation-image
```

## 5. AI 网关模型目录字段建议

每个图片模型在 AI 网关目录中建议至少有以下字段：

```text
gateway_model_code       逻辑模型 code
display_name             前端展示名
description              模型说明
capability               能力标签
status                   active / inactive
quality_tier             fast / standard / quality
supported_task_types     支持的任务类型
supported_image_sizes    支持的尺寸
supported_input_types    text / image / multi_image
supported_output_types   image / text
max_input_files          最大输入图片数
max_output_count         最大输出数量
sort_order               排序
visible_scope            可见范围
```

示例：

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
  "sort_order": 10,
  "visible_scope": "all"
}
```

## 6. 前端展示规则

前端通过 `GET /api/image/models` 获取后端过滤后的模型列表。

前端不直接展示供应商名，建议展示：

- 模型展示名。
- 适用场景。
- 质量档位。
- 是否默认。
- 是否高消耗。

示例：

```text
通用图片生成
适合日常配图和创意探索
标准质量
```

如果模型不可用：

- 不在下拉中展示 inactive 模型。
- 当前选择模型被关闭时，自动切回默认模型。
- 没有可用模型时，显示“当前暂无可用图片模型，请稍后再试”。

## 7. 计费准备

模型准备必须和价格规则一起准备。

建议按以下维度配置价格：

| 任务 | 计费维度 |
|---|---|
| 文生图 | `gateway_model_code`、质量、尺寸、数量 |
| 图生图 | `gateway_model_code`、输入图数量、输出数量、尺寸 |
| 图片修复 | 修复类型、倍率、模型 |
| 图生文 | 输出类型、模型、输出长度 |

注意：

- 用户侧只按图片任务扣费。
- AI 网关 usage 不直接二次扣用户钱包。
- `ai_gateway_call_logs.request_id` 要和 `image_tasks.id`、`billing_events.id` 能关联。

## 8. 分阶段准备清单

### 8.1 MVP 阶段

必须准备：

- `image-gen-default`
- `vision-text-default`
- `moderation-text`

建议准备：

- `moderation-image`
- `prompt-optimize-default`

### 8.2 图生图与修复阶段

必须准备：

- `image-edit-default`
- `image-restore-default`

建议准备：

- `image-upscale-default`
- `image-edit-consistency`

### 8.3 运营配置阶段

必须准备：

- 模型开关。
- 默认模型配置。
- 能力标签配置。
- 价格规则配置。

### 8.4 商业增强阶段

建议准备：

- `vision-copywriting`
- `image-upscale-default`
- `background-remove-default`
- `image-gen-quality`
- `image-edit-consistency`

## 9. 验收清单

- AI 网关目录中存在 MVP 必备模型。
- 每个模型有唯一 `gateway_model_code`。
- 每个模型有明确 `capability`。
- `GET /api/image/models` 只返回当前用户可见模型。
- 文生图任务能匹配到 `image_generation` 模型。
- 图生文任务能匹配到 `vision_text` 模型。
- 内容安全检查能匹配到 `moderation` 模型或本地审核策略。
- 模型关闭后前端不可选。
- 余额不足时不调用 AI 网关。
- AI 网关调用失败后任务失败且释放预占积分。

## 10. 最小结论

第一版最少需要准备 3 个模型能力：

```text
1. 文生图模型：image_generation
2. 图生文模型：vision_text
3. 内容安全模型：moderation
```

如果要在第一版同时做图生图和图片修复，则还需要：

```text
4. 图生图模型：image_edit
5. 图片修复模型：image_restore
```

如果要体验更好，建议再准备：

```text
6. 提示词优化模型：prompt_optimize
7. 高清放大模型：upscale 或 image_restore
```

## 11. 当前 MVP 环境变量配置

当前实现支持用 `.env` 配置模型目录：

```text
IMAGE_MODEL_ENABLED_CAPABILITIES=image_generation,vision_text,moderation,image_edit,image_restore,upscale,prompt_optimize
IMAGE_MODEL_REQUIRED_CAPABILITIES=image_generation,vision_text,moderation
IMAGE_MODEL_CATALOG_JSON=[...]
```

`IMAGE_MODEL_CATALOG_JSON` 是 JSON 数组，每个模型项字段与本文第 5 节建议字段保持一致。后端会过滤：

- `status !== active` 的模型。
- `capability` 不在 `IMAGE_MODEL_ENABLED_CAPABILITIES` 中的模型。

`GET /api/image/models` 会返回：

- `items`：当前可展示模型。
- `required_capabilities`：MVP 必备能力。
- `missing_required_capabilities`：缺失的必备能力。
- `message`：中文提示；模型为空或必备能力缺失时用于前端展示。
- `source`：当前为 `env`。
