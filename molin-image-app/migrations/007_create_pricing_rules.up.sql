-- P4-G01：可运营的图片任务价格规则。
-- nullable 维度表示默认规则；匹配时维度越具体优先级越高，禁用规则不会参与估算和预占。

CREATE TABLE IF NOT EXISTS pricing_rules (
  id VARCHAR(64) NOT NULL COMMENT '价格规则 ID，由应用生成',
  task_type VARCHAR(64) NOT NULL COMMENT '任务类型',
  gateway_model_code VARCHAR(128) NULL COMMENT '可选逻辑模型编码，NULL 表示不限模型',
  gateway_capability VARCHAR(64) NULL COMMENT '可选模型能力，NULL 表示不限能力',
  quality VARCHAR(64) NULL COMMENT '可选质量档位，NULL 表示不限质量',
  image_size VARCHAR(64) NULL COMMENT '可选图片尺寸，NULL 表示不限尺寸',
  upscale_factor INT UNSIGNED NULL COMMENT '可选高清倍率，只允许 2 或 4',
  usage_type VARCHAR(64) NOT NULL COMMENT '墨灵用量类型',
  unit VARCHAR(32) NOT NULL DEFAULT 'credits' COMMENT '计费单位',
  points_per_unit DECIMAL(18, 6) NOT NULL COMMENT '每单位积分，禁止浮点计算',
  active TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_pricing_rules_task_active (task_type, active),
  KEY idx_pricing_rules_capability_active (gateway_capability, active),
  CONSTRAINT chk_pricing_rules_upscale_factor CHECK (upscale_factor IS NULL OR upscale_factor IN (2, 4)),
  CONSTRAINT chk_pricing_rules_points CHECK (points_per_unit >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='图片任务可运营价格规则';
