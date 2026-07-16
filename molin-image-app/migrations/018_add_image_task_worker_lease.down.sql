ALTER TABLE image_tasks
  DROP INDEX idx_image_tasks_worker_recovery,
  DROP COLUMN worker_attempt_count,
  DROP COLUMN worker_started_at,
  DROP COLUMN worker_lock_expires_at,
  DROP COLUMN worker_lock_token;
