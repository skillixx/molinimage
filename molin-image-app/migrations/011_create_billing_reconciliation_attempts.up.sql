CREATE TABLE IF NOT EXISTS billing_reconciliation_attempts (
  id VARCHAR(64) PRIMARY KEY,
  task_id VARCHAR(64) NOT NULL COMMENT '关联图片任务 ID',
  owner_user_id BIGINT NOT NULL COMMENT '任务归属墨灵用户 ID',
  actor_user_id BIGINT NOT NULL COMMENT '执行对账操作的管理员用户 ID',
  action VARCHAR(32) NOT NULL COMMENT '对账动作：retry_settle、retry_release',
  before_task_status VARCHAR(64) NOT NULL COMMENT '对账前任务状态',
  after_task_status VARCHAR(64) NOT NULL COMMENT '对账后任务状态',
  before_error_code VARCHAR(128) NULL COMMENT '对账前任务错误码',
  after_error_code VARCHAR(128) NULL COMMENT '对账后任务错误码',
  billing_event_id VARCHAR(64) NULL COMMENT '本次处理关联的计费事件 ID',
  billing_event_status VARCHAR(64) NULL COMMENT '本次处理后的计费事件状态',
  result VARCHAR(32) NOT NULL COMMENT '处理结果：succeeded、pending、failed',
  error_code VARCHAR(128) NULL COMMENT '本次对账失败错误码',
  error_message TEXT NULL COMMENT '本次对账失败原因',
  request_id VARCHAR(64) NOT NULL COMMENT '接口请求 ID',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_billing_reconciliation_task_created (task_id, created_at),
  KEY idx_billing_reconciliation_result_created (result, created_at),
  KEY idx_billing_reconciliation_actor_created (actor_user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='图片任务计费对账处理记录';
