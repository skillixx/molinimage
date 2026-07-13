CREATE TABLE IF NOT EXISTS image_model_configs (
  id VARCHAR(128) NOT NULL COMMENT '模型配置 ID，由来源模型 code 和初始能力生成',
  gateway_model_code VARCHAR(255) NOT NULL COMMENT 'AI 网关模型 code',
  display_name VARCHAR(255) NOT NULL COMMENT '模型展示名称',
  description TEXT NOT NULL COMMENT '模型说明',
  capability VARCHAR(64) NOT NULL COMMENT '图片应用内实际启用的能力标签',
  source_capability VARCHAR(64) NOT NULL COMMENT '来源目录同步时的原始能力标签',
  source_status VARCHAR(32) NOT NULL COMMENT '来源目录中的模型状态',
  source_available TINYINT(1) NOT NULL DEFAULT 1 COMMENT '最近一次同步时来源目录是否仍存在',
  admin_enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT '管理员开关，关闭后用户端不可见且不可提交',
  quality_tier VARCHAR(64) NOT NULL COMMENT '模型质量层级',
  supported_task_types JSON NOT NULL COMMENT '应用允许该模型承接的任务类型',
  supported_image_sizes JSON NOT NULL COMMENT '支持的图片尺寸',
  supported_input_types JSON NOT NULL COMMENT '支持的输入类型',
  supported_output_types JSON NOT NULL COMMENT '支持的输出类型',
  max_input_files INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '最大输入文件数',
  max_output_count INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '最大输出数量',
  sort_order INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '用户端排序',
  synced_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '最近同步时间',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_image_model_configs_source (gateway_model_code, source_capability),
  KEY idx_image_model_configs_visible (source_available, admin_enabled, source_status, capability, sort_order),
  KEY idx_image_model_configs_capability (capability)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='图片模型管理配置';

CREATE TABLE IF NOT EXISTS image_model_defaults (
  task_type VARCHAR(64) NOT NULL COMMENT '任务类型',
  model_config_id VARCHAR(128) NOT NULL COMMENT '默认模型配置 ID',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (task_type),
  KEY idx_image_model_defaults_model (model_config_id),
  CONSTRAINT fk_image_model_defaults_model
    FOREIGN KEY (model_config_id) REFERENCES image_model_configs(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='图片任务默认模型配置';
