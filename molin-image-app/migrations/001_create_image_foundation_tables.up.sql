-- P1-G02：图片应用基础表结构。
-- 所有业务表显式使用 InnoDB 与 utf8mb4，保证事务能力和中文/emoji 内容存储能力。

CREATE TABLE IF NOT EXISTS image_tasks (
  id VARCHAR(64) NOT NULL COMMENT '图片任务 ID，由应用生成，便于跨系统追踪',
  owner_user_id BIGINT UNSIGNED NOT NULL COMMENT '墨灵平台用户 ID，用于所有用户级查询和权限判断',
  task_type VARCHAR(64) NOT NULL COMMENT '任务类型：text_to_image、image_to_text、image_to_image、restore、upscale 等',
  status VARCHAR(64) NOT NULL COMMENT '任务状态：pending、billing_reserved、queued、running、succeeded、failed 等',
  prompt TEXT NULL COMMENT '用户正向提示词或业务输入文本',
  negative_prompt TEXT NULL COMMENT '用户反向提示词',
  style_preset_id VARCHAR(64) NULL COMMENT '使用的风格模板 ID',
  input_file_ids JSON NULL COMMENT '输入文件 ID 列表，worker 必须回表校验归属',
  output_file_ids JSON NULL COMMENT '输出文件 ID 列表',
  text_result MEDIUMTEXT NULL COMMENT '图生文或识图类任务的文本结果',
  gateway_model_code VARCHAR(128) NULL COMMENT 'AI 网关模型编码',
  gateway_capability VARCHAR(64) NULL COMMENT 'AI 网关能力标签',
  gateway_request_id VARCHAR(128) NULL COMMENT 'AI 网关请求 ID，用于成本审计和问题排查',
  quality VARCHAR(64) NULL COMMENT '生成质量档位',
  image_size VARCHAR(64) NULL COMMENT '图片尺寸参数，例如 1024x1024',
  image_count INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '本任务请求生成的图片数量',
  cost_points DECIMAL(18, 6) NULL COMMENT '预计或实际消耗积分，使用 decimal 避免浮点误差',
  billing_event_id VARCHAR(64) NULL COMMENT '关联的计费事件 ID',
  idempotency_key VARCHAR(191) NOT NULL COMMENT '任务创建幂等键，防止重复提交导致重复扣费',
  error_code VARCHAR(128) NULL COMMENT '公开错误码',
  error_message VARCHAR(512) NULL COMMENT '公开中文错误信息，不保存内部密钥或原始堆栈',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_image_tasks_idempotency_key (idempotency_key),
  KEY idx_image_tasks_owner_status_created (owner_user_id, status, created_at),
  KEY idx_image_tasks_owner_created (owner_user_id, created_at),
  KEY idx_image_tasks_task_type_created (task_type, created_at),
  KEY idx_image_tasks_billing_event_id (billing_event_id),
  KEY idx_image_tasks_gateway_request_id (gateway_request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='图片生成、识图、编辑和修复任务';

CREATE TABLE IF NOT EXISTS files (
  id VARCHAR(64) NOT NULL COMMENT '文件 ID，由应用生成',
  owner_user_id BIGINT UNSIGNED NOT NULL COMMENT '文件归属的墨灵平台用户 ID',
  file_type VARCHAR(64) NOT NULL COMMENT '文件类型：input、output、thumbnail、export 等',
  original_name VARCHAR(255) NULL COMMENT '用户上传原始文件名，展示前需要转义',
  mime_type VARCHAR(128) NOT NULL COMMENT '文件 MIME 类型',
  storage_provider VARCHAR(64) NOT NULL DEFAULT 'minio' COMMENT '对象存储提供方，第一阶段为 minio',
  storage_bucket VARCHAR(128) NOT NULL COMMENT '对象存储 bucket',
  storage_key VARCHAR(512) NOT NULL COMMENT '对象存储 key，不保存公开外链',
  size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '文件大小，单位字节',
  width INT UNSIGNED NULL COMMENT '图片宽度',
  height INT UNSIGNED NULL COMMENT '图片高度',
  checksum VARCHAR(128) NULL COMMENT '文件校验值，用于去重和审计',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  PRIMARY KEY (id),
  KEY idx_files_owner_created (owner_user_id, created_at),
  KEY idx_files_storage_key (storage_key),
  KEY idx_files_checksum (checksum),
  KEY idx_files_owner_type_created (owner_user_id, file_type, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='上传图、生成图、缩略图和导出文件元数据';

CREATE TABLE IF NOT EXISTS billing_events (
  id VARCHAR(64) NOT NULL COMMENT '计费事件 ID，由应用生成',
  owner_user_id BIGINT UNSIGNED NOT NULL COMMENT '计费归属的墨灵平台用户 ID',
  task_id VARCHAR(64) NOT NULL COMMENT '关联图片任务 ID',
  event_type VARCHAR(64) NOT NULL COMMENT '计费动作：reserve、settle、release、consume',
  amount_points DECIMAL(18, 6) NOT NULL COMMENT '积分数量，使用 decimal 字符串语义',
  status VARCHAR(64) NOT NULL COMMENT '计费状态：pending、reserved、settled、released、failed、reconcile_pending',
  idempotency_key VARCHAR(191) NOT NULL COMMENT '墨灵计费接口幂等键',
  moling_reserve_id VARCHAR(128) NULL COMMENT '墨灵预占或 hold ID',
  moling_entitlement_id BIGINT UNSIGNED NULL COMMENT '墨灵权益 ID',
  error_code VARCHAR(128) NULL COMMENT '公开错误码',
  error_message VARCHAR(512) NULL COMMENT '公开中文错误信息',
  retry_count INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '对账或重试次数',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_billing_events_idempotency_key (idempotency_key),
  KEY idx_billing_events_task_id (task_id),
  KEY idx_billing_events_owner_status_created (owner_user_id, status, created_at),
  KEY idx_billing_events_status_retry (status, retry_count, updated_at),
  KEY idx_billing_events_owner_created (owner_user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='图片任务积分预占、结算、释放和对账事件';

CREATE TABLE IF NOT EXISTS ai_gateway_call_logs (
  id VARCHAR(64) NOT NULL COMMENT 'AI 网关调用日志 ID，由应用生成',
  task_id VARCHAR(64) NULL COMMENT '关联图片任务 ID',
  request_id VARCHAR(128) NOT NULL COMMENT 'AI 网关请求 ID 或应用生成的调用请求 ID',
  gateway_model_code VARCHAR(128) NOT NULL COMMENT 'AI 网关模型编码',
  gateway_capability VARCHAR(64) NOT NULL COMMENT 'AI 网关能力标签',
  operation VARCHAR(64) NOT NULL COMMENT '业务操作类型',
  latency_ms INT UNSIGNED NULL COMMENT '调用耗时，单位毫秒',
  success TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否调用成功',
  usage_json JSON NULL COMMENT 'AI 网关 usage 原文，仅做成本核算和审计',
  input_summary VARCHAR(1024) NULL COMMENT '输入摘要，禁止写入完整敏感内容',
  output_summary VARCHAR(1024) NULL COMMENT '输出摘要，禁止写入完整敏感内容',
  error_code VARCHAR(128) NULL COMMENT '公开错误码',
  error_message VARCHAR(512) NULL COMMENT '公开中文错误信息',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_ai_gateway_call_logs_request_id (request_id),
  KEY idx_ai_gateway_call_logs_task_id (task_id),
  KEY idx_ai_gateway_call_logs_model_created (gateway_model_code, created_at),
  KEY idx_ai_gateway_call_logs_success_created (success, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI 网关调用日志和成本审计记录';

CREATE TABLE IF NOT EXISTS style_presets (
  id VARCHAR(64) NOT NULL COMMENT '风格模板 ID，由应用生成',
  name VARCHAR(128) NOT NULL COMMENT '风格模板名称',
  task_type VARCHAR(64) NOT NULL COMMENT '适用任务类型',
  prompt_template TEXT NOT NULL COMMENT '模板提示词',
  preview_image_file_id VARCHAR(64) NULL COMMENT '预览图文件 ID',
  enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
  sort_order INT NOT NULL DEFAULT 0 COMMENT '展示排序',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  PRIMARY KEY (id),
  KEY idx_style_presets_task_enabled_sort (task_type, enabled, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='图片创作风格模板';

CREATE TABLE IF NOT EXISTS user_collections (
  id VARCHAR(64) NOT NULL COMMENT '收藏记录 ID，由应用生成',
  owner_user_id BIGINT UNSIGNED NOT NULL COMMENT '收藏归属的墨灵平台用户 ID',
  task_id VARCHAR(64) NULL COMMENT '收藏关联任务 ID',
  file_id VARCHAR(64) NULL COMMENT '收藏关联文件 ID',
  title VARCHAR(255) NULL COMMENT '用户自定义标题',
  tags JSON NULL COMMENT '用户标签列表',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_collections_owner_task_file (owner_user_id, task_id, file_id),
  KEY idx_user_collections_owner_created (owner_user_id, created_at),
  KEY idx_user_collections_task_id (task_id),
  KEY idx_user_collections_file_id (file_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户作品收藏和历史精选';
