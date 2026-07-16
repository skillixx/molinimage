-- G04：图片任务事务 Outbox，保证 MySQL 任务提交后即使 API 崩溃也能恢复投递。
CREATE TABLE IF NOT EXISTS image_task_outbox (
  id VARCHAR(64) NOT NULL COMMENT 'Outbox 记录 ID',
  task_id VARCHAR(64) NOT NULL COMMENT '待投递图片任务 ID，队列载荷只使用此字段',
  status VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT 'pending、dispatching、dispatched、failed、cancelled',
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Dispatcher 已领取次数',
  next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '下次允许投递时间',
  last_error_code VARCHAR(128) NULL COMMENT '公开错误码，不保存第三方原始错误',
  last_error_message VARCHAR(512) NULL COMMENT '脱敏中文错误说明',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
  dispatched_at DATETIME(3) NULL COMMENT '成功写入 BullMQ 的时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_image_task_outbox_task_id (task_id),
  KEY idx_image_task_outbox_dispatch (status, next_attempt_at, created_at),
  KEY idx_image_task_outbox_timeout (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='图片任务 BullMQ 事务投递箱';
