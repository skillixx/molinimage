# 图片价格规则管理

## 管理入口

- 页面：`GET /admin/pricing`
- 管理员白名单：环境变量 `MOLINIMAGE_ADMIN_USER_IDS`，多个墨灵用户 ID 使用英文逗号分隔。
- 页面和 `/api/admin/*` 使用墨灵应用 Session 鉴权，浏览器不接触内部接口令牌。
- 墨灵后端也可使用 `Authorization: Bearer <INTERNAL_API_TOKEN>` 调用 `/api/internal/image/pricing-rules`。

## 接口

| 方法  | 路径                                  | 说明               |
| ----- | ------------------------------------- | ------------------ |
| GET   | `/api/admin/image/pricing-rules`      | 查询全部规则       |
| POST  | `/api/admin/image/pricing-rules`      | 创建规则           |
| PATCH | `/api/admin/image/pricing-rules/{id}` | 更新价格或启停规则 |

创建请求示例：

```json
{
  "task_type": "text_to_image",
  "gateway_model_code": null,
  "gateway_capability": "image_generation",
  "quality": "hd",
  "image_size": "1024x1536",
  "upscale_factor": null,
  "usage_type": "image_text_to_image",
  "unit": "credits",
  "points_per_unit": "10",
  "active": true
}
```

## 匹配与禁用

- 模型 code、模型能力、质量、尺寸和高清倍率中，配置维度更多的启用规则优先。
- 同一任务和同一组维度只能创建一条规则，冲突返回 `PRICING_RULE_CONFLICT`。
- 某任务存在数据库规则后，以数据库为权威来源，不再回退环境变量规则。
- 具体规则禁用后可回退该任务的启用默认规则；没有启用默认规则时，估算和任务预占返回 `BILLING_RULE_NOT_FOUND`。
- 估算与预占每次读取 MySQL 当前规则，避免多实例使用不同价格。
