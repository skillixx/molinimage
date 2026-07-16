ALTER TABLE image_tasks
  ADD COLUMN source_file_id VARCHAR(64) NULL COMMENT '再次编辑使用的原始来源文件 ID' AFTER source_task_id,
  ADD KEY idx_image_tasks_source_file_id (source_file_id);
