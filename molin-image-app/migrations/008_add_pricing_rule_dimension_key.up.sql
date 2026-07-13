-- P4-G01：同一任务和同一组价格维度只能存在一条规则，避免匹配结果依赖数据库返回顺序。
ALTER TABLE pricing_rules
  ADD COLUMN dimension_key VARCHAR(512)
    GENERATED ALWAYS AS (
      CONCAT(
        COALESCE(gateway_model_code, '*'), '|',
        COALESCE(gateway_capability, '*'), '|',
        COALESCE(quality, '*'), '|',
        COALESCE(image_size, '*'), '|',
        COALESCE(CAST(upscale_factor AS CHAR), '*')
      )
    ) STORED COMMENT '价格维度归一化键',
  ADD UNIQUE KEY uk_pricing_rules_task_dimensions (task_type, dimension_key);
