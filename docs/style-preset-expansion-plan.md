# molinimage 风格模板扩充执行规划

## 1. 文档目标

本文档用于指导 molinimage 后续按步骤扩充风格模板。它不是概念说明，而是可依次执行的开发计划。后续实现时，可以按本文的阶段、任务编号、交付物、验证命令和验收标准逐项推进。

本次扩充的核心目标：

- 将默认风格模板从 11 个扩充到约 40 个。
- 覆盖文生图、图生图、图片修复三个入口。
- 让用户不用从空白提示词开始，也能快速选择合适的创作方向。
- 保持模板数据可运营、可回滚、可测试。
- 不引入高风险模板，例如去水印、证件伪造、恶意换脸、恢复遮挡隐私等。

## 2. 当前状态

### 2.1 当前数据来源

默认模板目前由 migration 初始化：

```text
molin-image-app/migrations/010_enhance_style_presets.up.sql
```

用户端读取接口：

```text
GET /api/image/style-presets?task_type=text_to_image
GET /api/image/style-presets?task_type=image_to_image
GET /api/image/style-presets?task_type=image_restore
```

管理端入口：

```text
/admin/styles
```

### 2.2 当前已有模板

| 任务类型 | 当前数量 | 当前模板 |
|---|---:|---|
| `text_to_image` | 3 | 商品海报、人物大片、扁平插画 |
| `image_to_image` | 4 | 保持主体、换背景、换风格、生成变体 |
| `image_restore` | 4 | 老照片修复、去噪增强、模糊变清晰、色彩增强 |
| 合计 | 11 | - |

### 2.3 当前问题

- 文生图模板太少，用户很难快速进入“社媒、电商、国风、二次元、3D、写实摄影”等常用场景。
- 图生图模板偏基础功能，缺少人像、商品、光影、季节、场景变化等细分操作。
- 图片修复模板覆盖基础修复，但缺少人像增强、暗光增强、低清晰度增强、背景补全、细节增强等常见需求。
- 模板量少会让页面看起来像 demo，不像正式创作工具。

## 3. 执行总览

建议分 6 个阶段执行。

| 阶段 | 名称 | 目标 | 是否必须 |
|---|---|---|---|
| S1 | 模板清单确认 | 确认第一批新增模板 ID、名称、分类、任务类型、prompt | 必须 |
| S2 | Seed migration | 新增模板初始化 SQL 和回滚 SQL | 必须 |
| S3 | 测试覆盖 | 补 migration / service / API / 前端源码测试 | 必须 |
| S4 | 本地执行验证 | 执行 migration，验证接口返回和前端展示 | 必须 |
| S5 | 体验微调 | 调整排序、prompt 文案、低质量模板停用 | 建议 |
| S6 | UI 增强 | 分类、搜索、折叠、高频模板展示 | 后续 |

推荐顺序：

```text
S1 -> S2 -> S3 -> S4 -> S5 -> S6
```

第一轮上线只需要完成 S1-S4。S5 根据实际出图效果调整。S6 等模板数量继续增加或用户反馈选择困难时再做。

## 4. S1 模板清单确认

### 4.1 S1 目标

确认第一批模板清单，避免后续 migration 写完后频繁改 ID。

### 4.2 命名规则

模板 ID 使用稳定英文 snake_case。

推荐前缀：

```text
tti_      text_to_image 文生图
edit_     image_to_image 图生图
restore_  image_restore 图片修复
```

已有历史模板不改 ID：

```text
tti_product_poster
tti_portrait_editorial
tti_illustration_flat
keep_subject
change_background
change_style
variation
old_photo
denoise
deblur
color_enhance
```

### 4.3 第一批目标数量

| 任务类型 | 当前数量 | 目标数量 | 新增数量 |
|---|---:|---:|---:|
| 文生图 | 3 | 18 | 15 |
| 图生图 | 4 | 12 | 8 |
| 图片修复 | 4 | 10 | 6 |
| 合计 | 11 | 40 | 29 |

### 4.4 文生图模板清单

| 序号 | ID | 名称 | 分类 | 排序 | 是否新增 |
|---:|---|---|---|---:|---|
| 1 | `tti_product_poster` | 商品海报 | product | 10 | 否 |
| 2 | `tti_commercial_photo` | 商业摄影 | product | 20 | 是 |
| 3 | `tti_ecommerce_main_image` | 电商主图 | product | 30 | 是 |
| 4 | `tti_xiaohongshu_cover` | 小红书封面 | social | 40 | 是 |
| 5 | `tti_douyin_cover` | 抖音视频封面 | social | 50 | 是 |
| 6 | `tti_portrait_editorial` | 人物大片 | portrait | 60 | 否 |
| 7 | `tti_realistic_photo` | 写实摄影 | portrait | 70 | 是 |
| 8 | `tti_chinese_style` | 国风插画 | chinese | 80 | 是 |
| 9 | `tti_anime_style` | 二次元 | anime | 90 | 是 |
| 10 | `tti_illustration_flat` | 扁平插画 | illustration | 100 | 否 |
| 11 | `tti_children_book` | 儿童绘本 | illustration | 110 | 是 |
| 12 | `tti_watercolor` | 水彩插画 | illustration | 120 | 是 |
| 13 | `tti_oil_painting` | 油画质感 | illustration | 130 | 是 |
| 14 | `tti_cyberpunk` | 赛博朋克 | poster | 140 | 是 |
| 15 | `tti_minimal_premium` | 极简高级感 | design | 150 | 是 |
| 16 | `tti_3d_render` | 3D 渲染 | render | 160 | 是 |
| 17 | `tti_logo_icon` | Logo / 图标 | design | 170 | 是 |
| 18 | `tti_movie_poster` | 电影海报 | poster | 180 | 是 |

### 4.5 图生图模板清单

| 序号 | ID | 名称 | 分类 | 排序 | 是否新增 |
|---:|---|---|---|---:|---|
| 1 | `keep_subject` | 保持主体 | edit | 10 | 否 |
| 2 | `change_background` | 换背景 | scene | 20 | 否 |
| 3 | `change_style` | 换风格 | style | 30 | 否 |
| 4 | `variation` | 生成变体 | edit | 40 | 否 |
| 5 | `edit_scene_replace` | 保持主体换场景 | scene | 50 | 是 |
| 6 | `edit_outfit_change` | 换服装 | portrait | 60 | 是 |
| 7 | `edit_hair_style` | 换发型 | portrait | 70 | 是 |
| 8 | `edit_season_change` | 换季节 | scene | 80 | 是 |
| 9 | `edit_lighting` | 换光影 | light | 90 | 是 |
| 10 | `edit_to_chinese_style` | 转国风 | style | 100 | 是 |
| 11 | `edit_to_anime` | 转动漫 | style | 110 | 是 |
| 12 | `edit_product_refine` | 商品图精修 | product | 120 | 是 |

### 4.6 图片修复模板清单

| 序号 | ID | 名称 | 分类 | 排序 | 是否新增 |
|---:|---|---|---|---:|---|
| 1 | `old_photo` | 老照片修复 | restore | 10 | 否 |
| 2 | `denoise` | 去噪增强 | quality | 20 | 否 |
| 3 | `deblur` | 模糊变清晰 | quality | 30 | 否 |
| 4 | `color_enhance` | 色彩增强 | color | 40 | 否 |
| 5 | `restore_portrait_enhance` | 人像增强 | portrait | 50 | 是 |
| 6 | `restore_low_light` | 暗光增强 | quality | 60 | 是 |
| 7 | `restore_low_resolution` | 低清晰度增强 | quality | 70 | 是 |
| 8 | `restore_background_extend` | 背景补全 | background | 80 | 是 |
| 9 | `restore_color_repair` | 色彩修复 | color | 90 | 是 |
| 10 | `restore_detail_enhance` | 细节增强 | quality | 100 | 是 |

### 4.7 S1 验收标准

- 模板 ID 没有重复。
- 模板名称是用户能理解的中文，不是技术内部名。
- 每个模板都有明确 `task_type`。
- 没有高风险模板。
- 新增数量与目标一致。

## 5. S2 Seed Migration 实现

### 5.1 S2 目标

新增 migration，把第一批新增模板写入 `style_presets` 表。

### 5.2 新增文件

```text
molin-image-app/migrations/014_seed_more_style_presets.up.sql
molin-image-app/migrations/014_seed_more_style_presets.down.sql
```

注意：

- 不要修改 `010_enhance_style_presets.up.sql`，避免影响已经执行过 migration 的环境。
- 新增 migration 只追加新增模板和必要的旧模板排序更新。
- `down.sql` 只删除本次新增的 29 个模板，不删除旧模板。

### 5.3 up.sql 结构

推荐结构：

```sql
INSERT INTO style_presets (
  id, name, category, task_type, prompt_template, preview_image_url, enabled, sort_order
) VALUES
  (...),
  (...)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  category = VALUES(category),
  task_type = VALUES(task_type),
  prompt_template = VALUES(prompt_template),
  preview_image_url = VALUES(preview_image_url),
  enabled = VALUES(enabled),
  sort_order = VALUES(sort_order);
```

### 5.4 down.sql 结构

推荐结构：

```sql
DELETE FROM style_presets
WHERE id IN (
  'tti_realistic_photo',
  'tti_commercial_photo'
  -- 只列本次新增模板
);
```

### 5.5 文生图新增模板 prompt

#### `tti_commercial_photo` 商业摄影

```text
以商业摄影风格呈现，主体质感清晰，布光精致，画面干净高级，背景与主体形成明确层次，适合品牌视觉和营销物料。
```

#### `tti_ecommerce_main_image` 电商主图

```text
以电商主图风格呈现，主体居中且清晰完整，背景简洁干净，光线均匀，突出商品外观、材质和卖点，适合商品展示。
```

#### `tti_xiaohongshu_cover` 小红书封面

```text
以小红书封面风格呈现，画面明亮清爽，主体突出，色彩柔和有生活方式氛围，构图适合社媒种草内容。
```

#### `tti_douyin_cover` 抖音视频封面

```text
以短视频封面风格呈现，主体醒目，构图有冲击力，色彩对比明确，画面适合移动端竖屏浏览和快速吸引注意。
```

#### `tti_realistic_photo` 写实摄影

```text
以真实摄影风格呈现，主体自然可信，镜头质感真实，光线柔和，背景层次自然，避免过度塑料感、假细节和夸张特效。
```

#### `tti_chinese_style` 国风插画

```text
以东方国风插画风格呈现，融合传统纹样、雅致配色、柔和留白和细腻线条，画面具有古典审美和现代精致感。
```

#### `tti_anime_style` 二次元

```text
以高质量二次元插画风格呈现，线条干净，角色或主体精致，色彩鲜明，光影柔和，画面具有动漫作品的完成度。
```

#### `tti_cyberpunk` 赛博朋克

```text
以赛博朋克风格呈现，霓虹光效、未来城市、强烈冷暖对比和科技细节突出，画面具有科幻氛围和视觉冲击力。
```

#### `tti_minimal_premium` 极简高级感

```text
以极简高级感风格呈现，留白充足，构图克制，色彩低饱和，材质和光影精致，适合品牌图、封面和高级宣传视觉。
```

#### `tti_3d_render` 3D 渲染

```text
以高质量 3D 渲染风格呈现，主体结构清晰，材质细腻，光线真实，空间层次明确，适合产品渲染和 IP 形象创作。
```

#### `tti_logo_icon` Logo / 图标

```text
以简洁图标和品牌标识草案风格呈现，轮廓清晰，形状易识别，视觉元素简洁有记忆点，避免复杂背景和过多文字。
```

#### `tti_children_book` 儿童绘本

```text
以儿童绘本插画风格呈现，画面温暖友好，角色可爱，色彩柔和，构图简单易懂，适合儿童故事和亲子内容。
```

#### `tti_watercolor` 水彩插画

```text
以水彩插画风格呈现，色彩轻盈透明，边缘柔和，笔触自然，画面具有文艺、清新和手绘质感。
```

#### `tti_oil_painting` 油画质感

```text
以油画质感呈现，笔触丰富，色彩层次厚重，光影具有绘画感，画面带有艺术肖像或经典绘画氛围。
```

#### `tti_movie_poster` 电影海报

```text
以电影海报风格呈现，画面具有故事感和戏剧张力，主体明确，光影对比强，构图适合宣传海报和视觉封面。
```

### 5.6 图生图新增模板 prompt

#### `edit_scene_replace` 保持主体换场景

```text
请基于参考图生成新图，保持主体身份、结构、姿态和核心视觉特征不变，将背景或环境替换为新的场景，并保持光影自然一致。
```

#### `edit_outfit_change` 换服装

```text
请基于参考图生成新图，尽量保持人物身份、脸部特征、姿态和构图不变，只调整服装款式、材质和搭配，使整体自然协调。
```

#### `edit_hair_style` 换发型

```text
请基于参考图生成新图，保持人物身份、脸部特征和整体气质不变，只调整发型、发色或发丝细节，避免改变五官。
```

#### `edit_season_change` 换季节

```text
请基于参考图生成新图，保持主体和构图关系不变，将场景氛围转换为指定季节，调整环境元素、色彩、光线和细节。
```

#### `edit_lighting` 换光影

```text
请基于参考图生成新图，保持主体和画面结构不变，重点调整光线方向、明暗层次、氛围色和阴影细节，使画面更有质感。
```

#### `edit_to_chinese_style` 转国风

```text
请基于参考图生成新图，保持主体识别度和构图关系，将整体转换为东方国风视觉，加入雅致配色、传统纹样和细腻线条。
```

#### `edit_to_anime` 转动漫

```text
请基于参考图生成新图，保持主体身份和核心特征，将整体转换为高质量动漫插画风格，线条清晰，色彩鲜明，光影自然。
```

#### `edit_product_refine` 商品图精修

```text
请基于参考商品图进行精修，保持商品结构、比例和品牌特征不变，优化光线、材质、背景和构图，使画面更适合电商展示。
```

### 5.7 图片修复新增模板 prompt

#### `restore_portrait_enhance` 人像增强

```text
请在保持人物身份、五官比例和真实质感的前提下，增强人像清晰度、肤色自然度和局部细节，避免磨皮过度或五官变形。
```

#### `restore_low_light` 暗光增强

```text
请增强暗光图片的可见度，提升暗部细节和整体亮度，降低噪点，同时保持自然光影和真实色彩。
```

#### `restore_low_resolution` 低清晰度增强

```text
请增强低清晰度图片，提升主体边缘、纹理和局部细节，减少压缩痕迹，保持画面自然，不要生成不真实细节。
```

#### `restore_background_extend` 背景补全

```text
请基于原图内容自然补全画面边缘和背景缺失区域，保持透视、纹理、光线和整体风格一致。
```

#### `restore_color_repair` 色彩修复

```text
请修复图片偏色、褪色和不自然色彩，校正白平衡、饱和度和对比度，使画面色彩自然、稳定且真实。
```

#### `restore_detail_enhance` 细节增强

```text
请增强图片细节和纹理表现，改善边缘清晰度和局部层次，同时避免过度锐化、噪点放大和伪影。
```

### 5.8 S2 验收标准

- 新增 `014_seed_more_style_presets.up.sql`。
- 新增 `014_seed_more_style_presets.down.sql`。
- `up.sql` 包含 29 个新增模板。
- `down.sql` 只删除 29 个新增模板。
- SQL 不包含真实密钥、token 或外部敏感信息。
- SQL 可重复执行，重复执行不报错。

## 6. S3 测试覆盖

### 6.1 S3 目标

确保模板扩充不是“只写 SQL”，而是可以被测试证明：

- migration 包含目标模板。
- service 仍然按 `task_type` 过滤。
- API 仍然只返回启用模板。
- 前端源码仍然使用后端模板接口。

### 6.2 建议修改测试

优先修改：

```text
molin-image-app/test/migration-schema.test.ts
molin-image-app/test/style-preset-service.test.ts
molin-image-app/test/style-preset-api.test.ts
molin-image-app/test/workspace-frontend.test.ts
```

### 6.3 migration 测试要求

增加断言：

```text
014_seed_more_style_presets.up.sql 存在
014_seed_more_style_presets.down.sql 存在
up.sql 包含 tti_xiaohongshu_cover
up.sql 包含 tti_anime_style
up.sql 包含 edit_outfit_change
up.sql 包含 edit_product_refine
up.sql 包含 restore_portrait_enhance
up.sql 包含 restore_low_light
down.sql 包含上述新增模板 ID
```

### 6.4 service 测试要求

确认：

- `listVisiblePresets("text_to_image")` 只返回文生图模板。
- `listVisiblePresets("image_to_image")` 只返回图生图模板。
- `listVisiblePresets("image_restore")` 只返回修复模板。
- 停用模板不返回。

现有测试已经覆盖部分逻辑，新增模板后可补“数量或重点 ID”断言。

### 6.5 前端源码测试要求

确认前端仍然：

- 调用 `/api/image/style-presets`。
- 有 `stylePresetSelect`。
- 有 `stylePresetList`。
- 提交任务时传 `style_preset_id`。

### 6.6 S3 验收命令

```bash
cd molin-image-app
npm run build
npm run lint
npm test
```

验收标准：

```text
build 通过
lint 通过
test 全部通过
```

## 7. S4 本地执行验证

### 7.1 S4 目标

把模板真正写入本地 MySQL，并确认用户端接口和页面可见。

### 7.2 执行 migration

```bash
cd molin-image-app
npm run db:migrate
```

如果需要回滚本次 migration：

```bash
npm run db:rollback
```

注意：回滚会按迁移系统当前状态执行最后一个 down migration，执行前先确认当前最新 migration 是 `014_seed_more_style_presets`。

### 7.3 数据库验证 SQL

进入 MySQL 后执行：

```sql
SELECT task_type, COUNT(*) AS total
FROM style_presets
WHERE enabled = 1
GROUP BY task_type
ORDER BY task_type;
```

期望：

```text
text_to_image >= 18
image_to_image >= 12
image_restore >= 10
```

重点模板检查：

```sql
SELECT id, name, category, task_type, enabled, sort_order
FROM style_presets
WHERE id IN (
  'tti_xiaohongshu_cover',
  'tti_anime_style',
  'edit_outfit_change',
  'edit_product_refine',
  'restore_portrait_enhance',
  'restore_low_light'
)
ORDER BY task_type, sort_order;
```

### 7.4 API 验证

需要登录态 cookie。可从页面进入后用浏览器验证，或用已有 session cookie 请求。

文生图：

```text
GET /api/image/style-presets?task_type=text_to_image
```

图生图：

```text
GET /api/image/style-presets?task_type=image_to_image
```

图片修复：

```text
GET /api/image/style-presets?task_type=image_restore
```

验收：

- `items` 非空。
- 每个接口只返回对应 `task_type`。
- 新增模板在对应接口中出现。
- `enabled=false` 的模板不返回。

### 7.5 前端验证

启动服务：

```bash
cd molin-image-app
npm run dev
```

打开：

```text
http://127.0.0.1:5199
```

验证：

- 文生图模式可以看到新增文生图模板。
- 图生图模式可以看到新增图生图模板。
- 图片修复模式可以看到新增修复模板。
- 高清放大不显示风格模板。
- 图生文不显示风格模板。
- 选择模板后提交任务，任务详情中 `风格 / 操作` 显示对应模板 ID。

### 7.6 S4 验收标准

- migration 执行成功。
- 数据库模板数量达到目标。
- API 返回正确。
- 前端展示正确。
- 选择模板后任务能创建。

## 8. S5 体验微调

### 8.1 S5 目标

模板上线后，按实际出图效果调整 prompt 和排序。

### 8.2 验证方式

每个新增模板至少手动测试 1 次。

文生图建议测试输入：

```text
一款高端智能手表
一个年轻女性在咖啡馆阅读
一座未来城市夜景
```

图生图建议测试：

```text
上传一张人物图，测试换服装、换发型、转动漫
上传一张商品图，测试商品图精修、换背景
上传一张场景图，测试换季节、换光影
```

图片修复建议测试：

```text
上传暗光图，测试暗光增强
上传低清图，测试低清晰度增强
上传人像图，测试人像增强
上传边缘缺失图，测试背景补全
```

### 8.3 调整原则

- 出图偏泛：增加主体保持、场景、光线、构图约束。
- 出图偏乱：减少模板词，保留核心要求。
- 人像变形：强调保持身份、五官比例、自然质感。
- 商品变形：强调保持商品结构、比例、品牌特征。
- 修复过度：强调不要改变原图主体和真实质感。

### 8.4 S5 验收标准

- 高频模板出图方向稳定。
- 没有明显误导用户的模板。
- 低质量模板已调整或停用。
- 排序符合使用频率。

## 9. S6 UI 增强

### 9.1 S6 触发条件

当模板数量达到 40 个以上，用户可能遇到选择困难。此时再做 UI 增强。

### 9.2 建议功能

优先级从高到低：

1. 按 `category` 分组。
2. 默认展示高频模板，其余折叠。
3. 模板搜索。
4. 最近使用模板。
5. 收藏模板。
6. 模板使用次数和推荐排序。

### 9.3 推荐交互

文生图：

```text
商品商业 / 社媒封面 / 人像摄影 / 插画绘画 / 国风二次元 / 设计素材
```

图生图：

```text
通用编辑 / 人像编辑 / 商品编辑 / 场景变化 / 风格转换 / 光影调整
```

图片修复：

```text
基础修复 / 人像增强 / 清晰度增强 / 色彩修复 / 背景补全
```

### 9.4 S6 验收标准

- 模板超过 40 个时页面仍清晰。
- 移动端不溢出。
- 用户能快速找到常用模板。
- 不影响现有 `style_preset_id` 提交流程。

## 10. 风险和边界

### 10.1 不做的模板

第一批不做：

- 去水印。
- 去遮挡。
- 证件照伪造。
- 票据、印章、证件生成。
- 真人恶意换脸。
- 恢复被遮挡的隐私信息。

### 10.2 数据风险

- 修改已有模板 ID 会影响历史任务展示，所以禁止改旧 ID。
- 删除旧模板会影响历史任务详情，所以本次只新增，不删除旧模板。
- down migration 不能删除旧模板。

### 10.3 体验风险

- 模板太多但不分组会让页面变拥挤。
- prompt 太长可能限制用户发挥。
- prompt 太短又起不到模板价值。
- 外链预览图可能加载慢，后续建议迁移到 MinIO 文件。

## 11. 完成定义

本规划执行完成的定义：

- 新增 migration 已提交。
- 新增模板总量达到目标。
- 测试通过。
- 本地或测试环境 migration 已执行。
- 用户端三个入口都能看到对应新增模板。
- 选择模板后任务能正常创建。
- worker 能把模板 prompt 拼入最终提示词。
- 有明确回滚方式。

## 12. 最小可执行版本

如果想先快速落地，最小执行范围是：

```text
S1 模板清单确认
S2 新增 014 seed migration
S3 跑 build / lint / test
S4 执行 migration 并检查接口
```

暂不做：

```text
分类 UI
搜索
模板统计
收藏模板
预览图迁移 MinIO
```

这样可以最快让用户看到更多模板，后续再根据使用情况做体验升级。

