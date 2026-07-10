ALTER TABLE image_tasks
  DROP INDEX idx_image_tasks_source_task_id,
  DROP COLUMN source_task_id;
