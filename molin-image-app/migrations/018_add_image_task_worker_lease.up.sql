ALTER TABLE image_tasks
  ADD COLUMN worker_lock_token VARCHAR(64) NULL COMMENT '当前 Worker 执行租约令牌' AFTER error_message,
  ADD COLUMN worker_lock_expires_at DATETIME(3) NULL COMMENT 'Worker 执行租约到期时间' AFTER worker_lock_token,
  ADD COLUMN worker_started_at DATETIME(3) NULL COMMENT '任务首次被 Worker 抢占时间' AFTER worker_lock_expires_at,
  ADD COLUMN worker_attempt_count INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Worker 原子抢占次数' AFTER worker_started_at,
  ADD KEY idx_image_tasks_worker_recovery (status, worker_lock_expires_at);
