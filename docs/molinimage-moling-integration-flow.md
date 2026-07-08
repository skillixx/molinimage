# molinimage 墨灵平台接入流程与参数填写清单

## 1. 文档目的

本文档用于指导 `molinimage` AI 图片创作应用接入墨灵平台。内容基于 `molin_docs/docs/moling-app-integration-guide.md`、`molin_docs/docs/moling-integration.md` 和 `molin_docs/app/developer-integration-guide.md` 整理。

接入目标：

- 用户从墨灵平台点击应用后免登录进入 `molinimage`。
- 应用后端校验墨灵一次性 `ticket`，创建自己的应用 session。
- 用户使用图片生成、图片修复、图生文等功能前，应用确认用户有可用权益。
- 产生计费任务时，应用后端调用墨灵内部接口完成预占、结算、释放或消费。
- 前端不直接调用墨灵内部 API，不接触 `INTERNAL_API_TOKEN`。

## 2. 总体流程

```text
用户登录墨灵平台
  -> 在应用市场或用户资产中点击 molinimage
  -> 墨灵平台生成一次性 ticket
  -> 跳转到 molinimage access_url，例如 /enter?ticket=lt_xxx
  -> molinimage 后端调用墨灵 verify 接口校验 ticket
  -> 校验 app_id、product_id 是否匹配 molinimage
  -> 创建 molinimage 自己的 session cookie
  -> 跳转到图片创作工作台
  -> 前端调用 /api/me 获取当前用户、权益和余额
  -> 用户提交图片任务
  -> 后端预估积分并预占额度
  -> worker 调 AI 网关生成或分析图片
  -> 结果写入 MinIO，任务状态写入 MySQL
  -> 成功结算积分，失败释放预占
```

## 3. 墨灵平台后台需要填写的参数

### 3.1 创建应用

在墨灵管理后台创建应用记录。

| 字段 | molinimage 建议值 | 说明 |
|---|---|---|
| `code` | `molinimage` | 应用编码，全局唯一，建议不要再使用 word/ppt 关键词 |
| `name` | `墨灵 AI 图片创作` | 用户在平台看到的应用名称 |
| `type` | `application` | 外部应用类型 |
| `access_url` | `http://8.130.9.163:5188/enter` | 用户点击进入应用时跳转地址，需要能接收 `?ticket=lt_xxx` |
| `status` | `active` | 必须启用 |

`access_url` 最终会被平台拼成：

```text
http://8.130.9.163:5188/enter?ticket=lt_xxx
```

如果后续前后端分离，并由后端处理 `/enter`，也可以改成：

```text
http://8.130.9.163:3000/enter
```

选择原则：

- 如果前端负责接收入口并转发给后端，填前端地址。
- 如果后端直接处理 ticket 并重定向工作台，填后端地址。
- 无论填哪个，最终都必须能让后端拿到 `ticket` 并调用 verify。

### 3.2 创建应用适配器

适配器用于登记应用对接能力和用量类型。

| 字段 | molinimage 建议值 | 说明 |
|---|---|---|
| `app_code` | `molinimage` | 必须与应用 code 一致 |
| `app_name` | `墨灵 AI 图片创作` | 不要带前后空格 |
| `app_type` | `application` | 应用类型 |
| `adapter_type` | `external` | 外部应用通常填 `external` |
| `service_name` | `molinimage` | 服务名，用于平台识别 |
| `callback_url` | `http://8.130.9.163:5188/enter` | 应用入口或回调地址 |
| `supported_actions_json` | `["provision","cancel"]` | 可先按通用外部应用填写 |
| `usage_event_types_json` | 见下方示例 | 用于登记图片应用可能产生的用量类型 |
| `status` | `active` | 必须启用 |

`usage_event_types_json` 建议：

```json
[
  "image_text_to_image",
  "image_to_image",
  "image_restore",
  "image_to_text",
  "image_upscale"
]
```

说明：

- 如果当前采用 prepaid 积分制，真正扣额度走 `entitlement-*` 接口，不一定走 usage event。
- 仍建议登记用量类型，方便平台统计、治理和后续对账。

### 3.3 创建商品

要让用户能购买和使用应用，需要把应用挂成商品。

| 字段 | molinimage 建议值 | 说明 |
|---|---|---|
| `product_type` | `application` | 应用商品 |
| `business_ref_id` | `molinimage` 应用的 `app_id` | 指向应用记录 ID |
| `product_code` | `molinimage` 或 `molinimage-credits` | 商品编码 |
| `name` | `墨灵 AI 图片创作` | 商品名称 |
| `status` | `active` | 必须启用 |

关系必须满足：

```text
products.product_type = application
products.business_ref_id = applications.id
```

### 3.4 配置套餐和价格

`molinimage` 建议第一阶段使用 prepaid 积分/额度模式。

这里要分清三件事：

| 层级 | 配置位置 | 作用 | molinimage 示例 |
|---|---|---|---|
| 套餐 | `product_plans` | 用户买到多少额度、有效期多久 | 1000 图片积分包 |
| 购买价 | `product_prices` | 用户购买这个套餐时付多少钱 | 默认价 99 元、会员价 79 元 |
| 使用消耗 | 应用侧价格规则或平台 prepaid 规则 | 用户生成/修复一次图片扣多少积分 | 文生图扣 6 积分 |

#### 3.4.1 套餐配置

套餐只描述“买到什么额度”，不要把单次图片任务价格写在套餐里。

创建套餐时建议字段：

```json
{
  "plan_code": "molinimage-1000-credits",
  "name": "molinimage 1000 图片积分包",
  "billing_type": "usage",
  "duration_days": 365,
  "quota_json": {
    "entitlement_type": "molinimage_credits",
    "quota_total": 1000,
    "quota_unit": "credits",
    "valid_days": 365
  },
  "status": "active"
}
```

`quota_json` 只负责生成用户购买后的 `user_entitlements` 额度：

```json
{
  "entitlement_type": "molinimage_credits",
  "quota_total": 1000,
  "quota_unit": "credits",
  "valid_days": 365
}
```

建议规则：

- `entitlement_type` 建议使用 `molinimage_credits`，不要沿用 `ppt_ai_credits` 或 `word_credits`。
- 套餐编码与额度保持一致，例如 `molinimage-1000-credits`。
- `quota_total` 是用户买到的总额度，不是单次任务消耗。
- `valid_days` 是额度有效期，到期未用完的额度会失效。

#### 3.4.2 价格配置

价格配置在 `product_prices`，它决定用户购买套餐时付多少钱。

默认价格必须配置，否则用户可能看得到套餐但无法购买。

示例：

```json
{
  "items": [
    {
      "product_plan_id": 123,
      "role_id": null,
      "membership_level_id": null,
      "price_amount": "99.00",
      "currency": "CNY"
    }
  ]
}
```

价格规则：

- 每个可购买套餐必须有默认价格，即 `role_id=null` 且 `membership_level_id=null` 的价格。
- `user_price = -1` 表示未配置价格，用户端应禁购。
- `user_price = 0` 是合法免费价格。
- 会员价、角色价属于购买价优惠，不影响图片任务单次扣多少积分。

#### 3.4.3 图片任务消耗配置

图片任务消耗不是套餐本身，而是“用户使用功能时从已购买额度里扣多少”。

第一阶段可以先由 `molinimage` 应用侧配置任务消耗，例如：

| 任务类型 | usage_type | 建议消耗 |
|---|---|---|
| 文生图 | `image_text_to_image` | 6 credits |
| 图生图 | `image_to_image` | 8 credits |
| 图片修复 | `image_restore` | 5 credits |
| 图生文 | `image_to_text` | 1 credit |
| 高清放大 | `image_upscale` | 4 credits |

使用时，应用后端按任务类型计算 `amount`，然后调用墨灵 entitlement 接口：

```text
entitlement-reserve -> entitlement-settle / entitlement-release
```

如果平台后台也要求配置 prepaid 计费规则，则规则只用于统一治理和展示，字段应保持：

```json
{
  "usage_type": "image_text_to_image",
  "usage_unit": "credits",
  "billing_mode": "prepaid",
  "price_amount": "6",
  "status": "active"
}
```

注意：

- prepaid 图片任务实际扣减走 `entitlement-*` 接口。
- 不要对同一次图片任务同时走 `product-usage-events` 和 `entitlement-*`，否则会形成双扣。
- `usage_type` 要和应用适配器 `usage_event_types_json`、应用侧任务类型保持一致。

### 3.5 配置访问权限

给目标用户角色打开商品访问权限。

```text
can_view = true
can_buy  = true
can_use  = true
```

常见问题：

- `can_view=false`：用户在市场看不到应用。
- `can_buy=false`：用户能看到但不能购买。
- `can_use=false`：用户买了但进入或使用时应该被应用拦截。

### 3.6 配置内部接口凭证和 IP 白名单

平台侧需要确认：

```text
INTERNAL_API_TOKEN 已生成
INTERNAL_ALLOWED_IPS 包含 molinimage 后端服务器出口 IP
```

应用后端调用内部接口时必须带：

```http
X-Internal-Token: <INTERNAL_API_TOKEN>
```

如果 `molinimage` 和墨灵平台部署在同一台服务器上，应用后端调用内部接口建议使用：

```text
http://127.0.0.1:8080
```

如果跨机器调用，则 `MOLING_API_BASE_URL` 使用：

```text
http://8.130.9.163:8080
```

并确保应用后端出口 IP 已加入 `INTERNAL_ALLOWED_IPS`。

## 4. molinimage 应用侧 `.env` 参数

当前 `molin-image-app/.env` 至少需要：

```env
# Moling platform
MOLING_API_BASE_URL=http://8.130.9.163:8080
INTERNAL_API_TOKEN=由平台提供，不能提交仓库
LOCAL_MOLING_MOCK=false
MOLING_APP_ID=平台创建 molinimage 应用后返回的 app_id
MOLING_PRODUCT_ID=平台创建 molinimage 商品后返回的 product_id
MOLING_USER_ENTITLEMENT_MAP=696:64,479:62
MOLING_DEFAULT_ENTITLEMENT_ID=

# Application runtime
APP_ENV=development
APP_NAME=molinimage
APP_BASE_URL=http://8.130.9.163:5188
APP_PORT=5778
LOCAL_API_PORT=3001
SESSION_COOKIE_SECURE=false
SESSION_TTL_SECONDS=86400
PORT=3000

# Database / queue / storage
DATABASE_URL=mysql://molinimage_app:密码@172.16.10.151:13306/molinimage
REDIS_URL=redis://:密码@172.16.10.151:6379/0
STORAGE_PROVIDER=minio
STORAGE_ENDPOINT=http://172.16.10.151:19000
STORAGE_BUCKET=molinimage
STORAGE_ACCESS_KEY_ID=MinIO access key
STORAGE_SECRET_ACCESS_KEY=MinIO secret key

# AI gateway
AI_GATEWAY_BASE_URL=http://8.130.9.163:8080/v1
```

重要说明：

- `.env` 可以放真实值，但必须被 `.gitignore` 排除。
- `.env.example` 只能放占位值。
- `MOLING_APP_ID` 和 `MOLING_PRODUCT_ID` 必须与平台实际创建的 molinimage 应用和商品一致。
- 如果当前仍使用测试值 `990007`、`990106`，需要确认它们确实指向 molinimage，而不是 Word/PPT 应用。

## 5. molinimage 后端需要实现的接口

### 5.1 进入应用

```http
GET /enter?ticket=lt_xxx
```

处理逻辑：

```text
读取 ticket
  -> ticket 缺失返回 400
  -> 调 POST /api/internal/app-launch/verify
  -> 校验返回 app_id == MOLING_APP_ID
  -> 校验返回 product_id == MOLING_PRODUCT_ID
  -> 解析 entitlement_id
  -> 创建 molinimage session
  -> 设置 HttpOnly Cookie
  -> 跳转工作台
```

verify 请求：

```http
POST /api/internal/app-launch/verify
Content-Type: application/json
X-Internal-Token: <INTERNAL_API_TOKEN>

{
  "launch_ticket": "lt_xxx"
}
```

成功返回可能包含：

```json
{
  "user_id": 479,
  "app_id": 990007,
  "product_id": 990106,
  "entitlement_id": 62
}
```

### 5.2 当前用户

```http
GET /api/me
```

返回建议：

```json
{
  "user": {
    "user_id": 479
  },
  "app": {
    "app_id": 990007,
    "product_id": 990106
  },
  "entitlement": {
    "entitlement_id": 62,
    "remaining": "1000",
    "usable": true
  }
}
```

没有 session 返回 401。

### 5.3 退出登录

```http
POST /api/auth/logout
```

处理逻辑：

- 删除应用 session。
- 清除 session cookie。

## 6. entitlement_id 解析顺序

prepaid 积分制需要知道用户的 `entitlement_id`。推荐按下面顺序解析：

1. `app-launch/verify` 返回的 `entitlement_id`。
2. `app-launch/verify` 返回的 `entitlement.id` 或 `entitlements[]`。
3. 调平台内部接口：

```http
GET /api/internal/user-entitlements?user_id={user_id}&product_id={product_id}
X-Internal-Token: <INTERNAL_API_TOKEN>
```

4. 使用临时环境变量映射：

```env
MOLING_USER_ENTITLEMENT_MAP=696:64,479:62
```

5. 最后才使用：

```env
MOLING_DEFAULT_ENTITLEMENT_ID=
```

生产环境不建议长期依赖固定默认 entitlement。

## 7. 图片任务计费流程

### 7.1 高成本任务使用 reserve -> settle/release

适合：

- 文生图。
- 图生图。
- 图片修复。
- 高清放大。
- 批量任务。

流程：

```text
创建 image_task
  -> 调 entitlement-reserve 预占积分
  -> 任务入 Redis 队列
  -> worker 调 AI 网关
  -> 成功：结果写 MinIO，调 entitlement-settle
  -> 失败：调 entitlement-release
```

预占：

```http
POST /api/internal/entitlement-reserve
Content-Type: application/json
X-Internal-Token: <INTERNAL_API_TOKEN>

{
  "user_id": 479,
  "entitlement_id": 62,
  "amount": "6",
  "idempotency_key": "image_task_xxx:text_to_image:reserve"
}
```

结算：

```http
POST /api/internal/entitlement-settle
Content-Type: application/json
X-Internal-Token: <INTERNAL_API_TOKEN>

{
  "hold_id": 120,
  "actual_amount": "6"
}
```

释放：

```http
POST /api/internal/entitlement-release
Content-Type: application/json
X-Internal-Token: <INTERNAL_API_TOKEN>

{
  "hold_id": 120
}
```

### 7.2 轻量任务可使用 consume

适合：

- 图片描述。
- 标签生成。
- 提示词反推。
- 简单文案生成。

```http
POST /api/internal/entitlement-consume
Content-Type: application/json
X-Internal-Token: <INTERNAL_API_TOKEN>

{
  "user_id": 479,
  "entitlement_id": 62,
  "amount": "1",
  "idempotency_key": "image_task_xxx:image_to_text"
}
```

## 8. 字段类型规则

墨灵内部接口对字段类型敏感：

必须传数字：

```json
{
  "user_id": 479,
  "entitlement_id": 62,
  "hold_id": 120
}
```

额度金额使用字符串 decimal：

```json
{
  "amount": "6"
}
```

不要把 `user_id`、`entitlement_id`、`hold_id` 传成字符串。

## 9. 幂等键规则

每次扣费或扣额度动作必须有稳定幂等键。

建议格式：

```text
{任务ID}:{任务类型}:{动作}
```

示例：

```text
image_task_abc:text_to_image:reserve
image_task_abc:text_to_image:settle
image_task_abc:image_restore:reserve
image_task_abc:image_to_text:consume
```

要求：

- 同一个业务动作重试时复用同一个幂等键。
- 不要每次重试都生成新的幂等键。
- 幂等键需要落库，方便失败重试和对账。

## 10. 联调验收清单

### 10.1 平台配置验收

- molinimage 应用 `status=active`。
- 应用 `access_url` 能访问。
- 商品 `product_type=application`。
- 商品 `business_ref_id` 指向 molinimage 应用 ID。
- 商品 `status=active`。
- 套餐、价格、额度 `quota_json` 已配置。
- 目标角色 `can_view=true`、`can_buy=true`、`can_use=true`。
- `INTERNAL_API_TOKEN` 可用。
- molinimage 后端服务器出口 IP 已加入 `INTERNAL_ALLOWED_IPS`。

### 10.2 公网入口验收

直接访问：

```text
http://8.130.9.163:5188/enter
```

预期：

```text
返回“缺少 ticket”或跳转到错误页
```

访问无效 ticket：

```text
http://8.130.9.163:5188/enter?ticket=lt_invalid_check_only
```

预期：

```text
返回“ticket 无效或已过期”，不要创建 session
```

### 10.3 平台点击验收

用测试用户从墨灵平台点击进入应用：

```text
墨灵平台 -> /enter?ticket=lt_xxx -> molinimage 工作台
```

验收：

- 能建立 molinimage session。
- `/api/me` 返回当前用户。
- app_id/product_id 与 `.env` 一致。
- 可以解析 entitlement_id。
- 余额不足时不调用 AI 网关。

### 10.4 计费验收

- 文生图任务创建前能预估积分。
- 文生图任务创建时 reserve 成功。
- 生成成功后 settle 成功。
- 生成失败后 release 成功。
- 同一个任务重试不会重复扣费。
- 结算失败进入待对账状态。

## 11. 当前 molinimage 需要你确认的参数

| 参数 | 当前建议 | 需要确认 |
|---|---|---|
| 应用 code | `molinimage` | 是否已在平台创建 |
| 应用 name | `墨灵 AI 图片创作` | 展示名称是否确认 |
| access_url | `http://8.130.9.163:5188/enter` | 前端还是后端处理 `/enter` |
| `MOLING_APP_ID` | 当前 `.env` 为 `990007` | 是否真实属于 molinimage |
| `MOLING_PRODUCT_ID` | 当前 `.env` 为 `990106` | 是否真实属于 molinimage 商品 |
| `entitlement_type` | `molinimage_credits` | 平台套餐是否按此配置 |
| `INTERNAL_ALLOWED_IPS` | molinimage 后端出口 IP | 是否已加入平台白名单 |
| 测试用户 | 例如 `696`、`479` | 是否已购买/开通 molinimage 权益 |
