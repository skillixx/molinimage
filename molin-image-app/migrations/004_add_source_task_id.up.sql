ALTER TABLE image_tasks
  ADD COLUMN source_task_id VARCHAR(64) NULL COMMENT '再次编辑来源任务 ID' AFTER id,
  ADD KEY idx_image_tasks_source_task_id (source_task_id);
